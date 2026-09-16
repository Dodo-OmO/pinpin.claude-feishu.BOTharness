/**
 * 传话口（127.0.0.1:47901）——本机 Claude 窗口 ⇄ 品品。协议文档 docs/relay-protocol.md。
 *
 * 独立于管家口 47900（信任域隔离：这里只开放传话方法）。连接首帧必须 relay.hello 带口令。
 * 条子（submitter / relay 角色递）→ 按路由表投成 chat-trigger，品品用自己的话办完 desktop_note_ack → relay.receipt 回推。
 * 来信（Owner经 desktop_session_message 发）→ 广播给 relay 角色，第一个 taken 算数；2 小时没人取 → 带自诊断事实告诉来源频道。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { IpcServer, type IpcConn } from './ipc-server.js';
import { tokenMatches } from '../src/ipc/bridge-token.js';
import {
  IPC_METHODS,
  RELAY_BRIDGE_PORT,
  type RelayAckParams,
  type RelayHelloParams,
  type RelayLetterCreateParams,
  type RelayLetterCreateResult,
  type RelayLetterPush,
  type RelayReceipt,
  type RelaySubmitParams,
  type RelaySubmitResult,
  type WorkOkResult,
} from '../src/ipc/protocol.js';
import {
  ACK_TIMEOUT_MS,
  LETTER_EXPIRE_MS,
  MAX_PUSH_FAILS,
  RelayQueue,
  inWindow,
  nextWindowStart,
  receiptOf,
  type LetterRecord,
  type NoteRecord,
  type NoteRoute,
  type RelaySeen,
} from './relay-queue.js';

export interface RelayBridgeDeps {
  dataDir: string;
  token: string;
  /** 投 trigger 到频道（离线则拉起等就绪）；投成功返回 true */
  pushTrigger: (chatId: string, body: string, meta: Record<string, string>) => Promise<boolean>;
  /** 可投目标频道（群 + 已登记私聊） */
  listChats: () => Array<{ chat_id: string; name: string }>;
  /** open_id → 人名 */
  humans: () => Record<string, string>;
  /** Owner在各飞书应用下的 open_id */
  ownerOpenIds: () => string[];
  ownerChatId: () => string | undefined;
  /** 传话员掉线超过宽限期时私聊豆姐（supervisor 侧 notifyOwnerDm） */
  notifyOwner: (chatId: string, text: string) => Promise<void>;
}

type ConnState = { client_id: string; role: 'submitter' | 'relay'; session_title: string; session_id?: string };

const TICK_MS = 60_000;
/** 传话员正常工作是「收一条就退再起」，短暂断开是常态——宽限这么久仍没人在线才算掉线 */
const RELAY_OFFLINE_GRACE_MS = 120_000;
/** 掉线告警最短间隔，防刷屏 */
const RELAY_OFFLINE_ALERT_GAP_MS = 2 * 3_600_000;
const ACTIONS = new Set(['dm', 'group', 'group_at', 'tell_pinpin']);

// ── 正文拼装（纯函数，可单测）──

function atMarkup(at: NonNullable<NoteRoute['at']>): string {
  return at
    .map((a) => (a.ids.length === 1 ? `<at user_id="${a.ids[0]}">${a.name}</at>` : `${a.name}（${a.ids.length ? `名单里多个 ID ${a.ids.join(' / ')}，多为同一人在两个飞书应用下的 ID，挑本群那个` : '名单里没查到 ID'}；认不准就别 @，ack 里说明）`))
    .join('、');
}

export function buildNoteBody(n: NoteRecord): string {
  const from = `「${n.from.session_title}」${n.from.project ? `（${n.from.project}）` : ''}`;
  const tail = [
    n.urgency === 'urgent' ? '紧急' : '',
    n.need_reply ? '要回话：对方回复后再调一次 desktop_note_ack 带 reply（原话要点）' : '',
    n.attachments?.length ? `附件（路径原样）：${n.attachments.join('；')}` : '',
  ].filter(Boolean);
  const ack = `办完必调 desktop_note_ack（note_id=${n.id}）：发了 → status=sent + 实际发出的原文；判断不该发 / 要推迟 → skipped / deferred + 原因。`;
  if (n.route.is_reply) {
    return [
      `【本机 Claude 窗口的回话·来信 ${n.reply_to}】来自${from}`,
      `情况：${n.situation}`,
      `请求：${n.request}`,
      ...tail,
      `→ 用你自己的话转告，路径 / 集号 / 数字原样照抄。${ack}`,
    ].join('\n');
  }
  let todo: string;
  switch (n.action) {
    case 'tell_pinpin':
      todo = '告诉你（要不要跟Owner说、怎么说你定）';
      break;
    case 'dm':
      todo = n.route.anytime
        ? '跟Owner说（就在这个私聊里）'
        : `私聊 ${n.target?.person}${n.route.person_ids?.length ? `（名单 ID：${n.route.person_ids.join(' / ')}）` : '（名单里没查到）'}——用 send_private_message 发；拿不准是谁先在这儿问Owner，别猜`;
      break;
    case 'group':
      todo = `在本群「${n.route.chat_name}」说`;
      break;
    default:
      todo = `在本群「${n.route.chat_name}」说，并 @ ${atMarkup(n.route.at ?? [])}`;
  }
  return [
    `【本机 Claude 窗口递的条子·${n.id}】来自${from}——Owner本机的 Claude 助手，不是Owner本人发话。`,
    `要你：${todo}`,
    `情况：${n.situation}`,
    `请求：${n.request}`,
    ...tail,
    `→ 用你自己的话办，路径 / 集号 / 数字 / 名字原样照抄。${ack}`,
  ].join('\n');
}

const fmtTime = (ms?: number): string =>
  ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

export function buildExpiredBody(l: LetterRecord, relayOnline: number, seen: RelaySeen): string {
  const snippet = l.content.length > 60 ? `${l.content.slice(0, 60)}…` : l.content;
  return [
    `【来信 ${l.id} 两小时没人取】${fmtTime(l.created_at)} 托本机 Claude 窗口带给「${l.target}」的话「${snippet}」一直没被取走。`,
    `通道自查：传话口 127.0.0.1:${RELAY_BRIDGE_PORT} 在监听；当前在线传话员 ${relayOnline} 个；` +
      `最近一次传话员连上：${seen.last_hello_at ? `${fmtTime(seen.last_hello_at)}「${seen.last_hello_title ?? ''}」` : '从没连过'}；` +
      `最近一次断开：${seen.last_close_at ? fmtTime(seen.last_close_at) : '无'}。`,
    '→ 先据此判断原因（例：传话员没开过 / 掉线没重连 / 在线却没取 = 那边出错），再告诉Owner原因和建议。',
  ].join('\n');
}

export class RelayBridge {
  readonly server = new IpcServer();
  readonly queue: RelayQueue;
  private conns = new Set<IpcConn>();
  /** note_id → 提交它的连接（receipt 定向推；重连后靠 session_id 匹配） */
  private submitConn = new Map<string, IpcConn>();
  private timer: NodeJS.Timeout | null = null;
  private offlineTimer: NodeJS.Timeout | null = null;
  private lastOfflineAlertAt = 0;
  private delivering = false;
  private redeliverAgain = false;

  constructor(private deps: RelayBridgeDeps) {
    this.queue = new RelayQueue(path.join(deps.dataDir, 'relay-queue.json'));
  }

  // ── 生命周期 ──

  async start(): Promise<void> {
    this.queue.load();
    this.server.setAuthGate(IPC_METHODS.RELAY_HELLO, (p) => tokenMatches((p as RelayHelloParams | undefined)?.token, this.deps.token));
    this.server.setRequestHandler(IPC_METHODS.RELAY_HELLO, async (p, _c, conn) => this.onHello(p as RelayHelloParams, conn));
    this.server.setRequestHandler(IPC_METHODS.RELAY_SUBMIT, async (p, _c, conn) => this.submit(p as RelaySubmitParams, conn));
    this.server.setRequestHandler(IPC_METHODS.RELAY_STATUS, async (p) => this.status((p as { id?: string } | undefined)?.id));
    this.server.setRequestHandler(IPC_METHODS.RELAY_LETTER_ACK, async (p, _c, conn) =>
      this.letterAck(p as { id?: string; result?: string; note?: string }, conn));
    this.server.on('connection-closed', (conn: IpcConn) => {
      this.conns.delete(conn);
      const st = conn.state as ConnState;
      if (st.role === 'relay') {
        this.queue.seen.last_close_at = Date.now();
        this.persist();
        process.stderr.write(`[relay-bridge] bye relay「${st.session_title}」${st.client_id}\n`);
        this.armOfflineAlert();
      }
    });
    await this.server.start({ port: RELAY_BRIDGE_PORT });
    process.stderr.write(`[relay-bridge] listening 127.0.0.1:${RELAY_BRIDGE_PORT}\n`);
    this.timer = setInterval(() => void this.deliverDue(), TICK_MS);
    void this.deliverDue();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.offlineTimer) clearTimeout(this.offlineTimer);
    this.offlineTimer = null;
    await this.server.stop();
    this.conns.clear();
    this.submitConn.clear();
  }

  /** 频道子进程 → supervisor 的两个方法，挂到主 IPC server */
  attachChannelIpc(ipc: IpcServer): void {
    ipc.setRequestHandler(IPC_METHODS.RELAY_ACK, async (p): Promise<WorkOkResult> => this.onAck(p as RelayAckParams));
    ipc.setRequestHandler(IPC_METHODS.RELAY_LETTER_CREATE, async (p, chatId): Promise<RelayLetterCreateResult> =>
      this.createLetter(p as RelayLetterCreateParams, chatId));
  }

  // ── 传话口方法 ──

  /** 传话员全下线 → 宽限后仍没人回来就私聊豆姐（她的信会排队，没人取谁都不知道）。 */
  private armOfflineAlert(): void {
    if (this.offlineTimer) clearTimeout(this.offlineTimer);
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      if (this.relayOnline() > 0) return;
      const now = Date.now();
      if (now - this.lastOfflineAlertAt < RELAY_OFFLINE_ALERT_GAP_MS) return;
      this.lastOfflineAlertAt = now;
      const chatId = this.deps.ownerChatId();
      if (!chatId) return;
      const since = this.queue.seen.last_close_at ? new Date(this.queue.seen.last_close_at).toLocaleTimeString() : "刚刚";
      const pending = this.queue.letters().filter((l) => l.status === "pending").length;
      void this.deps.notifyOwner(
        chatId,
        `⚠️ 传话员掉线了——${since} 起没人取信，现在排着 ${pending} 封。托它转的话会一直排队，直到有人把它拉起来。`,
      );
    }, RELAY_OFFLINE_GRACE_MS);
  }

  private relayOnline(): number {
    let n = 0;
    for (const c of this.conns) if ((c.state as ConnState).role === 'relay') n++;
    return n;
  }

  private onHello(p: RelayHelloParams, conn: IpcConn): { ok: true; client_id: string } {
    const state: ConnState = {
      client_id: `rc-${crypto.randomBytes(3).toString('hex')}`,
      role: p.role === 'relay' ? 'relay' : 'submitter',
      session_title: String(p.session_title ?? '').slice(0, 100) || '未命名窗口',
      ...(p.session_id ? { session_id: String(p.session_id) } : {}),
    };
    conn.state = state;
    this.conns.add(conn);
    process.stderr.write(`[relay-bridge] hello ${state.role}「${state.session_title}」${state.client_id}\n`);
    if (state.role === 'relay') {
      if (this.offlineTimer) { clearTimeout(this.offlineTimer); this.offlineTimer = null; }
      this.queue.seen.last_hello_at = Date.now();
      this.queue.seen.last_hello_title = state.session_title;
      this.persist();
      // 响应帧先写出，再补推未取走的来信
      setImmediate(() => {
        for (const l of this.queue.letters()) if (l.status === 'pending') this.server.notify(conn, IPC_METHODS.RELAY_LETTER, this.letterPush(l));
      });
    }
    return { ok: true, client_id: state.client_id };
  }

  submit(p: RelaySubmitParams, conn?: IpcConn): RelaySubmitResult {
    const id = typeof p?.id === 'string' ? p.id.trim() : '';
    if (!id || id.length > 128) return { ok: false, error: 'invalid_params', message: 'id 必填（≤128 字符）' };
    const existing = this.queue.getNote(id);
    if (existing) return this.submitOk(existing);
    const st = conn?.state as ConnState | undefined;
    const from = {
      session_title: String(p.from?.session_title ?? st?.session_title ?? '未命名窗口').slice(0, 100),
      ...(p.from?.session_id ?? st?.session_id ? { session_id: String(p.from?.session_id ?? st?.session_id) } : {}),
      ...(p.from?.project ? { project: String(p.from.project) } : {}),
    };
    const situation = String(p.situation ?? '');
    const request = String(p.request ?? '');
    if (!situation.trim() && !request.trim()) return { ok: false, id, error: 'invalid_params', message: 'situation / request 至少填一个' };
    const owner = this.deps.ownerChatId();

    let route: NoteRoute;
    let action = p.action;
    if (p.reply_to) {
      const letter = this.queue.getLetter(p.reply_to);
      if (!letter) return { ok: false, id, error: 'letter_not_found' };
      route = { chat_id: letter.from_chat_id, anytime: letter.from_chat_id === owner, is_reply: true };
      if (letter.status !== 'expired') {
        letter.status = 'replied';
        letter.updated_at = Date.now();
      }
      action = 'tell_pinpin';
    } else {
      if (!ACTIONS.has(action)) return { ok: false, id, error: 'invalid_params', message: 'action 取 dm / group / group_at / tell_pinpin' };
      if (action === 'tell_pinpin' || action === 'dm') {
        if (!owner) return { ok: false, id, error: 'no_owner_chat', message: '品品未配置Owner私聊频道' };
        if (action === 'tell_pinpin') {
          route = { chat_id: owner, anytime: true };
        } else {
          const person = String(p.target?.person ?? '').trim();
          if (!person) return { ok: false, id, error: 'invalid_params', message: 'dm 需要 target.person' };
          const r = this.resolvePerson(person);
          route = { chat_id: owner, anytime: r.isOwner, person_ids: r.ids };
        }
      } else {
        const chatQ = String(p.target?.chat ?? '').trim();
        if (!chatQ) return { ok: false, id, error: 'invalid_params', message: `${action} 需要 target.chat` };
        const found = this.findChat(chatQ);
        if ('error' in found) return { ok: false, id, error: found.error, candidates: found.candidates };
        route = { chat_id: found.chat_id, anytime: false, chat_name: found.name };
        if (action === 'group_at') {
          const at = (Array.isArray(p.target?.at) ? p.target.at : []).map((s) => String(s).trim()).filter(Boolean);
          if (!at.length) return { ok: false, id, error: 'invalid_params', message: 'group_at 需要 target.at' };
          route.at = at.map((q) => {
            const r = this.resolvePerson(q);
            return { name: r.name, ids: r.ids };
          });
        }
      }
    }

    const rec = this.queue.addNote(
      {
        id,
        from,
        action,
        ...(p.target ? { target: p.target } : {}),
        situation,
        request,
        urgency: p.urgency === 'urgent' ? 'urgent' : 'normal',
        need_reply: !!p.need_reply,
        ...(p.reply_to ? { reply_to: p.reply_to } : {}),
        attachments: Array.isArray(p.attachments) ? p.attachments.map(String) : [],
      },
      route,
      new Date(),
    );
    if (conn) this.submitConn.set(id, conn);
    this.persist();
    process.stderr.write(`[relay-bridge] 收条子 ${id} ${rec.action}${rec.reply_to ? `(回 ${rec.reply_to})` : ''} → ${route.chat_id.slice(-8)} ${rec.status}\n`);
    void this.deliverDue();
    return this.submitOk(rec);
  }

  private submitOk(n: NoteRecord): RelaySubmitResult {
    return {
      ok: true,
      id: n.id,
      status: n.status,
      ...(n.deliver_after ? { deliver_after: new Date(n.deliver_after).toISOString() } : {}),
    };
  }

  status(id?: string): RelayReceipt {
    if (!id) return { id: '', status: 'not_found' };
    const n = this.queue.getNote(id);
    if (n) return receiptOf(n);
    const l = this.queue.getLetter(id);
    if (l) return { id, status: l.status, updated_at: new Date(l.updated_at).toISOString() };
    return { id, status: 'not_found' };
  }

  private letterAck(p: { id?: string; result?: string; note?: string }, conn: IpcConn): { ok: boolean; error?: string } {
    const st = conn.state as ConnState;
    if (st.role !== 'relay') return { ok: false, error: 'relay_role_required' };
    const l = p?.id ? this.queue.getLetter(p.id) : undefined;
    if (!l) return { ok: false, error: 'letter_not_found' };
    if (l.status !== 'pending') return { ok: false, error: `letter_${l.status}` };
    if (p.result !== 'taken' && p.result !== 'target_not_found') return { ok: false, error: 'invalid_params' };
    l.status = p.result === 'taken' ? 'taken' : 'replied';
    l.taken_by = st.session_title;
    l.updated_at = Date.now();
    for (const c of this.conns) {
      if (c !== conn && (c.state as ConnState).role === 'relay') this.server.notify(c, IPC_METHODS.RELAY_LETTER_TAKEN, { id: l.id });
    }
    if (p.result === 'target_not_found') {
      // 走条子同一套投递 + ack，品品转告Owner"没找到"
      this.submit(
        {
          id: `${l.id}-nf`,
          from: { session_title: st.session_title, ...(st.session_id ? { session_id: st.session_id } : {}) },
          action: 'tell_pinpin',
          situation: `传话员没找到「${l.target}」这个窗口。${p.note ? `它的说明：${p.note}` : ''}`,
          request: '告诉Owner这封来信没送到，以及现在有哪些窗口（如果说明里列了）。',
          reply_to: l.id,
        },
        conn,
      );
    } else {
      this.persist();
    }
    process.stderr.write(`[relay-bridge] 来信 ${l.id} ${p.result} by「${st.session_title}」\n`);
    return { ok: true };
  }

  // ── 频道子进程方法 ──

  private onAck(p: RelayAckParams): WorkOkResult {
    if (!p?.note_id || !['sent', 'deferred', 'skipped', 'failed'].includes(p.status)) return { ok: false, error: 'note_id / status 不合法' };
    const n = this.queue.ack(p, Date.now());
    if (!n) return { ok: false, error: `没有条子 ${p.note_id}` };
    this.persist();
    this.pushReceipt(n);
    process.stderr.write(`[relay-bridge] ack ${n.id} ${n.status}${p.reply ? ' +reply' : ''}\n`);
    return { ok: true };
  }

  private createLetter(p: RelayLetterCreateParams, chatId: string): RelayLetterCreateResult {
    const target = String(p?.target ?? '').trim();
    const content = String(p?.content ?? '').trim();
    if (!target || !content) return { ok: false, error: 'target / content 必填' };
    if (!chatId) return { ok: false, error: '未识别来源频道' };
    const now = Date.now();
    const l = this.queue.addLetter({
      id: `L-${now.toString(36)}${crypto.randomBytes(2).toString('hex')}`,
      created_at: now,
      from_chat_id: chatId,
      requester: 'Owner',
      target,
      content,
      need_reply: !!p.need_reply,
    });
    this.persist();
    const relays = [...this.conns].filter((c) => (c.state as ConnState).role === 'relay');
    for (const c of relays) this.server.notify(c, IPC_METHODS.RELAY_LETTER, this.letterPush(l));
    process.stderr.write(`[relay-bridge] 来信 ${l.id} →「${target}」在线传话员 ${relays.length}\n`);
    return { ok: true, id: l.id, relay_online: relays.length };
  }

  // ── 投递循环 ──

  /** 入队 / 频道就绪 / 每分钟触发；串行执行，运行中再被叫就结束后补跑一轮 */
  async deliverDue(): Promise<void> {
    if (this.delivering) {
      this.redeliverAgain = true;
      return;
    }
    this.delivering = true;
    try {
      do {
        this.redeliverAgain = false;
        await this.deliverOnce();
      } while (this.redeliverAgain);
    } catch (e) {
      process.stderr.write(`[relay-bridge] 投递循环异常: ${e instanceof Error ? e.message : e}\n`);
    } finally {
      this.delivering = false;
    }
  }

  private async deliverOnce(): Promise<void> {
    const notes = this.queue.notes().sort((a, b) => a.submitted_at - b.submitted_at);
    for (const n of notes) {
      const now = new Date();
      const pending = n.status === 'queued' || n.status === 'scheduled';
      const ackOverdue = n.status === 'delivered' && now.getTime() - (n.delivered_at ?? 0) > ACK_TIMEOUT_MS;
      if (!pending && !ackOverdue) continue;
      if (ackOverdue && n.attempts >= 2) {
        this.settle(n, 'no_ack', '投出两次都没收到品品回执');
        continue;
      }
      if (!n.route.anytime && !inWindow(now)) {
        if (n.status === 'queued') {
          n.status = 'scheduled';
          n.deliver_after = nextWindowStart(now).getTime();
          n.updated_at = now.getTime();
          this.persist();
          this.pushReceipt(n);
        }
        continue;
      }
      const trigger = n.route.is_reply ? 'desktop-reply' : 'desktop-note';
      const ok = await this.deps.pushTrigger(n.route.chat_id, buildNoteBody(n), {
        user: `Desktop·${n.from.session_title}`,
        sender_type: 'system',
        message_id: `relay-${n.id}-${n.attempts + 1}`,
        trigger,
        note_id: n.id,
      });
      if (ok) {
        n.status = 'delivered';
        n.delivered_at = Date.now();
        n.attempts += 1;
        n.push_fails = 0;
        delete n.deliver_after;
        n.updated_at = n.delivered_at;
        this.persist();
        this.pushReceipt(n);
        process.stderr.write(`[relay-bridge] 投出 ${n.id} → ${n.route.chat_id.slice(-8)} 第 ${n.attempts} 次\n`);
      } else if (++n.push_fails >= MAX_PUSH_FAILS) {
        this.settle(n, 'failed', '目标频道一直拉不起来');
      } else {
        this.persist();
        process.stderr.write(`[relay-bridge] 投递 ${n.id} 失败（目标频道未就绪）第 ${n.push_fails} 次，稍后重试\n`);
      }
    }

    for (const l of this.queue.letters()) {
      if (l.status !== 'pending' || Date.now() - l.created_at < LETTER_EXPIRE_MS) continue;
      const online = [...this.conns].filter((c) => (c.state as ConnState).role === 'relay').length;
      const ok = await this.deps.pushTrigger(l.from_chat_id, buildExpiredBody(l, online, this.queue.seen), {
        user: '传话口',
        sender_type: 'system',
        message_id: `relay-${l.id}-expired`,
        trigger: 'desktop-letter-expired',
        note_id: l.id,
      });
      if (!ok) continue; // 下轮再告诉
      l.status = 'expired';
      l.updated_at = Date.now();
      this.persist();
      for (const c of this.conns) if ((c.state as ConnState).role === 'relay') this.server.notify(c, IPC_METHODS.RELAY_LETTER_TAKEN, { id: l.id });
      process.stderr.write(`[relay-bridge] 来信 ${l.id} 过期，已告知来源频道\n`);
    }

    if (this.queue.prune(Date.now())) this.persist();
  }

  private settle(n: NoteRecord, status: 'no_ack' | 'failed', reason: string): void {
    n.status = status;
    n.reason = reason;
    n.updated_at = Date.now();
    this.persist();
    this.pushReceipt(n);
    process.stderr.write(`[relay-bridge] 条子 ${n.id} ${status}：${reason}\n`);
  }

  // ── 工具 ──

  private pushReceipt(n: NoteRecord): void {
    const receipt = receiptOf(n);
    const sid = n.from.session_id;
    const origin = this.submitConn.get(n.id);
    for (const c of this.conns) {
      const st = c.state as ConnState;
      if (st.role === 'relay' || c === origin || (sid && st.session_id === sid)) this.server.notify(c, IPC_METHODS.RELAY_RECEIPT, receipt);
    }
  }

  private letterPush(l: LetterRecord): RelayLetterPush {
    return {
      id: l.id,
      time: new Date(l.created_at).toISOString(),
      from: { chat_id: l.from_chat_id, requester: l.requester },
      target: l.target,
      content: l.content,
      need_reply: l.need_reply,
      reply_chat_id: l.from_chat_id,
    };
  }

  private persist(): void {
    try {
      this.queue.save();
    } catch (e) {
      process.stderr.write(`[relay-bridge] 队列落盘失败: ${e instanceof Error ? e.message : e}\n`);
    }
  }

  /** 名字或 ou_ → 名单里的 open_id（重名全列）+ 是否Owner本人 */
  resolvePerson(q: string): { name: string; ids: string[]; isOwner: boolean } {
    const humans = this.deps.humans();
    const owners = this.deps.ownerOpenIds();
    const ids = q.startsWith('ou_') ? [q] : Object.entries(humans).filter(([, n]) => n === q).map(([id]) => id);
    const name = q.startsWith('ou_') ? (humans[q] ?? q) : q;
    const ownerNames = new Set(['Owner', ...owners.map((id) => humans[id]).filter(Boolean)]);
    return { name, ids, isOwner: ids.some((id) => owners.includes(id)) || ownerNames.has(name) };
  }

  /** oc_ 或群名（精确优先、再包含） → 唯一频道 */
  findChat(q: string): { chat_id: string; name: string } | { error: 'chat_not_found' | 'chat_ambiguous'; candidates: string[] } {
    const seen = new Set<string>();
    const list = this.deps.listChats().filter((c) => !seen.has(c.chat_id) && seen.add(c.chat_id));
    if (q.startsWith('oc_')) {
      const hit = list.find((c) => c.chat_id === q);
      return hit ?? { error: 'chat_not_found', candidates: list.map((c) => c.name).slice(0, 40) };
    }
    const norm = (s: string): string => s.trim().toLowerCase();
    const exact = list.filter((c) => norm(c.name) === norm(q));
    const hits = exact.length ? exact : list.filter((c) => norm(c.name).includes(norm(q)));
    if (hits.length === 1) return hits[0];
    return hits.length
      ? { error: 'chat_ambiguous', candidates: hits.map((c) => c.name) }
      : { error: 'chat_not_found', candidates: list.map((c) => c.name).slice(0, 40) };
  }
}
