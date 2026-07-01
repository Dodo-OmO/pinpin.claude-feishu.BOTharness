/**
 * Supervisor —— Electron main process 内嵌的核心控制器。
 *
 * 多 CLI 频道隔离架构核心，集中负责：
 *   1. 飞书 poll 单点（FeishuPoll）—— 所有 chat 由本进程拉消息 + 按 chat_id 分发到对应频道 CLI
 *   2. chat.list 5min 轮询 —— 发现新群自动 spawn 频道 CLI
 *   3. cron 仍在子 MCP server 进程跑（同名 cron 靠 scheduled_tasks last_run_at 去重）
 *   4. （方案A：supervisor 不碰 DB——投票记票等 DB 操作 IPC 路由到有 DB 的频道子进程执行）
 *   5. IPC server 监听本机 TCP，子 stdio MCP server 进程通过 PINPIN_SUPERVISOR_PORT 连过来
 *   6. 频道 CLI 生命周期（ChannelCli pool；start/stop/restart/compact）
 *   7. work session（step 4 接 pinpin-spawn-work-session tool）
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { initFeishuClient, getFeishuClient } from './feishu-client.js';
import { FeishuPoll, type ChatListDiff, type FeishuInboundMessage } from './feishu-poll.js';
import { FeishuEventSubscriber, type PollActionValue } from './feishu-event-subscriber.js';
import type { CardActionEvent, ReactionEvent, BotAddedEvent, CommentEvent } from '@larksuiteoapi/node-sdk';
import { buildPollCard } from '../src/mcp/feishu/cards/diy-card.js';
import { feishuEmojiTypeToUnicode } from '../src/mcp/utils/feishu-emoji-map.js';
import { resolveSenderNameSync } from './sender-resolver.js';
import { initNameMapStore, seedNameMapIfAbsent, getAllMappings, setNameMapping } from '../src/shared/name-map-store.js';
import { parseEnvMap } from '../src/shared/sender-shared.js';
import { IpcServer } from './ipc-server.js';
import { ChannelCli } from './channel-cli.js';
import { ChannelConfigStore, DEFAULT_AUTOCOMPACT_PCT } from './channel-config-store.js';
import { WorkSession, type WorkSessionStopInfo } from './work-session.js';
import { CcusagePoller, type QuotaSnapshot } from './ccusage-poller.js';
import { SupervisorCronRunner } from './cron-runner.js';
import { createWardenBridge } from './warden-bridge.js';
import {
  IPC_METHODS,
  type WorkSpawnParams,
  type WorkSpawnResult,
  type WorkSendParams,
  type WorkEndParams,
  type WorkOkResult,
  type WorkPeekParams,
  type WorkPeekResult,
  type StatuslineUpdateParams,
  type RateLimits,
  type WardenSystemInfo,
  type WardenLogEntry,
  type CompactViaPtyParams,
  type SpawnChannelParams,
  type StopChannelParams,
  type FeishuInboundMessagePayload,
  type PollVoteParams,
  type PollVoteResult,
  type NameMappings,
  type PendingNameEntry,
  type SetNameMappingParams,
} from '../src/ipc/protocol.js';

/** P1.3: per-CLI 上下文用量（从 statusLine sink 收，事件驱动） */
export interface ChannelUsageInfo {
  /** 上下文 window 已用百分比 (0-100) */
  context_pct: number | null;
  /** 当前上下文 input tokens */
  context_tokens: number | null;
  /** window 最大尺寸 */
  context_window_size: number | null;
  /** session 累计花费 USD */
  cost_usd: number | null;
  /** 最近一次 sink 更新时间 */
  updated_at: number;
}

export interface SupervisorOptions {
  /** 代码包根目录（含 data.db / .env） */
  appRoot: string;
  /** 用户级可写数据目录（Electron app.getPath('userData')），落 channel-config.json 等 runtime 配置 */
  dataDir: string;
  /** vault cwd（频道 CLI spawn 时锁的目录） */
  vaultCwd: string;
  /** 飞书 app credentials */
  feishuAppId: string;
  feishuAppSecret: string;
  /** 频道 CLI 默认 model + effort（任务 MD §决策 B 原定 medium，Owner 2026-05-28 实测后改 high） */
  defaultModel?: string;
  defaultEffort?: string;
  /** 频道 CLI 默认自动压缩阈值（上下文用量百分比）。新群 spawn 时 fallback。 */
  defaultAutoCompactPct?: number;
  /** 频道 CLI 默认 fast 模式。新群 spawn 时 fallback（per-channel 未配时用）。 */
  defaultFast?: boolean;
}


export class Supervisor extends EventEmitter {
  readonly opts: Required<SupervisorOptions>;
  private feishuPoll: FeishuPoll | null = null;
  /** P4.Q3: 事件订阅长连接（接 user 消息含 P2P 单聊；跟 poll 双轨并存） */
  private feishuEventSubscriber: FeishuEventSubscriber | null = null;
  /** P4.Q3: supervisor 入口 message_id 去重（防 WSClient + poll 双源重复推） */
  private supervisorProcessedIds = new Set<string>();
  private ipcServer: IpcServer;
  /** 管家桥接 server（固定端口，供独立管家进程远程看/控 CLI；旁路，失败不影响品品主功能） */
  private wardenBridge: IpcServer | null = null;
  private ccusagePoller: CcusagePoller;
  private channelConfigStore: ChannelConfigStore;
  private cronRunner: SupervisorCronRunner;
  /** YYYY-MM-DD → 当日入站消息数（修内审 Optional #8 E7 本日消息统计） */
  private dailyMessageCount = new Map<string, number>();
  /** chat_id → ChannelCli */
  private channels = new Map<string, ChannelCli>();
  /** D1: chat_id → 崩溃熔断计数（实例级，不随 spawnChannelCli 重建闭包清零；stopChannel 才删）。
   *  原为 spawnChannelCli 闭包局部 var，stop→respawn 会重建闭包跳过熔断；提到实例级使熔断跨 respawn 持续。 */
  private crashState = new Map<
    string,
    { count: number; windowStart: number; slowRecoveryActive?: boolean; recoveryCount?: number }
  >();
  /** D3: chat_id → IPC 断线自愈 grace 定时器。断线后等窗口；MCP 自身重连(client-hello)取消之，
   *  否则判定 CLI 僵尸（PTY 活但 MCP/IPC 死）→ 杀掉重生。 */
  private graceTimers = new Map<string, NodeJS.Timeout>();
  /** D2: chat_id → CLI 未就绪时缓冲的入站消息（带入队时间戳）。CLI ready（client-hello）后 flush 投递。
   *  每 chat 上限 50 条（超丢最旧）、flush 时丢弃入队 > 10min 的过期消息。stopChannel 时清。 */
  private pendingInbound = new Map<string, Array<{ msg: FeishuInboundMessagePayload; enqueuedAt: number }>>();
  /** P1.3: chat_id → 最新 statusLine 推过来的上下文用量 */
  private channelUsage = new Map<string, ChannelUsageInfo>();
  /** P1.3: ccusage quota 最近一次手动获取 snapshot（删 5min poll 后改按需触发） */
  private lastQuotaSnapshot: QuotaSnapshot | null = null;
  /** 账号级额度（5h+7天，来自任一 CLI statusLine 的 rate_limits）；逐窗口存最新已知值，无数据为 null */
  private lastRateLimits: RateLimits | null = null;
  /** 仪表盘日志流 ring buffer（main.ts pushLog 灌入，warden.recent-logs 读）；上限 300 条 */
  private recentLogs: WardenLogEntry[] = [];
  /** session_id → WorkSession（诉求 B 传话筒） */
  private workSessions = new Map<string, WorkSession>();
  /** work session 独立默认 model/effort（启动时从 channel-config.json __work_defaults__ load；null = fallback 频道默认） */
  private workDefaultModel: string | null = null;
  private workDefaultEffort: string | null = null;
  /** work session 默认 fast（启动时从 __work_defaults__ load；null = 不开） */
  private workDefaultFast: boolean | null = null;
  private started = false;
  private dbPath: string;
  /** name-mappings.json 绝对路径（supervisor 唯一写者；透传给子 CLI env 让两进程读同一文件）。 */
  private nameMapPath: string;
  /** 待命名追踪：解析后仍是纯 ID 兜底（没友好名）的 sender，记一笔供启动器"待命名"面板拉。
   *  key = open_id/cli_id；已在映射里的不记。SET_NAME_MAPPING 成功后 delete 对应 key。 */
  private pendingNames = new Map<
    string,
    { id: string; chat_id: string; snippet: string; type: 'human' | 'bot'; ts: number }
  >();
  /** message_id → {chat_id, 发送者} 有界缓存（reaction 事件不带 chat_id 也不带"被点消息是谁发的"，
   *  靠它+API 反查：既路由到对应频道，又判断被点的是不是品品自己发的（决定文案口径）。
   *  onFeishuMessage 每条入站记一笔；>2000 删最老。品品自己发的消息不入站 → 反查走 API 兜底。 */
  private msgIdToInfo = new Map<string, { chatId: string; senderId: string; senderType: 'user' | 'app'; snippet: string }>();
  /** resolveReactedMsg 的 in-flight 去重（防同一 message_id 并发重复打 message.get） */
  private msgInfoResolveInflight = new Map<string, Promise<{ chatId: string; senderId: string; senderType: 'user' | 'app'; snippet: string } | null>>();

  constructor(opts: SupervisorOptions) {
    super();
    this.opts = {
      // 阶段 4 启动脚本同款写法（空格分隔，方括号小写）
      defaultModel: 'claude-opus-4-8 [1m]',
      defaultEffort: 'high',
      defaultAutoCompactPct: DEFAULT_AUTOCOMPACT_PCT,
      defaultFast: false,
      ...opts,
    };
    this.ipcServer = new IpcServer();
    this.ccusagePoller = new CcusagePoller();
    this.ccusagePoller.on('snapshot', (snap: QuotaSnapshot) => {
      // 额度百分比/重置时刻来自 statusLine（ccusage 只供 token 数），合进 snapshot 一起推启动器
      snap.rate_limits = this.lastRateLimits;
      this.lastQuotaSnapshot = snap;
      this.emit('quota', snap);
    });
    this.channelConfigStore = new ChannelConfigStore(this.opts.dataDir);
    this.dbPath = path.join(this.opts.appRoot, 'data.db');
    // name-mappings.json 跟 channel-config.json 同源（dataDir = userData），两进程读、supervisor 写
    this.nameMapPath = path.join(this.opts.dataDir, 'name-mappings.json');
    this.cronRunner = new SupervisorCronRunner(this);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // ── 0. 频道配置 store load (per-channel model/effort 持久化，P1.2 + P2.2 全局默认) ──
    this.channelConfigStore.load();
    // P2.2: 用 persisted 全局默认覆盖 constructor 默认（如果有）
    const persistedDefaults = this.channelConfigStore.getDefaults();
    if (persistedDefaults?.model) this.opts.defaultModel = persistedDefaults.model;
    if (persistedDefaults?.effort) this.opts.defaultEffort = persistedDefaults.effort;
    if (persistedDefaults?.autoCompactPct) this.opts.defaultAutoCompactPct = persistedDefaults.autoCompactPct;
    if (persistedDefaults?.fast !== undefined) this.opts.defaultFast = persistedDefaults.fast;
    // work session 独立默认（无 persisted → null，spawn 时 fallback 频道默认）
    const persistedWorkDefaults = this.channelConfigStore.getWorkDefaults();
    this.workDefaultModel = persistedWorkDefaults?.model ?? null;
    this.workDefaultEffort = persistedWorkDefaults?.effort ?? null;
    this.workDefaultFast = persistedWorkDefaults?.fast ?? null;

    // ── 0.5 name-map-store init + 首次种子 ──
    // 单一 name-mappings.json，supervisor 写、两进程读（子端靠 mtime 热重载=实时）。
    // 文件不存在时用 .env FEISHU_KNOWN_USERS / FEISHU_BOT_ROSTER 灌种子（已存在则不覆盖用户改的）。
    initNameMapStore(this.nameMapPath);
    seedNameMapIfAbsent(
      parseEnvMap(process.env.FEISHU_KNOWN_USERS),
      parseEnvMap(process.env.FEISHU_BOT_ROSTER),
    );

    // ── 1. DB ──
    // 方案A：supervisor 自身**不再**碰 DB（彻底卸 better-sqlite3，根治 Electron v130 vs 子进程 v137
    // 双 ABI）。dbPath 仅作为路径透传给各频道子进程（它们跑系统 Node、better-sqlite3 prebuild 匹配，
    // DB 读写全在子端）。投票记票走 IPC 路由到子端执行。
    process.stderr.write(`[supervisor] DB path (passthrough to children): ${this.dbPath}\n`);

    // ── 2. IPC server start ──
    const port = await this.ipcServer.start();
    // supervisor.restart() 复用同一 ipcServer 实例，先清旧 listener 防重注册累积
    this.ipcServer.removeAllListeners('client-hello');
    this.ipcServer.removeAllListeners('client-disconnected');
    this.ipcServer.removeAllListeners('statusline-update');
    this.ipcServer.on('client-hello', (info: { chat_id: string; pid: number }) => {
      process.stderr.write(`[supervisor] IPC client up: chat=${info.chat_id} pid=${info.pid}\n`);
      // D3: MCP（重）连上 → 取消断线自愈 grace 定时器（自身重连成功，无需杀重生）
      this.clearGraceTimer(info.chat_id);
      // 通知对应 ChannelCli 启动期结束（停止 auto-confirm 启动 prompts）
      this.channels.get(info.chat_id)?.emit('ipc-ready');
      // D2: CLI 已就绪 → flush 该 chat 在未就绪期间缓冲的入站消息
      this.flushPendingInbound(info.chat_id);
      this.emit('channel-mcp-ready', info);
    });
    this.ipcServer.on('client-disconnected', (info: { chat_id: string; pid: number }) => {
      process.stderr.write(`[supervisor] IPC client down: chat=${info.chat_id} pid=${info.pid}\n`);
      // D3 抗断线：crashed 只在 PTY 退出触发；MCP 子进程死/IPC 断而 PTY 仍活时只有本事件 →
      // 启动 grace 自愈，否则消息永久缓冲在 pendingInbound 无人 flush。
      this.scheduleIpcRecovery(info.chat_id);
    });

    // ── P1.3 statusLine sink 推 per-CLI 上下文用量（事件驱动，不轮询）──
    this.ipcServer.on('statusline-update', (p: StatuslineUpdateParams) => {
      this.channelUsage.set(p.chat_id, {
        context_pct: p.used_percentage,
        context_tokens: p.total_input_tokens,
        context_window_size: p.context_window_size,
        cost_usd: p.cost_usd,
        updated_at: Date.now(),
      });
      // 账号级额度（5h+7天）—— 任一 CLI 推的都可用，逐窗口存最新一个；只在拿到 number used_percentage
      // 时更新该窗口（null = 该 CLI statusLine 无此字段，不重置已存值——stale 优于忽明忽暗，
      // CLI 停了/换版本/非 Max 无字段时宁可显旧值也别闪没）。
      if (p.rate_limits) {
        const merged: RateLimits = { ...this.lastRateLimits };
        let changed = false;
        for (const w of ['five_hour', 'seven_day'] as const) {
          const win = p.rate_limits[w];
          if (win && typeof win.used_percentage === 'number') {
            // 逐字段 stale：resets_at 偶发 null 时保留已存有效值，不把好值清没
            const prev = this.lastRateLimits?.[w];
            merged[w] = {
              used_percentage: win.used_percentage,
              resets_at: typeof win.resets_at === 'number' ? win.resets_at : (prev?.resets_at ?? null),
            };
            changed = true;
          }
        }
        if (changed) {
          this.lastRateLimits = merged;
          if (this.lastQuotaSnapshot) {
            this.lastQuotaSnapshot.rate_limits = this.lastRateLimits;
            this.emit('quota', this.lastQuotaSnapshot);
          }
        }
      }
      this.emit('channel-state-changed', p.chat_id);
      // 自动压缩交给 CLI 原生 auto-compact（spawn env CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 调阈值），
      // supervisor 不再监测用量阈值推 trigger（D-6 手工摘要机制已回滚）。
    });

    // ── 2.5 注册 work session IPC request handlers ──
    this.ipcServer.setRequestHandler(IPC_METHODS.WORK_SPAWN, async (params, chatId) => {
      const p = params as WorkSpawnParams;
      const session = new WorkSession({
        originChatId: p.origin_chat_id || chatId,
        workDir: p.work_dir,
        goal: p.goal,
        model: p.model || this.workDefaultModel || this.opts.defaultModel,
        effort: p.effort || this.workDefaultEffort || 'high',
        fast: this.workDefaultFast ?? false,
      });
      this.workSessions.set(session.id, session);
      // headless：每轮 result 事件确定性 emit 一次 'stopped'，无需 idle 猜停/15s 去重——直接 push 给品品。
      session.on('stopped', (info: WorkSessionStopInfo) => {
        const pushed = this.ipcServer.pushWorkStopped(session.opts.originChatId, {
          session_id: session.id,
          result: info.result,
          is_error: info.is_error,
          stop_reason: info.stop_reason,
          duration_ms: info.duration_ms,
          total_cost_usd: info.total_cost_usd,
        });
        // 遥控修复 Bug2 诊断：唤醒信号没送到品品（IPC 客户端不在线）时不能静默丢——写 WARN 便于定位断点
        if (!pushed) {
          process.stderr.write(
            `[supervisor] WARN: pushWorkStopped 失败（originChatId=${session.opts.originChatId.slice(-8)} 无 IPC 客户端）` +
              ` session=${session.id} —— 品品收不到工作 CLI 停止提醒\n`,
          );
        }
      });
      session.start();
      const result: WorkSpawnResult = { session_id: session.id };
      return result;
    });

    this.ipcServer.setRequestHandler(IPC_METHODS.WORK_SEND, async (params) => {
      const p = params as WorkSendParams;
      const session = this.workSessions.get(p.session_id);
      if (!session) {
        const result: WorkOkResult = { ok: false, error: `unknown session: ${p.session_id}` };
        return result;
      }
      const sent = session.sendMessage(p.message);
      const result: WorkOkResult = sent ? { ok: true } : { ok: false, error: 'work CLI not running' };
      return result;
    });

    // Q7: 品品主动 peek work session（拿翻译后的最近 N 条事件行）
    this.ipcServer.setRequestHandler(IPC_METHODS.WORK_PEEK, async (params) => {
      const p = params as WorkPeekParams;
      const session = this.workSessions.get(p.session_id);
      if (!session) {
        const result: WorkPeekResult = { ok: false, error: `unknown session: ${p.session_id}`, lines: [] };
        return result;
      }
      const limit = Math.min(Math.max(p.limit ?? 50, 1), 500);
      const result: WorkPeekResult = {
        ok: true,
        lines: session.peekHistory(limit),
        status: session.status,
      };
      return result;
    });

    // 手动 /压缩：compact_chat tool → 往本频道 CLI 的 PTY 写 `/compact\n` 触发原生压缩
    this.ipcServer.setRequestHandler(IPC_METHODS.COMPACT_VIA_PTY, async (params, chatId) => {
      const p = params as CompactViaPtyParams;
      const targetChatId = p.chat_id || chatId;
      const cli = this.channels.get(targetChatId);
      if (!cli) {
        const result: WorkOkResult = { ok: false, error: `unknown channel: ${targetChatId}` };
        return result;
      }
      const ok = cli.writeToPty('/compact\n');
      const result: WorkOkResult = ok
        ? { ok: true }
        : { ok: false, error: 'channel CLI 不在 running 态，无法写 PTY' };
      return result;
    });

    // 飞书 /下线：sleep_self → 关闭本频道（stop + evict 出 Map），归属 standby 标记不变（常驻仍常驻）。
    // evict 后频道 OFF，下条入站消息经热路径自动唤醒。先回 ok 再 pauseChannel——pauseChannel 的 cli.stop()
    // 会树杀本 child，response 必须先发回去（否则发给死 socket，调用方误判失败）。
    this.ipcServer.setRequestHandler(IPC_METHODS.SLEEP_SELF, async (_params, chatId) => {
      if (!chatId) return { ok: false, error: 'no chatId on connection' } as WorkOkResult;
      setTimeout(() => this.pauseChannel(chatId), 200);
      return { ok: true } as WorkOkResult;
    });

    // 品品主动单聊 / 建群后即时挂频道监听（spawnChannelCli 幂等，已存在直接返回）
    this.ipcServer.setRequestHandler(IPC_METHODS.SPAWN_CHANNEL, async (params) => {
      const p = params as SpawnChannelParams;
      if (!p.chat_id) return { ok: false, error: 'missing chat_id' } as WorkOkResult;
      this.spawnChannelCli(p.chat_id, p.chat_name);
      return { ok: true } as WorkOkResult;
    });

    // 解散群后停该频道 CLI（stopChannel：stop CLI + 从 channels 删除 + 删配置，不再重 spawn）
    this.ipcServer.setRequestHandler(IPC_METHODS.STOP_CHANNEL, async (params) => {
      const p = params as StopChannelParams;
      if (!p.chat_id) return { ok: false, error: 'missing chat_id' } as WorkOkResult;
      const ok = this.stopChannel(p.chat_id);
      return { ok } as WorkOkResult;
    });

    // ── 人名/bot名映射管理 IPC（启动器面板用；UI 后续阶段做）──
    this.ipcServer.setRequestHandler(IPC_METHODS.GET_NAME_MAPPINGS, async () => {
      return this.getNameMappings();
    });
    this.ipcServer.setRequestHandler(IPC_METHODS.GET_PENDING_NAMES, async () => {
      return this.getPendingNames();
    });
    this.ipcServer.setRequestHandler(IPC_METHODS.SET_NAME_MAPPING, async (params) => {
      const p = params as SetNameMappingParams;
      if (!p.id || !p.type) return { ok: false, error: 'missing type/id' } as WorkOkResult;
      this.setNameMappingFromUI(p.type, p.id, p.name);
      return { ok: true } as WorkOkResult;
    });

    this.ipcServer.setRequestHandler(IPC_METHODS.WORK_END, async (params) => {
      const p = params as WorkEndParams;
      const session = this.workSessions.get(p.session_id);
      if (!session) {
        const result: WorkOkResult = { ok: false, error: `unknown session: ${p.session_id}` };
        return result;
      }
      session.end();
      this.workSessions.delete(p.session_id);
      const result: WorkOkResult = { ok: true };
      return result;
    });

    // ── 3. 飞书 Client init ──
    initFeishuClient(this.opts.feishuAppId, this.opts.feishuAppSecret);

    // ── 4. FeishuPoll 启动（onMessage → 按 chat_id 路由 → IPC push 给对应子 MCP server） ──
    this.feishuPoll = new FeishuPoll(this.opts.feishuAppId, {
      onMessage: (msg) => this.onFeishuMessage(msg),
      onChatListDiff: (diff) => this.onChatListDiff(diff),
    });
    await this.feishuPoll.start();

    // ── 4.5 P4.Q3: FeishuEventSubscriber 启动（接 user 消息含 P2P；跟 poll 双轨并存） ──
    // poll 不能动：飞书 chat.list 不返 P2P + 事件订阅不推 bot 消息 = 双轨是平台约束必然
    this.feishuEventSubscriber = new FeishuEventSubscriber({
      appId: this.opts.feishuAppId,
      appSecret: this.opts.feishuAppSecret,
      onMessage: (msg) => this.onFeishuMessage(msg),
      onPollAction: (evt, val) => this.onPollAction(evt, val),
      onReaction: (evt) => this.onReaction(evt),
      onBotAdded: (evt) => this.onBotAdded(evt),
      onComment: (evt) => this.onComment(evt),
    });
    try {
      await this.feishuEventSubscriber.start();
    } catch (e) {
      // 事件订阅启动失败不阻塞 supervisor 启动（poll 仍跑）—— 飞书后台未开权限时 graceful degradation
      process.stderr.write(
        `[supervisor] FeishuEventSubscriber 启动失败 (poll 继续工作): ${e instanceof Error ? e.message : e}\n`,
      );
    }

    // ── 5. 已识别的所有 chat 自动 spawn 频道 CLI（启动器一打开即全部上线）──
    this.spawnAllKnownChannels();

    // ── 5.5 supervisor 内嵌 cron（2026-05-28 多 CLI 决策）：
    //         mood-decay / feishu-token-keepalive / daily-restart 编排
    //         这 3 个不依赖 CLI 在线，统一在 main process 跑（避免 N 个 CLI 重复触发） ──
    this.cronRunner.start();

    // ── 5.6 管家桥接 server（固定端口，供独立管家进程手机远程看/控 CLI；旁路，失败不崩品品）──
    try {
      this.wardenBridge = await createWardenBridge({
        getChannels: () => this.channels,
        getSystemInfo: (): WardenSystemInfo => ({
          channel_count: this.channels.size,
          rate_limits: this.lastRateLimits,
        }),
        getUsage: (chatId) => this.channelUsage.get(chatId),
        startChannel: (id) => {
          const c = this.spawnChannelCli(id);
          c.start();
        },
        pauseChannel: (id) => this.pauseChannel(id),
        setChannelConfig: (id, cfg) => this.setChannelConfig(id, cfg),
        setDisplayName: (id, name) => this.setChannelDisplayName(id, name),
        // 批2 额度 + 删除恢复
        fetchQuota: async () => {
          await this.fetchQuotaNow();
          return {
            quota: this.lastQuotaSnapshot,
            today_messages: this.getTodayMessageCount(),
            rate_limits: this.lastRateLimits,
          };
        },
        // 批3 work session
        getWorkSessions: () => this.workSessions,
        getWorkSession: (sid) => this.getWorkSession(sid),
        // 批4 全局设置 + 系统 + 日志
        getDefaults: () => ({
          channel: {
            model: this.opts.defaultModel,
            effort: this.opts.defaultEffort,
            fast: this.opts.defaultFast ?? false,
            autoCompactPct: this.opts.defaultAutoCompactPct,
          },
          work: this.getWorkDefaults(),
        }),
        setDefaults: (patch) => this.setDefaults(patch),
        setWorkDefaults: (patch) => this.setWorkDefaults(patch),
        restartSupervisor: () => this.restart(),
        quitApp: () => this.emit('warden-request-quit'),
        getRecentLogs: (limit) => this.recentLogs.slice(-limit),
      });
    } catch (e) {
      process.stderr.write(
        `[supervisor] warden-bridge 启动失败（不影响品品主功能）: ${e instanceof Error ? e.message : e}\n`,
      );
    }

    // ── 6. ccusage poller (P1.3 改：Owner要求不轮询，删 5min interval；改按需 fetchQuotaNow 触发) ──
    // 不再自动 start interval；用户从 footer "获取 quota" 按钮触发 fetchQuotaNow()

    // ── 7. PTY heartbeat 监控 已删除（P3 实测反馈）──
    // 旧设计：30s 一轮检查 PTY 空闲 → restart。问题：claude 长期空闲（飞书无消息）= 正常，
    // 被 120s 阈值误判冻结 → 反复 restart 茶水间 CLI 导致 IPC 频繁断开（logs/launcher.log 实证每
    // 2-3 分钟就出 ECONNRESET）。Owner P3 反馈选项 "删 heartbeat 自动 restart，只保留进程死亡检测"。
    // 进程真死由 PtyManager.onExit 标记 alive=false，UI 上 health-dot 自动变灰，Owner可手动 [↻] 重启。

    process.stderr.write(
      `[supervisor] started (vault=${this.opts.vaultCwd}, ipc=:${port}, channels=${this.channels.size})\n`,
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    // 最优先同步树杀所有频道 CLI + 工人 CLI（放在任何 await 之前：即便后续异步收尾卡住、
    // 或 Electron 抢着退出，taskkill /F /T 也已先发，绝不留孤儿 claude.exe / MCP server）。
    for (const cli of this.channels.values()) cli.stop();
    this.channels.clear();
    for (const ws of this.workSessions.values()) ws.end();
    this.workSessions.clear();
    this.cronRunner.stop();
    await this.ccusagePoller.stop();
    await this.feishuPoll?.stop();
    this.feishuPoll = null;
    await this.feishuEventSubscriber?.stop();
    this.feishuEventSubscriber = null;
    await this.ipcServer.stop();
    await this.wardenBridge?.stop();
    this.wardenBridge = null;
    process.stderr.write('[supervisor] stopped\n');
  }

  /** 启动器「重启品品」：stop + start（start 已永远拉起所有已知频道）。 */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** 抗断线加固：熔断后的有界慢速自愈链。每 5min 一跳——
   *  已稳定运行 → 重置熔断状态；达上限(6次) → 通知Owner + 交手动 [↻]；否则重试一次再排下一跳。
   *  crashState 被 manual-restart/stopChannel 清掉时链自动终止（回调内重取 state 判空）。 */
  private scheduleSlowRecovery(chatId: string): void {
    setTimeout(() => {
      const state = this.crashState.get(chatId);
      if (!state || !state.slowRecoveryActive) return; // 已被手动重启/遗忘清掉 → 链终止
      const ch = this.channels.get(chatId);
      if (!ch) {
        this.crashState.delete(chatId);
        return;
      }
      if (ch.status === 'running') {
        // 上次尝试已稳定运行满 5min → 自愈成功，重置熔断状态
        process.stderr.write(
          `[supervisor] channel ${chatId.slice(-8)} 慢速自愈成功，频道已稳定运行\n`,
        );
        this.crashState.delete(chatId);
        return;
      }
      if ((state.recoveryCount ?? 0) >= 6) {
        process.stderr.write(
          `[supervisor] channel ${chatId.slice(-8)} 慢速自愈 6 次仍未恢复，通知Owner并停止（等手动 [↻]）\n`,
        );
        void this.notifyChannelDown(chatId);
        this.crashState.delete(chatId);
        return;
      }
      state.recoveryCount = (state.recoveryCount ?? 0) + 1;
      process.stderr.write(
        `[supervisor] channel ${chatId.slice(-8)} 慢速自愈第 ${state.recoveryCount}/6 次尝试重启\n`,
      );
      if (ch.status === 'failed') ch.start();
      this.scheduleSlowRecovery(chatId);
    }, 5 * 60_000);
  }

  /** 频道自愈耗尽时给该 chat 发飞书提示——不静默死。复用 supervisor 持有的 Lark 单例。 */
  private async notifyChannelDown(chatId: string): Promise<void> {
    try {
      await getFeishuClient().im.v1.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({
            text: '⚠️ 我这会儿连接出问题了，自动重试了好几次还没缓过来——多半是网络在抽风。等通了我会自己接上；要是急，可以从启动器手动重启我一下。',
          }),
        },
        params: { receive_id_type: 'chat_id' },
      });
    } catch (e) {
      process.stderr.write(
        `[supervisor] 下线通知发送失败 chat=${chatId.slice(-8)}: ${e instanceof Error ? e.message : e}\n`,
      );
    }
  }

  /** 崩溃/IPC断线统一熔断决策：记一次故障，返回 true=可立即重启 / false=已转入慢速自愈（调用方勿再重启）。
   *  crashed 链与 IPC 断线自愈链共用 crashState，单源防 flapping、避免双重计数/双重启。 */
  private registerFaultAndShouldRestart(chatId: string): boolean {
    const now = Date.now();
    let state = this.crashState.get(chatId);
    if (!state) {
      state = { count: 0, windowStart: now };
      this.crashState.set(chatId, state);
    }
    // 已进入有界慢速自愈期：重启与计数都交给慢速链（避免"快重启 + 慢速重启"双重启 + 计数窗口重置打架）。
    if (state.slowRecoveryActive) {
      process.stderr.write(
        `[supervisor] channel ${chatId.slice(-8)} 慢速自愈期内又故障，等下次慢速尝试\n`,
      );
      return false;
    }
    if (now - state.windowStart > 5 * 60_000) {
      state.windowStart = now;
      state.count = 0;
    }
    state.count++;
    if (state.count > 3) {
      // 不再"永久等手动"，转入有界慢速自愈（每 5min 一次、上限 6 次≈30min）；仍救不回才通知Owner交手动 [↻]。
      state.slowRecoveryActive = true;
      state.recoveryCount = 0;
      process.stderr.write(
        `[supervisor] channel ${chatId.slice(-8)} 5min 内故障 ${state.count} 次，转入慢速自愈（每5min，上限6次）\n`,
      );
      this.scheduleSlowRecovery(chatId);
      return false;
    }
    return true;
  }

  /** 清掉某 chat 待触发的 IPC 断线自愈 grace 定时器。重连成功 / 主动 pause / stop 时调——
   *  防定时器泄漏 + 防"pause 后立即被消息动态 respawn、grace 到点误杀新 CLI"（新 CLI 握手前 status 已是 running）。 */
  private clearGraceTimer(chatId: string): void {
    const gt = this.graceTimers.get(chatId);
    if (gt) {
      clearTimeout(gt);
      this.graceTimers.delete(chatId);
    }
  }

  /** D3 抗断线：IPC client 断开后启动 grace 窗口。窗口内 MCP 自身重连(client-hello)会取消本定时器；
   *  否则判定 CLI 僵尸（PTY 活但 MCP/IPC 死）→ recoverDeadChannel 杀掉重生。
   *  grace=15s 覆盖 MCP 重连前 3 次(2/4/8s≈14s)，正常重连(1-2次,2-6s)早回；仍不回则该频道大概率真坏。 */
  private scheduleIpcRecovery(chatId: string): void {
    if (this.graceTimers.has(chatId)) return; // 已有定时器在跑，不重复
    const timer = setTimeout(() => {
      this.graceTimers.delete(chatId);
      this.recoverDeadChannel(chatId);
    }, 15_000);
    this.graceTimers.set(chatId, timer);
  }

  /** grace 期满仍无 IPC client → 该频道 MCP 僵尸，恢复处理。 */
  private recoverDeadChannel(chatId: string): void {
    if (this.ipcServer.hasClient(chatId)) return; // 边缘时刻已重连（hello 与 grace 到点竞态）
    const cli = this.channels.get(chatId);
    if (!cli) return; // 已被 pause/daily-restart evict（grace 15s 足够让主动 stop 的 channels.delete 先发生）
    if (cli.status !== 'running') return; // 非 running（stopped/failed/starting）→ pause/crashed 等路径接管，不抢
    const standby = this.channelConfigStore.isStandby(chatId);
    const hasPending = (this.pendingInbound.get(chatId)?.length ?? 0) > 0;
    process.stderr.write(
      `[supervisor] channel ${chatId.slice(-8)} IPC 断 15s 未重连 → 判定 MCP 僵尸，恢复（standby=${standby}, pending=${hasPending}）\n`,
    );
    cli.stop(); // 树杀僵尸 PTY + 残余 MCP server
    this.channels.delete(chatId);
    // 睡眠频道且无积压 → 回睡，不重生（与 crashed 的 standby 分支一致，靠下条消息唤醒）
    if (standby && !hasPending) {
      process.stderr.write(
        `[supervisor] channel ${chatId.slice(-8)} 睡眠态且无积压 → 回睡，不重生（下条消息唤醒）\n`,
      );
      return;
    }
    if (!this.registerFaultAndShouldRestart(chatId)) return; // 超频 → 慢速自愈接管
    this.spawnChannelCli(chatId, this.channelConfigStore.get(chatId)?.display_name);
    this.notifyAutoRecovered(chatId);
  }

  /** D3 自愈重生后给该 chat 发一句飞书提示（Owner要"吭一声"）。延迟到新 CLI 大概率起来后发。 */
  private notifyAutoRecovered(chatId: string): void {
    setTimeout(() => {
      void getFeishuClient()
        .im.v1.message.create({
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({
              text: '（我刚跟服务器断了一下线，已经自动重连好啦～断线期间你发的消息我补看到了，这就回你）',
            }),
          },
          params: { receive_id_type: 'chat_id' },
        })
        .catch((e: unknown) => {
          process.stderr.write(
            `[supervisor] 自愈提示发送失败 chat=${chatId.slice(-8)}: ${e instanceof Error ? e.message : e}\n`,
          );
        });
    }, 8_000);
  }

  getWorkSessionStats(): Array<ReturnType<WorkSession['getStats']>> {
    return [...this.workSessions.values()].map((ws) => ws.getStats());
  }

  /** Q5: work 终端 IPC 用 —— 拿 WorkSession 实例做 attach/detach/sendMessage/peek */
  getWorkSession(sessionId: string): WorkSession | undefined {
    return this.workSessions.get(sessionId);
  }

  /** 主面板 work session 卡 ✕ 按钮 → 强制结束（修内审 Required #1） */
  endWorkSession(sessionId: string): boolean {
    const ws = this.workSessions.get(sessionId);
    if (!ws) return false;
    ws.end();
    this.workSessions.delete(sessionId);
    return true;
  }

  isRunning(): boolean {
    return this.started;
  }

  getIpcPort(): number {
    return this.ipcServer.getPort();
  }

  getChats(): Array<{ chat_id: string; name?: string }> {
    return this.feishuPoll?.getChats() ?? [];
  }

  /**
   * 拿频道可读显示名（日志流 source / dialog 标题等 UI 显示用）。
   * 优先级（2026-05-28 实测Owner反馈：P2P 单聊不在飞书 chat.list 里，光查 getChats 显字符）：
   *   1. channel-config.json 的 display_name（用户自定义如"Owner（私聊）"）
   *   2. 飞书 chat.list 的 chat_name（群聊有）
   *   3. chat_id 末 8 位（兜底）
   */
  getChannelDisplayName(chatId: string): string {
    const persisted = this.channelConfigStore.get(chatId);
    if (persisted?.display_name) return persisted.display_name;
    const chat = this.feishuPoll?.getChats().find((c) => c.chat_id === chatId);
    if (chat?.name) return chat.name;
    return chatId.slice(-8);
  }

  getChannelCliStats(): Array<ReturnType<ChannelCli['getStats']>> {
    return [...this.channels.values()].map((c) => c.getStats());
  }

  /** 启动器「展示用」频道列表 = 已 spawn 的真实状态 + 已识别但未 spawn（如待机）的合成"停止卡"。 */
  getDisplayChannels(): Array<ReturnType<ChannelCli['getStats']>> {
    // 盖 standby 戳：已 spawn 的（含被消息唤醒、当前 running 的睡眠频道）从 configStore 读，
    // 让卡片即使 running 也显示"睡眠"徽章（renderChannelCard 渲染，提示归属睡眠：4 点重启不上线、靠消息唤醒）。
    const spawned = this.getChannelCliStats().map((s) => ({
      ...s,
      standby: this.channelConfigStore.isStandby(s.chat_id),
    }));
    const seen = new Set(spawned.map((c) => c.chat_id));
    const out = [...spawned];
    const knownIds: string[] = [];
    for (const c of this.feishuPoll?.getChats() ?? []) knownIds.push(c.chat_id);
    for (const id of this.channelConfigStore.listChatIds()) knownIds.push(id);
    for (const chatId of knownIds) {
      if (seen.has(chatId)) continue;
      seen.add(chatId);
      const persisted = this.channelConfigStore.get(chatId);
      out.push({
        chat_id: chatId,
        chat_name: this.getChannelDisplayName(chatId),
        status: 'stopped',
        pid: undefined,
        uptime_ms: 0,
        started_at: null,
        model: persisted?.model ?? this.opts.defaultModel,
        effort: persisted?.effort ?? this.opts.defaultEffort ?? 'high',
        autoCompactPct: persisted?.autoCompactPct ?? this.opts.defaultAutoCompactPct ?? DEFAULT_AUTOCOMPACT_PCT,
        fast: persisted?.fast ?? this.opts.defaultFast ?? false,
        session_id: undefined,
        standby: this.channelConfigStore.isStandby(chatId),
      });
    }
    return out;
  }

  getChannel(chatId: string): ChannelCli | undefined {
    return this.channels.get(chatId);
  }

  /** spawn 所有已识别频道（飞书 chat.list + channel-config 持久化的，跳过睡眠归属）。start() 调（启动器一开全上线）、
   *  04:10 daily-restart 调（把被 /下线 evict 出 Map 的常驻频道也重新拉起）。spawnChannelCli 幂等，已在 Map 的跳过。 */
  spawnAllKnownChannels(): void {
    // 5a. 飞书 chat.list 拿到的群（含Owner已加入的群聊）
    for (const c of this.feishuPoll?.getChats() ?? []) {
      if (this.channelConfigStore.isStandby(c.chat_id)) continue; // 待机频道不自动拉起（有人说话才唤醒）
      this.spawnChannelCli(c.chat_id, c.name);
    }
    // 5b. 频道常驻：channel-config.json 持久化但飞书 chat.list 没返的（P2P 单聊 / 历史已识别群）
    const persistedIds = this.channelConfigStore.listChatIds();
    for (const chatId of persistedIds) {
      if (this.channels.has(chatId)) continue; // 5a 已 spawn 跳过
      if (this.channelConfigStore.isStandby(chatId)) continue; // 待机频道不自动拉起
      const persisted = this.channelConfigStore.get(chatId);
      this.spawnChannelCli(chatId, persisted?.display_name);
    }
  }

  /** 关闭频道运行进程并 evict 出 Map（归属 standby 标记不变）。供 /下线、启动器✕关闭、切睡眠复用。
   *  evict 后频道 OFF——下条入站消息经 onFeishuMessage 的"!channels.has → 动态 spawn"热路径自动唤醒。
   *  cli.stop() 置 userStopped=true，PTY 退出不触发 crash 自愈重 spawn。 */
  pauseChannel(chatId: string): void {
    this.clearGraceTimer(chatId); // 主动关闭 → 清待触发的断线自愈定时器，防 evict 后误杀重生的新 CLI
    const cli = this.channels.get(chatId);
    if (cli) {
      cli.stop();
      this.channels.delete(chatId);
    }
    this.emit('channel-state-changed', chatId);
    process.stderr.write(`[supervisor] channel ${chatId.slice(-8)} → 关闭并 evict 出 Map（下条消息唤醒；归属不变）\n`);
  }

  /** 设频道归属（常驻/睡眠）。standby 只决定"全部重启后是否自动上线"；关/开进程走 pauseChannel/spawn。
   *  ON：标 standby + pauseChannel（关闭+evict）；OFF：清 standby + spawn 恢复常驻在线。
   *  唤醒由 onFeishuMessage 的"!channels.has → 动态 spawn"热路径负责，本方法不碰那条路径。 */
  setChannelStandby(chatId: string, standby: boolean): boolean {
    this.channelConfigStore.setStandby(chatId, standby);
    if (standby) {
      this.pauseChannel(chatId);
    } else {
      const chat = this.feishuPoll?.getChats().find((c) => c.chat_id === chatId);
      this.spawnChannelCli(chatId, chat?.name ?? this.channelConfigStore.get(chatId)?.display_name);
      process.stderr.write(`[supervisor] channel ${chatId.slice(-8)} → 取消睡眠（已恢复常驻）\n`);
    }
    this.emit('channel-state-changed');
    return true;
  }

  /** 每日 4 点重启 03:55 stop 全部后调：把待机频道从 Map 移除（已 stopped），
   *  使 04:10 遍历 Map 重启时自然跳过它们 → 维持"待机=睡着不在 Map"不变量。 */
  evictStandbyChannels(): void {
    for (const [chatId, cli] of [...this.channels.entries()]) {
      if (this.channelConfigStore.isStandby(chatId)) {
        cli.stop();
        this.channels.delete(chatId);
        process.stderr.write(`[supervisor] 每日重启：睡眠频道 ${chatId.slice(-8)} evict 出 Map（不参与 04:10 重启）\n`);
      }
    }
  }

  // ── 人物画像注入：每频道多选（launcher 弹窗用，纯 fs/json，重启该频道生效）──
  // 注入逻辑本身在子 MCP src/mcp/instructions.ts:loadPersonaProfiles（CLI spawn 时读 vault），本组只读写 vault 文件。
  private personaDir(): string {
    return path.join(this.opts.vaultCwd, '记忆系统', '人物');
  }
  private personaMapPath(): string {
    return path.join(this.personaDir(), '_注入映射.json');
  }

  /** 当前所有可用人物 = 人物目录下 *.md 去后缀、排除 `_` 开头、排序。目录不存在 → []。 */
  listPersonaProfiles(): string[] {
    try {
      return fs
        .readdirSync(this.personaDir())
        .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
        .map((f) => f.slice(0, -3))
        .sort();
    } catch {
      return [];
    }
  }

  /** 本频道注入哪些人：chat 不在表 / 值含 __ALL__ / 读失败 → '__ALL__'（全选）；否则返该数组。 */
  getChannelPersonas(chatId: string): string[] | '__ALL__' {
    try {
      const map = JSON.parse(fs.readFileSync(this.personaMapPath(), 'utf-8')) as Record<string, unknown>;
      const picked = map[chatId];
      if (Array.isArray(picked) && !picked.includes('__ALL__')) return picked as string[];
      return '__ALL__';
    } catch {
      return '__ALL__';
    }
  }

  /** 写回本频道选择：空数组 / '__ALL__' → ["__ALL__"]（全注入兜底，避免一人不注入）。
   *  原子写（tmp+rename），保留 _comment 与其它 chat 条目。 */
  setChannelPersonas(chatId: string, sel: string[] | '__ALL__'): void {
    const file = this.personaMapPath();
    let map: Record<string, unknown> = {};
    try {
      map = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    } catch {
      // 缺文件/坏 → 从空对象起（仍会原样写回 _comment 缺失，可接受）
    }
    map[chatId] = sel === '__ALL__' || sel.length === 0 ? ['__ALL__'] : sel;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  }

  spawnChannelCli(chatId: string, chatName?: string): ChannelCli {
    let cli = this.channels.get(chatId);
    if (cli) return cli;
    // 频道常驻持久化：首次见到该 chat_id 就在 channel-config.json 落 seen=true 标记，
    // 下次重启 start() step 5b 会遍历持久列表自动恢复（含 P2P 单聊）
    this.channelConfigStore.markSeen(chatId);
    // P1.2: 优先 persisted config，fallback defaults
    const persisted = this.channelConfigStore.get(chatId);
    // P4.Q3 续：display_name 优先级 = 用户自定义 > 飞书自动反查 > undefined（renderer fallback chat_id 末 12 位）
    const effectiveChatName = persisted?.display_name ?? chatName;
    cli = new ChannelCli({
      chatId,
      chatName: effectiveChatName,
      vaultCwd: this.opts.vaultCwd,
      model: persisted?.model ?? this.opts.defaultModel,
      effort: persisted?.effort ?? this.opts.defaultEffort,
      autoCompactPct: persisted?.autoCompactPct ?? this.opts.defaultAutoCompactPct,
      fast: persisted?.fast ?? this.opts.defaultFast ?? false,
      supervisorPort: this.ipcServer.getPort(),
      dbPath: this.dbPath,
      nameMapPath: this.nameMapPath,
      // P1.3: statusLine sink 绝对路径
      statusLineSinkPath: path.join(this.opts.appRoot, 'scripts', 'statusline-sink.cjs'),
    });
    // P1.2: 事件驱动 state push（替代 1Hz 心跳 race）—— 状态变即向 main 推
    cli.on('started', () => {
      this.emit('channel-state-changed', chatId);
    });
    // 手动重启（cli.restart()，仅启动器 [↻] 触发）= Owner人工介入 → 重置崩溃熔断计数。
    // 注意：绝不能在 'started' 里重置——自动重启也 emit 'started'，那样崩溃循环每次重启都清零，
    // 熔断器（5min 崩 3 次停）永远到不了 3 次失效。只有人工 restart() 才清零。
    cli.on('manual-restart', () => {
      this.crashState.delete(chatId);
    });
    cli.on('stopped', () => {
      // P1.3: stopped 时清掉 per-CLI usage（chat_id 仍在但 session 没了，避免显示陈旧 %）
      this.channelUsage.delete(chatId);
      this.emit('channel-state-changed', chatId);
    });
    cli.on('failed', () => this.emit('channel-state-changed', chatId));
    // 2026-05-28 多 CLI 兜底：PTY 异常退出（非用户主动 stop）→ 自动重启（带 5s 退避防雪崩）
    // 5min 内连续崩 3 次 → 停止自动重启，等Owner手动 [↻]
    // D1: 计数存 this.crashState（实例级，key=chatId），不随闭包重建清零
    cli.on('crashed', () => {
      this.channelUsage.delete(chatId);
      this.emit('channel-state-changed', chatId);
      // 本 cli 已不在 Map（被 /下线 / 启动器✕ / 切睡眠 pauseChannel evict，或被新 spawn 替换）→ 非活跃频道的退出，不计数不重启。
      if (this.channels.get(chatId) !== cli) {
        process.stderr.write(
          `[supervisor] channel ${chatId.slice(-8)} 退出（已 evict / 被替换，不自动重启）\n`,
        );
        return;
      }
      // 睡眠频道（standby=true）被消息临时唤醒后意外崩溃 → evict 出 Map、不自动重启（Owner：默默回睡，下条消息再唤醒）。
      // 常驻频道崩溃则走下方熔断自愈（保持在线）。
      if (this.channelConfigStore.isStandby(chatId)) {
        this.channels.delete(chatId);
        process.stderr.write(
          `[supervisor] channel ${chatId.slice(-8)} 睡眠态崩溃 → evict，不自动重启（下条消息唤醒）\n`,
        );
        return;
      }
      // 计数 + 熔断决策走公共方法（与 IPC 断线自愈链共用 crashState，单源防 flapping）。
      if (!this.registerFaultAndShouldRestart(chatId)) return;
      process.stderr.write(
        `[supervisor] channel ${chatId.slice(-8)} 崩溃，5s 后自动重启\n`,
      );
      setTimeout(() => {
        const ch = this.channels.get(chatId);
        if (ch && ch.status === 'failed') ch.start();
      }, 5_000);
    });
    this.channels.set(chatId, cli);
    cli.start();
    return cli;
  }

  /** P1.3: 手动触发一次 ccusage 拉取（footer "获取 quota" 按钮调） */
  async fetchQuotaNow(): Promise<QuotaSnapshot | null> {
    await this.ccusagePoller.fetchOnce();
    return this.lastQuotaSnapshot;
  }

  /** P2.2: 改全局默认 model/effort + 持久化。只影响后续 spawn 的新群，不动已 spawn channel */
  setDefaults(patch: { model?: string; effort?: string; autoCompactPct?: number; fast?: boolean }): void {
    if (patch.model !== undefined) this.opts.defaultModel = patch.model;
    if (patch.effort !== undefined) this.opts.defaultEffort = patch.effort;
    if (patch.autoCompactPct !== undefined) this.opts.defaultAutoCompactPct = patch.autoCompactPct;
    if (patch.fast !== undefined) this.opts.defaultFast = patch.fast;
    this.channelConfigStore.setDefaults(patch);
    process.stderr.write(`[supervisor] defaults set: ${JSON.stringify(patch)}\n`);
  }

  /** work session 默认 model/effort/fast + 持久化。只影响后续 spawn 的 work session，不动已起的 */
  setWorkDefaults(patch: { model?: string; effort?: string; fast?: boolean }): void {
    // 空字符串（用户清空输入框保存）不当真实值——过滤掉，让 fallback 链回退到频道默认
    const clean: { model?: string; effort?: string; fast?: boolean } = {};
    if (patch.model) clean.model = patch.model;
    if (patch.effort) clean.effort = patch.effort;
    if (patch.fast !== undefined) clean.fast = patch.fast;
    if (clean.model !== undefined) this.workDefaultModel = clean.model;
    if (clean.effort !== undefined) this.workDefaultEffort = clean.effort;
    if (clean.fast !== undefined) this.workDefaultFast = clean.fast;
    this.channelConfigStore.setWorkDefaults(clean);
    process.stderr.write(`[supervisor] work defaults set: ${JSON.stringify(clean)}\n`);
  }

  /** 暴露 work 默认给 main process settings.get（未设/空时 fallback 频道默认 model / high） */
  getWorkDefaults(): { model: string; effort: string; fast: boolean } {
    return {
      model: this.workDefaultModel || this.opts.defaultModel,
      effort: this.workDefaultEffort || 'high',
      fast: this.workDefaultFast ?? false,
    };
  }

  /** P1.3: 暴露 channel-usage map 给 main process 拼 state */
  getChannelUsage(chatId: string): ChannelUsageInfo | undefined {
    return this.channelUsage.get(chatId);
  }

  /** P1.2: 切 channel 配置 + 持久化。channel 在 running 时不强 restart（Owner要求手动控制） */
  setChannelConfig(chatId: string, patch: { model?: string; effort?: string; autoCompactPct?: number; fast?: boolean }): void {
    this.channelConfigStore.set(chatId, patch);
    const cli = this.channels.get(chatId);
    if (cli) {
      if (patch.model !== undefined) cli.setModel(patch.model);
      if (patch.effort !== undefined) cli.setEffort(patch.effort);
      if (patch.autoCompactPct !== undefined) cli.setAutoCompactPct(patch.autoCompactPct);
      if (patch.fast !== undefined) cli.setFast(patch.fast);
    }
    process.stderr.write(`[supervisor] channel config set: ${chatId} ${JSON.stringify(patch)}\n`);
  }

  /** P4.Q3 续：自定义卡片显示名 + 持久化 + 即时反映到 ChannelCli getStats */
  setChannelDisplayName(chatId: string, displayName: string): void {
    const trimmed = displayName.trim();
    this.channelConfigStore.set(chatId, { display_name: trimmed || undefined });
    const cli = this.channels.get(chatId);
    if (cli) cli.setChatName(trimmed || undefined);
    this.emit('channel-state-changed', chatId);
    process.stderr.write(`[supervisor] channel display_name set: ${chatId} → "${trimmed}"\n`);
  }

  // ── 人名/bot 映射（启动器面板 + ipcServer handler 共享，DRY）──
  /** 已映射人名/bot 名（humans/bots 两桶）。 */
  getNameMappings(): NameMappings {
    return getAllMappings() as NameMappings;
  }
  /** 待命名 sender（解析后仍纯 ID 兜底=没友好名），供启动器面板列出待补名。 */
  getPendingNames(): PendingNameEntry[] {
    return [...this.pendingNames.values()] as PendingNameEntry[];
  }
  /** 启动器面板写映射：写 json（同进程 resolveSenderNameSync 立即生效、子进程下条消息靠 mtime 热重载）
   *  + 清待命名 + 推 state 让 UI 红点/列表刷新。 */
  setNameMappingFromUI(type: 'human' | 'bot', id: string, name: string): void {
    setNameMapping(type, id, name);
    this.pendingNames.delete(id);
    this.emit('channel-state-changed');
  }

  /** P1.2: restart 前 reload persisted 进 channel-cli.opts，避免切完配置后 restart 仍用旧 opts */
  reloadChannelConfigInto(chatId: string): void {
    const persisted = this.channelConfigStore.get(chatId);
    if (!persisted) return;
    const cli = this.channels.get(chatId);
    if (!cli) return;
    if (persisted.model) cli.setModel(persisted.model);
    if (persisted.effort) cli.setEffort(persisted.effort);
    if (persisted.autoCompactPct !== undefined) cli.setAutoCompactPct(persisted.autoCompactPct);
  }

  /** main.ts pushLog 同步灌入仪表盘日志 ring buffer（warden 手机端读）。上限 300 条，超丢最旧 */
  recordLog(entry: WardenLogEntry): void {
    this.recentLogs.push(entry);
    if (this.recentLogs.length > 300) this.recentLogs.splice(0, this.recentLogs.length - 300);
  }

  /** 今日入站消息数（YYYY-MM-DD 本地时区） */
  getTodayMessageCount(): number {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return this.dailyMessageCount.get(key) ?? 0;
  }

  /** D2: 入队一条 CLI 未就绪时无法投递的消息。每 chat 上限 50 条（超丢最旧 + log）。 */
  private enqueuePendingInbound(chatId: string, payload: FeishuInboundMessagePayload): void {
    let queue = this.pendingInbound.get(chatId);
    if (!queue) {
      queue = [];
      this.pendingInbound.set(chatId, queue);
    }
    if (queue.length >= 50) {
      const dropped = queue.shift();
      process.stderr.write(
        `[supervisor] pendingInbound(${chatId.slice(-8)}) 达 50 条上限，丢最旧: ${(dropped?.msg.text ?? '').slice(0, 30)}\n`,
      );
    }
    queue.push({ msg: payload, enqueuedAt: Date.now() });
    process.stderr.write(
      `[supervisor] msg buffered (CLI 未就绪, chat ${chatId.slice(-8)}, 队列 ${queue.length}): ${(payload.text ?? '').slice(0, 40)}\n`,
    );
  }

  /** D2: CLI ready（client-hello）后 flush 该 chat 缓冲队列：丢弃入队 > 10min 的过期消息，其余重走 push 路径。 */
  private flushPendingInbound(chatId: string): void {
    const queue = this.pendingInbound.get(chatId);
    if (!queue || queue.length === 0) return;
    this.pendingInbound.delete(chatId);
    const now = Date.now();
    const TTL = 10 * 60_000;
    let delivered = 0;
    let expired = 0;
    for (const item of queue) {
      if (now - item.enqueuedAt > TTL) {
        expired++;
        continue;
      }
      // CLI 刚 ready 但 IPC client 仍可能尚未注册 → 投递失败则重新入队等下次 hello
      if (this.ipcServer.pushFeishuMessage(chatId, item.msg)) delivered++;
      else this.enqueuePendingInbound(chatId, item.msg);
    }
    process.stderr.write(
      `[supervisor] pendingInbound flush (chat ${chatId.slice(-8)}): 投递 ${delivered}, 过期丢弃 ${expired}\n`,
    );
  }

  private onFeishuMessage(msg: FeishuInboundMessage): void {
    // P4.Q3: supervisor 入口 message_id 去重（防 WSClient + poll 双源同一条消息处理两次）。
    // 方案A：supervisor 已卸 DB，去重纯走 in-memory Set（重启清空；Owner已拍板删持久层）。
    // 重启窗口期 poll 以已持久化的 cursor 续拉、不回放已处理消息，故跨重启重复风险极小。
    if (this.supervisorProcessedIds.has(msg.message_id)) return;
    this.supervisorProcessedIds.add(msg.message_id);
    if (this.supervisorProcessedIds.size > 5000) {
      const arr = [...this.supervisorProcessedIds];
      for (let i = 0; i < arr.length - 5000; i++) this.supervisorProcessedIds.delete(arr[i]);
    }

    // reaction 事件不带 chat_id/发送者 → 在此记 message_id→{chat_id,发送者}，reaction 来时优先查缓存命中（免 API）
    this.msgIdToInfo.set(msg.message_id, {
      chatId: msg.chat_id,
      senderId: msg.sender_open_id,
      senderType: msg.sender_type,
      snippet: this.msgSnippet(msg.text, msg.msg_type),
    });
    if (this.msgIdToInfo.size > 2000) {
      const firstKey = this.msgIdToInfo.keys().next().value;
      if (firstKey !== undefined) this.msgIdToInfo.delete(firstKey);
    }

    // P4.Q3: 未知 chat_id（WSClient 推 P2P 新单聊 / 拉群事件先于 chat.list refresh）→ 动态 spawn channel CLI
    if (!this.channels.has(msg.chat_id)) {
      // chat_name 从 raw event 试取（飞书 event body 含 chat.name 或 chat.dm_name 等字段）
      // WSClient raw 是飞书 v2 事件摊平体（SDK EventDispatcher 把 header/event 展开到顶层）
      // 所以 chat 字段直接在顶层，无 .event 这层。
      const rawAny = msg.raw as { message?: { chat_id?: string }; chat?: { name?: string } } | undefined;
      const guessName = rawAny?.chat?.name;
      process.stderr.write(
        `[supervisor] WSClient 发现未监听 chat_id=${msg.chat_id} (sender=${msg.sender_open_id.slice(0, 8)}…) → 动态 spawn channel CLI\n`,
      );
      this.spawnChannelCli(msg.chat_id, guessName);
    }

    // 累计今日消息数（修内审 Optional #8）
    const d = new Date();
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    this.dailyMessageCount.set(dateKey, (this.dailyMessageCount.get(dateKey) ?? 0) + 1);
    // 清理 7 天前数据
    const cutoff = Date.now() - 7 * 86400_000;
    for (const k of this.dailyMessageCount.keys()) {
      const [y, m, dd] = k.split('-').map(Number);
      if (new Date(y, m - 1, dd).getTime() < cutoff) this.dailyMessageCount.delete(k);
    }

    // 待命名追踪：解析该 sender 名，若仍是纯 ID 兜底（slice -8）= 没友好名 → 记进 pendingNames
    // 供启动器"待命名"面板拉。已在 name-map/env 命中的不记（解析值 ≠ slice -8）。
    {
      const isBot = msg.sender_type === 'app';
      const resolved = resolveSenderNameSync(msg.sender_open_id, msg.sender_type);
      if (resolved === msg.sender_open_id.slice(-8)) {
        this.pendingNames.set(msg.sender_open_id, {
          id: msg.sender_open_id,
          chat_id: msg.chat_id,
          snippet: (msg.text ?? '').slice(0, 30),
          type: isBot ? 'bot' : 'human',
          ts: Date.now(),
        });
      } else {
        // 已有名字（可能刚被Owner映射）→ 清掉旧的待命名条目
        this.pendingNames.delete(msg.sender_open_id);
      }
    }

    // 反查 chat_name 给子端 setChatNameCache 写盘日志用（消化 step 3 review Required #1）
    // 优先级：channel-config.json display_name > feishu chat.list name（chat.list 不含 P2P 单聊）
    const chatName =
      this.channelConfigStore.get(msg.chat_id)?.display_name ??
      this.feishuPoll?.getChats().find((c) => c.chat_id === msg.chat_id)?.name;
    // 单点提取 content/mentions/parent_id（子端不再钻 raw 取这三字段）
    // poll 形态：raw 即 API list item，字段在顶层（raw.body.content / raw.mentions / raw.parent_id）
    // WS 形态：raw = SDK EventDispatcher 摊平体，内容在 raw.message.*
    function extractInboundFields(raw: unknown): { content?: string; mentions?: unknown[]; parent_id?: string } {
      if (!raw || typeof raw !== 'object') return {};
      const r = raw as Record<string, unknown>;
      // poll 形态
      const pollContent = (r.body as { content?: string } | undefined)?.content;
      const pollMentions = Array.isArray(r.mentions) ? r.mentions : undefined;
      const pollParentId = typeof r.parent_id === 'string' ? r.parent_id : undefined;
      if (pollContent !== undefined || pollMentions !== undefined || pollParentId !== undefined) {
        return { content: pollContent, mentions: pollMentions, parent_id: pollParentId };
      }
      // WS 形态
      const msgNode = r.message as Record<string, unknown> | undefined;
      if (msgNode) {
        return {
          content: typeof msgNode.content === 'string' ? msgNode.content : undefined,
          mentions: Array.isArray(msgNode.mentions) ? msgNode.mentions : undefined,
          parent_id: typeof msgNode.parent_id === 'string' ? msgNode.parent_id : undefined,
        };
      }
      return {};
    }
    const { content, mentions, parent_id } = extractInboundFields(msg.raw);
    // IPC push 到对应 chat_id 的子 MCP server 进程
    const payload: FeishuInboundMessagePayload = {
      chat_id: msg.chat_id,
      chat_name: chatName,
      message_id: msg.message_id,
      msg_type: msg.msg_type,
      sender_open_id: msg.sender_open_id,
      sender_type: msg.sender_type,
      text: msg.text,
      create_time_ms: msg.create_time_ms,
      is_p2p: msg.is_p2p,
      content,
      mentions,
      parent_id,
      raw: msg.raw,
    };
    const ok = this.ipcServer.pushFeishuMessage(msg.chat_id, payload);
    if (!ok) {
      // D2: 子 MCP server 未连上（CLI 还没起 / IPC 还没握手）→ 不丢弃，缓冲进 pendingInbound，
      // client-hello（CLI ready）后 flush 投递。原行为：仅 log + 永久丢（message_id 已 mark processed
      // + poll cursor 已推进，下轮不会重发）→ 新群/CLI 未就绪首条消息永久丢失。
      this.enqueuePendingInbound(msg.chat_id, payload);
    }
    this.emit('feishu-message', msg);
  }

  /**
   * 卡片投票点击回调：记票 + 刷卡片。
   * 方案A：supervisor 不碰 DB——把记票请求 IPC 路由到该 chat 的频道子进程（它 DB 正常）执行，
   * 拿回 {question,options,votes} 后仍用 supervisor 自己的 buildPollCard + updateCard 刷卡。
   * chat_id 取 evt.chatId（飞书 SDK CardActionEvent 顶层字段，与 evt.messageId 同源）。
   */
  private async onPollAction(evt: CardActionEvent, val: PollActionValue): Promise<void> {
    const { poll_id, option_idx } = val;
    const voterOpenId = evt.operator.openId;
    const chatId = evt.chatId;
    const messageId = evt.messageId;
    process.stderr.write(
      `[supervisor] poll action: poll_id=${poll_id} option=${option_idx} voter=${voterOpenId.slice(0, 8)}… chat=${chatId.slice(-8)}\n`,
    );
    try {
      const params: PollVoteParams = { poll_id, option_idx, voter_open_id: voterOpenId };
      let res: PollVoteResult;
      try {
        res = await this.ipcServer.request<PollVoteResult>(chatId, IPC_METHODS.POLL_VOTE, params);
      } catch {
        // CLI 离线兜底：拉起该频道 CLI + 等 hello，重试一次
        if (!this.channels.has(chatId)) this.spawnChannelCli(chatId);
        const up = await this.waitForChannelReady(chatId, 15000);
        if (!up) {
          process.stderr.write(`[supervisor] onPollAction: chat ${chatId.slice(-8)} CLI 未就绪，放弃记票\n`);
          return;
        }
        res = await this.ipcServer.request<PollVoteResult>(chatId, IPC_METHODS.POLL_VOTE, params);
      }

      if (!res.ok || !res.options || !res.votes || res.question === undefined) {
        process.stderr.write(`[supervisor] onPollAction 子端记票失败: ${res.error ?? 'no data'}\n`);
        return;
      }

      const newCard = buildPollCard(poll_id, res.question, res.options, res.votes);
      await this.feishuEventSubscriber!.updateCard(messageId, newCard);
      process.stderr.write(
        `[supervisor] poll ${poll_id} updated: ${JSON.stringify(res.votes)}\n`,
      );
    } catch (e) {
      // 不抛飞书（cardAction 回调 3s ack 约束）；仅 stderr log
      process.stderr.write(
        `[supervisor] onPollAction error: ${e instanceof Error ? e.message : e}\n`,
      );
    }
  }

  /** 方案A 离线兜底：等某 chat 的频道子进程 IPC hello 就绪（channel-mcp-ready），超时返 false */
  private waitForChannelReady(chatId: string, timeoutMs: number): Promise<boolean> {
    if (this.ipcServer.listClients().some((c) => c.chat_id === chatId)) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const onReady = (info: { chat_id: string }) => {
        if (info.chat_id === chatId) {
          clearTimeout(timer);
          this.off('channel-mcp-ready', onReady);
          resolve(true);
        }
      };
      const timer = setTimeout(() => {
        this.off('channel-mcp-ready', onReady);
        resolve(false);
      }, timeoutMs);
      this.on('channel-mcp-ready', onReady);
    });
  }

  /** 被点消息摘要：text 取内容前 30 字，非文字取类型友好标签——让品品知道被 react 的是哪条 */
  private msgSnippet(text: string | undefined, msgType: string): string {
    if (text && text.trim()) {
      const t = text.trim().replace(/\s+/g, ' ');
      return t.length > 30 ? `${t.slice(0, 30)}…` : t;
    }
    const labels: Record<string, string> = {
      image: '图片', file: '文件', audio: '语音', media: '视频', post: '图文',
      interactive: '卡片', sticker: '表情', share_chat: '分享群', share_user: '名片',
    };
    return `非文字内容·${labels[msgType] ?? msgType}`;
  }

  /** reaction 事件无 chat_id 也无"被点消息发送者/内容" → 先查缓存，未命中调飞书 message.get 反查
   *  （一次拿 chat_id + 发送者 + 内容摘要；in-flight 去重防风暴） */
  private async resolveReactedMsg(
    messageId: string,
  ): Promise<{ chatId: string; senderId: string; senderType: 'user' | 'app'; snippet: string } | null> {
    const cached = this.msgIdToInfo.get(messageId);
    if (cached) return cached;
    const inflight = this.msgInfoResolveInflight.get(messageId);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const res = await getFeishuClient().im.v1.message.get({ path: { message_id: messageId } });
        const item = res.data?.items?.[0] as
          | { chat_id?: string; msg_type?: string; sender?: { id?: string; sender_type?: string }; body?: { content?: string } }
          | undefined;
        const chatId = item?.chat_id;
        const senderId = item?.sender?.id;
        if (chatId && senderId) {
          // text 类型从 body.content JSON 抽文字（同 feishu-poll 解析），其它类型留类型标签
          let text: string | undefined;
          if (item?.msg_type === 'text') {
            try { text = (JSON.parse(item.body?.content ?? '{}') as { text?: string }).text; } catch { /* 解析失败留空 */ }
          }
          const info = {
            chatId,
            senderId,
            senderType: (item?.sender?.sender_type === 'app' ? 'app' : 'user') as 'user' | 'app',
            snippet: this.msgSnippet(text, item?.msg_type ?? 'text'),
          };
          this.msgIdToInfo.set(messageId, info);
          return info;
        }
        return null;
      } catch (e) {
        process.stderr.write(
          `[supervisor] resolveReactedMsg(${messageId}) 失败: ${e instanceof Error ? e.message : e}\n`,
        );
        return null;
      } finally {
        this.msgInfoResolveInflight.delete(messageId);
      }
    })();
    this.msgInfoResolveInflight.set(messageId, p);
    return p;
  }

  /** 事件投递前确保目标频道 CLI 就绪（find-or-spawn + 等 hello，仿 onPollAction 离线兜底） */
  private async ensureChannelReadyForEvent(chatId: string): Promise<boolean> {
    if (!this.channels.has(chatId)) this.spawnChannelCli(chatId);
    return this.waitForChannelReady(chatId, 15000);
  }

  /** 别人加表情回复 → 唤醒该频道品品（供参考、不强制回复）。撤表情(removed)不通知。 */
  private async onReaction(evt: ReactionEvent): Promise<void> {
    if (evt.action === 'removed') return; // Not-Doing：撤回表情不算"发来的 react"，不打扰
    const info = await this.resolveReactedMsg(evt.messageId);
    if (!info) {
      process.stderr.write(`[supervisor] onReaction: 反查被点消息失败 (msg ${evt.messageId})，丢弃\n`);
      return;
    }
    const chatId = info.chatId;
    if (!(await this.ensureChannelReadyForEvent(chatId))) {
      process.stderr.write(`[supervisor] onReaction: chat ${chatId.slice(-8)} CLI 未就绪，放弃\n`);
      return;
    }
    const reactor = resolveSenderNameSync(evt.operator.openId, 'user');
    const uni = feishuEmojiTypeToUnicode(evt.emojiType);
    const emojiShow = uni ? `${uni}（${evt.emojiType}）` : evt.emojiType;
    // 被点的消息是不是品品自己发的（app 类型 + sender.id 是本 bot 的 app_id，同 feishu-poll 自环判定）
    const isPinpinOwn = info.senderType === 'app' && info.senderId === this.opts.feishuAppId;
    let body: string;
    if (isPinpinOwn) {
      body = `【表情信号·供参考】${reactor} 给你这条消息「${info.snippet}」点了 ${emojiShow}。这通常表示认可/回应——你看情况决定要不要继续推进，不必专门回复。`;
    } else {
      const whose = info.senderId === evt.operator.openId
        ? '自己'
        : resolveSenderNameSync(info.senderId, info.senderType);
      body = `【表情信号·供参考】${reactor} 给${whose}的这条消息「${info.snippet}」点了 ${emojiShow}。群里的小互动，供你了解，一般不用回应。`;
    }
    this.ipcServer.pushChatTrigger(chatId, body, {
      user: reactor,
      sender_type: 'human',
      message_id: `reaction-${evt.messageId}-${evt.operator.openId}-${evt.emojiType}`,
      trigger: 'reaction',
    });
  }

  /** 品品被拉进新群 → spawn 该群 CLI + 提示品品可打招呼。 */
  private async onBotAdded(evt: BotAddedEvent): Promise<void> {
    const chatId = evt.chatId;
    if (!(await this.ensureChannelReadyForEvent(chatId))) {
      process.stderr.write(`[supervisor] onBotAdded: chat ${chatId.slice(-8)} CLI 未就绪，放弃\n`);
      return;
    }
    let chatName: string | undefined;
    try {
      const res = await getFeishuClient().im.v1.chat.get({ path: { chat_id: chatId } });
      chatName = res.data?.name;
    } catch { /* 拿不到群名不影响打招呼 */ }
    const body = `【系统】我刚被拉进这个群${chatName ? `「${chatName}」` : ''}。要不要打个招呼 / 做个自我介绍，你看情况决定。`;
    this.ipcServer.pushChatTrigger(chatId, body, {
      user: '系统',
      sender_type: 'system',
      message_id: `botadded-${chatId}-${evt.operator.openId}`,
      trigger: 'bot-added',
    });
  }

  /** 云文档评论 → 投到兜底频道（PINPIN_COMMENT_CHAT_ID ?? 主聊 PINPIN_OWNER_CHAT_ID）。评论正文未取。 */
  private async onComment(evt: CommentEvent): Promise<void> {
    const targetChatId = process.env.PINPIN_COMMENT_CHAT_ID || process.env.PINPIN_OWNER_CHAT_ID;
    if (!targetChatId) {
      process.stderr.write(`[supervisor] onComment: 未配 PINPIN_COMMENT_CHAT_ID / PINPIN_OWNER_CHAT_ID，丢弃评论事件\n`);
      return;
    }
    if (!(await this.ensureChannelReadyForEvent(targetChatId))) {
      process.stderr.write(`[supervisor] onComment: 兜底频道 ${targetChatId.slice(-8)} CLI 未就绪，放弃\n`);
      return;
    }
    const who = resolveSenderNameSync(evt.operator.openId, 'user');
    const body = `【云文档评论】${who} 在一个云文档（${evt.fileType}）里发了评论${evt.mentionedBot ? '，并 @了你' : ''}。（评论正文未取，需要的话可去查该文件）`;
    this.ipcServer.pushChatTrigger(targetChatId, body, {
      user: who,
      sender_type: 'human',
      message_id: `comment-${evt.commentId}`,
      trigger: 'doc-comment',
    });
  }

  private onChatListDiff(diff: ChatListDiff): void {
    for (const added of diff.added) {
      process.stderr.write(`[supervisor] 新群发现，自动 spawn: ${added.name ?? added.chat_id}\n`);
      this.spawnChannelCli(added.chat_id, added.name);
    }
    // 频道常驻语义（2026-05-28）：飞书 chat.list 返回 removed 不再主动 stop CLI——
    // 被踢/解散事件靠飞书 SDK 可能短时抖动（chat.list 拉空），误判 stop 会导致 CLI 反复重启。
    // 真要"停频道"走 disband_group → STOP_CHANNEL → stopChannel()。
    for (const removed of diff.removed) {
      process.stderr.write(
        `[supervisor] chat.list 不再返回此 chat（可能短时抖动 / 群解散），保持常驻 CLI: ${removed.name ?? removed.chat_id}\n`,
      );
    }
    this.emit('chat-list-diff', diff);
  }

  /**
   * 解散群后停该频道 CLI（disband_group → STOP_CHANNEL）。
   *   1. stop 该频道 CLI + 从 channels Map 移除
   *   2. 从 channel-config.json 删该 entry（防 spawnAllKnownChannels 重拉已解散群）
   *   3. 清 usage / crashState / pendingInbound
   */
  stopChannel(chatId: string): boolean {
    if (!this.channels.has(chatId) && !this.channelConfigStore.get(chatId)) return false;
    const cli = this.channels.get(chatId);
    if (cli) {
      cli.stop();
      this.channels.delete(chatId);
    }
    this.channelConfigStore.remove(chatId);
    this.channelUsage.delete(chatId);
    this.crashState.delete(chatId); // D1: 频道彻底停掉才清熔断计数（正常 respawn 不清=熔断跨 respawn 持续）
    this.pendingInbound.delete(chatId); // D2: 清未就绪缓冲队列，避免泄漏
    this.clearGraceTimer(chatId); // D3: 清待触发的断线自愈定时器
    process.stderr.write(`[supervisor] stop channel: ${chatId}\n`);
    this.emit('channel-state-changed', chatId);
    return true;
  }
}
