/**
 * 飞书 Poll 集中调度 —— supervisor 单点拉所有 chat 的新消息，按 chat_id 分发到对应频道 CLI。
 *
 * 跟 早期版本 / src/mcp/notifications/chat-message.ts 一致的核心算法（去重 + 翻页 + cursor），
 * 但搬到 supervisor 进程内，避免多 stdio MCP server 进程各自 poll 撞限速。
 *
 * 步骤 2：分发逻辑暂仅 log（"收到 from chat_id=X sender=Y msg=Z"）；步骤 3 接 IPC push 给子进程。
 * chat.list 5min 重拉 → 发现新群自动通知 supervisor.spawnChannelCli（步骤 3 实装）。
 */

import { getFeishuClient } from './feishu-client.js';

const POLL_INTERVAL_MS = Number(process.env.PINPIN_POLL_INTERVAL_MS ?? 8000);
const CHAT_LIST_REFRESH_MS = Number(process.env.PINPIN_CHAT_LIST_REFRESH_MS ?? 5 * 60 * 1000);
const MAX_PAGES_PER_CHAT = 50;

export interface FeishuInboundMessage {
  chat_id: string;
  message_id: string;
  msg_type: string;
  sender_open_id: string;
  sender_type: 'user' | 'app';
  text?: string;
  create_time_ms: number;
  raw: unknown;
}

export interface ChatListDiff {
  added: Array<{ chat_id: string; name?: string }>;
  removed: Array<{ chat_id: string; name?: string }>;
}

export interface FeishuPollCallbacks {
  /** 每次收到新消息时调用（步骤 3 起接成 IPC push） */
  onMessage?: (msg: FeishuInboundMessage) => void | Promise<void>;
  /** chat.list 5min 重拉发现的差异 */
  onChatListDiff?: (diff: ChatListDiff) => void | Promise<void>;
}

export class FeishuPoll {
  private chats = new Map<string, { name?: string }>();
  private lastCreateTimeMs = new Map<string, number>();
  private processedIds = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private chatListTimer: NodeJS.Timeout | null = null;
  private readonly startupMs = Date.now();
  private callbacks: FeishuPollCallbacks;
  private running = false;
  private botAppId: string;

  constructor(botAppId: string, callbacks: FeishuPollCallbacks = {}) {
    this.botAppId = botAppId;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.refreshChatList(true);
    this.pollTimer = setInterval(() => void this.pollAll(), POLL_INTERVAL_MS);
    this.chatListTimer = setInterval(() => void this.refreshChatList(false), CHAT_LIST_REFRESH_MS);
    process.stderr.write(
      `[feishu-poll] started, poll=${POLL_INTERVAL_MS / 1000}s, chat_list_refresh=${CHAT_LIST_REFRESH_MS / 1000}s\n`,
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.chatListTimer) clearInterval(this.chatListTimer);
    this.pollTimer = null;
    this.chatListTimer = null;
    process.stderr.write('[feishu-poll] stopped\n');
  }

  getChats(): Array<{ chat_id: string; name?: string }> {
    return [...this.chats.entries()].map(([chat_id, info]) => ({ chat_id, name: info.name }));
  }

  private async refreshChatList(isInitial: boolean): Promise<void> {
    // has_more 翻页（消化 step 2 code-review Optional：100 群封顶，群多了会漏新群发现）
    const items: Array<{ chat_id?: string; name?: string }> = [];
    let pageToken: string | undefined;
    const MAX_PAGES = 20; // 100×20 = 2000 群上限；Owner几十群足够
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await getFeishuClient().im.v1.chat.list({
          params: {
            page_size: 100,
            sort_type: 'ByCreateTimeAsc',
            page_token: pageToken,
          },
        });
        items.push(...((res.data?.items ?? []) as Array<{ chat_id?: string; name?: string }>));
        if (!res.data?.has_more || !res.data?.page_token) break;
        pageToken = res.data.page_token;
      }
    } catch (e) {
      process.stderr.write(
        `[feishu-poll] chat.list 拉取失败: ${e instanceof Error ? e.message : e}\n`,
      );
      return;
    }

    const incoming = new Map<string, { name?: string }>();
    for (const c of items) {
      if (c.chat_id) incoming.set(c.chat_id, { name: c.name });
    }

    if (isInitial) {
      this.chats = incoming;
      process.stderr.write(
        `[feishu-poll] chat.list 初始化拉到 ${incoming.size} 个 chat: ${[...incoming.values()]
          .map((c) => c.name ?? '(no-name)')
          .slice(0, 5)
          .join(' / ')}${incoming.size > 5 ? ' …' : ''}\n`,
      );
      return;
    }

    // diff
    const added: ChatListDiff['added'] = [];
    const removed: ChatListDiff['removed'] = [];
    for (const [id, info] of incoming) {
      if (!this.chats.has(id)) added.push({ chat_id: id, name: info.name });
    }
    for (const [id, info] of this.chats) {
      if (!incoming.has(id)) removed.push({ chat_id: id, name: info.name });
    }
    this.chats = incoming;

    if (added.length === 0 && removed.length === 0) return; // 无变化静默，不刷日志
    process.stderr.write(
      `[feishu-poll] chat.list 重拉 diff: +${added.length} -${removed.length}\n`,
    );
    if (this.callbacks.onChatListDiff) {
      try {
        await this.callbacks.onChatListDiff({ added, removed });
      } catch (e) {
        process.stderr.write(
          `[feishu-poll] onChatListDiff callback threw: ${e instanceof Error ? e.message : e}\n`,
        );
      }
    }
  }

  private async pollAll(): Promise<void> {
    if (!this.running) return;
    for (const chatId of this.chats.keys()) {
      try {
        await this.pollChat(chatId);
      } catch (e) {
        process.stderr.write(
          `[feishu-poll] pollChat(${chatId}) 异常: ${e instanceof Error ? e.message : e}\n`,
        );
      }
    }
    // processedIds 上限
    if (this.processedIds.size > 5000) {
      const arr = [...this.processedIds];
      for (let i = 0; i < arr.length - 5000; i++) this.processedIds.delete(arr[i]);
    }
  }

  private async pollChat(chatId: string): Promise<void> {
    const client = getFeishuClient();
    const cursorMs = this.lastCreateTimeMs.get(chatId) ?? this.startupMs;
    const startTimeSec = Math.floor(cursorMs / 1000);

    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_CHAT; page++) {
      const res = await client.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          start_time: String(startTimeSec),
          end_time: String(Math.floor(Date.now() / 1000)),
          sort_type: 'ByCreateTimeAsc',
          page_size: 50,
          page_token: pageToken,
        },
      });
      const items = res.data?.items ?? [];
      for (const raw of items) {
        await this.processMessage(chatId, raw);
      }
      if (!res.data?.has_more || !res.data?.page_token) break;
      pageToken = res.data.page_token;
    }
  }

  private async processMessage(chatId: string, raw: unknown): Promise<void> {
    type Msg = {
      message_id: string;
      msg_type: string;
      create_time: string;
      sender: { id: string; id_type: string; sender_type: string };
      body: { content: string };
      // poll API 返回项含 mentions（@ 占位符↔真名映射）；透传 raw 后给 chat-message resolveMentions 用
      mentions?: Array<{ key: string; name: string; id?: unknown; tenant_key?: string }>;
      deleted?: boolean;
    };
    const m = raw as Msg;
    if (!m || !m.message_id || !m.sender) return;
    if (this.processedIds.has(m.message_id)) return;
    if (m.deleted) return;
    if (m.msg_type === 'system') return;
    // 防自环：bot 自己发的消息（app 类型 + sender.id 是本 bot 的 app_id）
    if (m.sender.sender_type === 'app' && m.sender.id === this.botAppId) return;

    this.processedIds.add(m.message_id);
    const ct = Number(m.create_time);
    if (Number.isFinite(ct) && ct > (this.lastCreateTimeMs.get(chatId) ?? 0)) {
      this.lastCreateTimeMs.set(chatId, ct);
    }

    // text 抽取（其它 msg_type 留 raw 给后续步骤）
    let text: string | undefined;
    if (m.msg_type === 'text') {
      try {
        text = (JSON.parse(m.body?.content ?? '{}') as { text?: string }).text;
      } catch {
        text = undefined;
      }
    }

    const inbound: FeishuInboundMessage = {
      chat_id: chatId,
      message_id: m.message_id,
      msg_type: m.msg_type,
      sender_open_id: m.sender.id,
      sender_type: m.sender.sender_type === 'app' ? 'app' : 'user',
      text,
      create_time_ms: Number.isFinite(ct) ? ct : Date.now(),
      raw: m,
    };

    if (this.callbacks.onMessage) {
      try {
        await this.callbacks.onMessage(inbound);
      } catch (e) {
        process.stderr.write(
          `[feishu-poll] onMessage callback threw: ${e instanceof Error ? e.message : e}\n`,
        );
      }
    } else {
      // 步骤 2 缺省：仅 log 收到的消息
      const summary = text ? text.slice(0, 60) : `(${m.msg_type})`;
      process.stderr.write(
        `[feishu-poll] inbound chat=${chatId} sender=${m.sender.id.slice(0, 8)}… msg=${summary}\n`,
      );
    }
  }
}
