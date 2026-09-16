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
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { initFeishuClient, getFeishuClient } from './feishu-client.js';
import { readApprovalDefinitions, subscribeApprovalDefinitions, approvalStatusZh } from './approval-subscribe.js';
import type { ApprovalEventPayload, AttendanceEventPayload } from './feishu-event-subscriber.js';
import { FeishuPoll, type ChatListDiff, type FeishuInboundMessage } from './feishu-poll.js';
import { FeishuEventSubscriber, type PollActionValue } from './feishu-event-subscriber.js';
import { type FeishuAppConfig, isChatAllowed } from './feishu-apps.js';
import type { CardActionEvent, ReactionEvent, BotAddedEvent, CommentEvent } from '@larksuiteoapi/node-sdk';
import { buildPollCard, buildApprovalCard, type ApprovalCardValue } from '../src/mcp/feishu/cards/diy-card.js';
import { RecurringTaskRunner } from './recurring-tasks.js';
import { recurringTasksPath } from '../src/shared/recurring-tasks-store.js';
import { feishuEmojiTypeToUnicode } from '../src/mcp/utils/feishu-emoji-map.js';
import { safeName, pad2 } from '../src/mcp/utils/helper.js';
import { logBackground } from '../src/mcp/utils/background-log.js';
import { resolveSenderNameSync, resolveUserNameAsync } from './sender-resolver.js';
import { initNameMapStore, seedNameMapIfAbsent, getAllMappings, setNameMapping, getHumanNameMapping } from '../src/shared/name-map-store.js';
import { parseEnvMap } from '../src/shared/sender-shared.js';
import { IpcServer } from './ipc-server.js';
import { ChannelCli } from './channel-cli.js';
import { WorkerCli, loadWorkersConfig, saveWorkersConfig, type WorkerStatus } from './worker-cli.js';
import { ChannelConfigStore, DEFAULT_AUTOCOMPACT_PCT } from './channel-config-store.js';
import { CcusagePoller, type QuotaSnapshot } from './ccusage-poller.js';
import { SupervisorCronRunner } from './cron-runner.js';
import { createWardenBridge } from './warden-bridge.js';
import { RelayBridge } from './relay-bridge.js';
import { ensureBridgeToken } from '../src/ipc/bridge-token.js';
import {
  IPC_METHODS,
  type WorkOkResult,
  type StatuslineUpdateParams,
  type RateLimits,
  type WardenSystemInfo,
  type WardenLogEntry,
  type CompactViaPtyParams,
  type SpawnChannelParams,
  type SpawnChannelResult,
  type StopChannelParams,
  type DeleteChannelParams,
  type DeleteChannelResult,
  type SetPersonNameParams,
  type WakeWorkerParams,
  type WakeWorkerResult,
  type FeishuInboundMessagePayload,
  type PollVoteParams,
  type PollVoteResult,
  type NameMappings,
  type PendingNameEntry,
  type ChatSummary,
  type ListChatsResult,
  type PeerMessageParams,
  type BroadcastParams,
  type BroadcastResult,
  type PeerMessageResult,
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
  /** 全部飞书应用配置（loadFeishuApps() 结果，长度 ≥1；index 1 = primary，兜底 + 历史数据归属）。 */
  apps: FeishuAppConfig[];
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
  /** 多飞书应用：appId → { cfg, poll, subscriber }（一 app 一套 client/poll/事件订阅） */
  private apps = new Map<string, { cfg: FeishuAppConfig; poll: FeishuPoll; subscriber: FeishuEventSubscriber }>();
  /** primary 应用（index 1，.env 无后缀字段）：兜底 + 历史数据归属 */
  private get primaryApp(): FeishuAppConfig {
    return this.opts.apps[0];
  }
  /** P4.Q3: supervisor 入口 message_id 去重（防 WSClient + poll 双源重复推） */
  private supervisorProcessedIds = new Set<string>();
  private ipcServer: IpcServer;
  /** 管家桥接 server（固定端口，供独立管家进程远程看/控 CLI；旁路，失败不影响品品主功能） */
  private wardenBridge: IpcServer | null = null;
  /** 传话口（固定端口 47901，本机 Claude 窗口 ⇄ 品品；旁路，失败不影响品品主功能） */
  private relayBridge: RelayBridge | null = null;
  private ccusagePoller: CcusagePoller;
  private channelConfigStore: ChannelConfigStore;
  private cronRunner: SupervisorCronRunner;
  /** 固定任务引擎（登记表 recurring-tasks.json，启动器级定时，离线先拉起） */
  private recurringTaskRunner: RecurringTaskRunner;
  /** 审批卡点击去重（approval_id 只处理一次） */
  private handledApprovals = new Set<string>();
  /** YYYY-MM-DD → 当日入站消息数（修内审 Optional #8 E7 本日消息统计） */
  private dailyMessageCount = new Map<string, number>();
  /** chat_id → ChannelCli */
  private channels = new Map<string, ChannelCli>();
  /** 常驻工人（医生/工程师/顺子等）：name → WorkerCli。构造时读 workers.json 建实例，不自动拉起。 */
  private workers = new Map<string, WorkerCli>();
  /** 空闲巡检定时器（60s 一轮，检查工人是否空闲超 30 分钟） */
  private workerIdleInterval: NodeJS.Timeout | null = null;
  /** 工人告警节流：name → 最近一次告警时刻（同一工人 30 分钟内只告警一次） */
  private workerAlertedAt = new Map<string, number>();
  /** D1: chat_id → 崩溃熔断计数（实例级，不随 spawnChannelCli 重建闭包清零；stopChannel 才删）。
   *  原为 spawnChannelCli 闭包局部 var，stop→respawn 会重建闭包跳过熔断；提到实例级使熔断跨 respawn 持续。 */
  private crashState = new Map<
    string,
    { count: number; windowStart: number; slowRecoveryActive?: boolean; recoveryCount?: number }
  >();
  /** D3: chat_id → IPC 断线自愈 grace 定时器。断线后等窗口；MCP 自身重连(client-hello)取消之，
   *  否则判定 CLI 僵尸（PTY 活但 MCP/IPC 死）→ 杀掉重生。 */
  private graceTimers = new Map<string, NodeJS.Timeout>();
  /** applyChannelConfigLive 合并重启用的防抖定时器 */
  private liveRestartTimers = new Map<string, NodeJS.Timeout>();
  /** 就绪看门狗：chat_id → spawn 后等首次 IPC hello 的定时器。90s（> MCP_TIMEOUT 60s + CLI 启动余量）
   *  未 hello = CLI 活着但 MCP 连接已被放弃（CLI 对超时 MCP 永不重试）→ 重启该频道自愈。
   *  与 graceTimers 互补：本表管"从未握手"，graceTimers 管"握手过后断线"。 */
  private helloWatchdogs = new Map<string, NodeJS.Timeout>();
  /** D2: chat_id → CLI 未就绪时缓冲的入站消息（带入队时间戳）。CLI ready（client-hello）后 flush 投递。
   *  每 chat 上限 50 条（超丢最旧）、flush 时丢弃入队 > 30min 的过期消息。stopChannel 时清。 */
  private pendingInbound = new Map<string, Array<{ msg: FeishuInboundMessagePayload; enqueuedAt: number }>>();
  /** P1.3: chat_id → 最新 statusLine 推过来的上下文用量 */
  private channelUsage = new Map<string, ChannelUsageInfo>();
  /** 启动器频道列表用：chat_id → 最后一次入站消息时刻（Date.now()，进程内、重启清零）。 */
  private lastActivityAt = new Map<string, number>();
  /** P1.3: ccusage quota 最近一次手动获取 snapshot（删 5min poll 后改按需触发） */
  private lastQuotaSnapshot: QuotaSnapshot | null = null;
  /** 账号级额度（5h+7天，来自任一 CLI statusLine 的 rate_limits）；逐窗口存最新已知值，无数据为 null */
  private lastRateLimits: RateLimits | null = null;
  /** 仪表盘日志流 ring buffer（main.ts pushLog 灌入，warden.recent-logs 读）；上限 300 条 */
  private recentLogs: WardenLogEntry[] = [];
  private started = false;
  private dbPath: string;
  /** name-mappings.json 绝对路径（supervisor 唯一写者；透传给子 CLI env 让两进程读同一文件）。 */
  private nameMapPath: string;
  /** 待命名追踪：解析后仍是纯 ID 兜底（没友好名）的 sender，记一笔供启动器"待命名"面板拉。
   *  key = open_id/cli_id；已在映射里的不记。setNameMappingFromUI 成功后 delete 对应 key。 */
  private pendingNames = new Map<
    string,
    { id: string; chat_id: string; snippet: string; type: 'human' | 'bot'; ts: number }
  >();
  /** 认不出私聊对象名字时的问名提示：已排过队的 chat_id（每进程每频道只问一次，防刷屏）。 */
  private nameAskScheduled = new Set<string>();
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
    // 常驻工人：构造时读 workers.json 建 WorkerCli 实例，不自动拉起（品品 wake_worker 时才 start）
    for (const cfg of loadWorkersConfig(this.opts.dataDir)) {
      const w = new WorkerCli(cfg);
      w.on('crashed', () => {
        this.emit('channel-state-changed');
        void this.notifyWorkerAlert(cfg.name, '进程意外退出');
      });
      this.workers.set(cfg.name, w);
    }
    this.dbPath = path.join(this.opts.appRoot, 'data.db');
    // name-mappings.json 跟 channel-config.json 同源（dataDir = userData），两进程读、supervisor 写
    this.nameMapPath = path.join(this.opts.dataDir, 'name-mappings.json');
    this.cronRunner = new SupervisorCronRunner(this);
    this.recurringTaskRunner = new RecurringTaskRunner({
      filePath: recurringTasksPath(this.dbPath),
      ensureReady: (chatId) => this.ensureChannelReadyForEvent(chatId),
      pushTrigger: (chatId, body, meta) => this.ipcServer.pushChatTrigger(chatId, body, meta),
      notifyOwner: (chatId, text) => this.notifyOwnerDm(chatId, text),
      displayName: (chatId) => this.getChannelDisplayName(chatId),
    });
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

    // ── 0.5 name-map-store init + 首次种子 ──
    // 单一 name-mappings.json，supervisor 写、两进程读（子端靠 mtime 热重载=实时）。
    // 文件不存在时用 .env FEISHU_KNOWN_USERS / FEISHU_BOT_ROSTER 灌种子（已存在则不覆盖用户改的）。
    initNameMapStore(this.nameMapPath);
    {
      // 多飞书应用：合并全部应用的 knownUsers/botRoster 做首次种子（open_id 跨应用天然唯一，无需分桶）
      const mergedKnownUsers: Record<string, string> = {};
      const mergedBotRoster: Record<string, string> = {};
      for (const cfg of this.opts.apps) {
        Object.assign(mergedKnownUsers, parseEnvMap(cfg.knownUsers));
        Object.assign(mergedBotRoster, parseEnvMap(cfg.botRoster));
      }
      seedNameMapIfAbsent(mergedKnownUsers, mergedBotRoster);
    }

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
      // 就绪看门狗：首次握手完成 → 取消
      this.clearHelloWatchdog(info.chat_id);
      // 通知对应 ChannelCli 启动期结束（停止 auto-confirm 启动 prompts）
      this.channels.get(info.chat_id)?.emit('ipc-ready');
      // D2: CLI 已就绪 → flush 该 chat 在未就绪期间缓冲的入站消息
      this.flushPendingInbound(info.chat_id);
      this.emit('channel-mcp-ready', info);
      void this.relayBridge?.deliverDue();
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
    // 多飞书应用：新建的群/单聊归属"发起频道"所属的应用（requesterChatId 是调这个 IPC 的子进程注册 chat_id）
    this.ipcServer.setRequestHandler(IPC_METHODS.SPAWN_CHANNEL, async (params, requesterChatId) => {
      const p = params as SpawnChannelParams;
      if (!p.chat_id) return { ok: false, error: 'missing chat_id' } as WorkOkResult;
      const spawnAppId = requesterChatId ? this.resolveAppId(requesterChatId) : undefined;
      if (p.is_p2p) {
        this.applyNewP2pDefault(p.chat_id, p.peer_open_id);
        if (p.peer_open_id) await this.ensureP2pDisplayName(p.chat_id, p.peer_open_id, spawnAppId);
      }
      this.spawnChannelCli(p.chat_id, p.chat_name, spawnAppId);
      return { ok: true, chat_name: this.channelConfigStore.get(p.chat_id)?.display_name } as SpawnChannelResult;
    });

    // 多飞书应用：跨应用能力集中在 supervisor（子进程只有本 chat 所属应用的 client）
    this.ipcServer.setRequestHandler(IPC_METHODS.LIST_CHATS, async () => {
      const result: ListChatsResult = { chats: this.allChats() };
      return result;
    });
    // 频道间捎话：A 频道的品品不替 B 频道发言，把前因后果推给 B 频道的 CLI（trigger=peer-message），由那边的品品自己决定怎么说。
    // B 离线（睡眠 / 已 evict）→ 先拉起等 hello；两个飞书应用的频道都可互捎。
    // 广播：一件事扇出给相关频道（接收端只更新认知、不外发，规矩在 jiuzhou-ops §13）
    this.ipcServer.setRequestHandler(IPC_METHODS.BROADCAST, async (params, fromChatId) => {
      const p = params as BroadcastParams;
      const delivered: string[] = [];
      const failed: string[] = [];
      if (!p?.text) return { delivered, failed } as BroadcastResult;
      // 硬阻断级联广播：接收端"不转播"目前只是 prompt 约束，模型偶尔失手原样转发会造成雪崩
      // （参考同一批次审批订阅未设硬闸导致的刷屏事故）。同一 kind+text 10 分钟内只放行一次。
      const dedupeKey = `${p.kind}|${p.text}`;
      const now = Date.now();
      const lastSent = this.recentBroadcasts.get(dedupeKey);
      if (lastSent && now - lastSent < 10 * 60 * 1000) {
        process.stderr.write(`[broadcast] 疑似级联/重复广播已丢弃: ${dedupeKey.slice(0, 60)}\n`);
        return { delivered, failed } as BroadcastResult;
      }
      this.recentBroadcasts.set(dedupeKey, now);
      if (this.recentBroadcasts.size > 200) {
        this.recentBroadcasts.delete(this.recentBroadcasts.keys().next().value as string);
      }
      const all = (process.env.PINPIN_BROADCAST_CHAT_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const targets = (p.scope === 'all' ? all : (p.chat_ids ?? [])).filter((id) => id && id !== fromChatId);
      const fromName = this.getChannelDisplayName(fromChatId);
      const body =
        `【广播·${p.kind}】来自「${fromName}」：${p.text}\n` +
        `（只是让你知道。跟本频道无关就 pinpin_no_reply；有关就记住，等对方问起或你下次开口时用得上。` +
        `不要因为这条广播主动在本频道发言，也不要再转播。）`;
      // 各目标互不依赖：并行唤醒 + 投递，避免 scope=all 时挨个 await（每个冷频道最长等 15s，
      // 9 个目标串行=最长 135s 才返回；并行后最长仍是单个 15s）。
      await Promise.all(targets.map(async (chatId) => {
        const targetApp = this.apps.get(this.resolveAppId(chatId));
        const name = this.getChannelDisplayName(chatId);
        if (!targetApp || !isChatAllowed(targetApp.cfg, chatId)) { failed.push(name); return; }
        if (!(await this.ensureChannelReadyForEvent(chatId))) { failed.push(name); return; }
        const ok = this.ipcServer.pushChatTrigger(chatId, body, {
          user: `品品（${fromName}）`,
          sender_type: 'system',
          message_id: `broadcast-${Date.now()}-${chatId.slice(-6)}`,
          trigger: 'broadcast',
          kind: p.kind,
          from_chat_id: fromChatId,
        });
        (ok ? delivered : failed).push(name);
      }));
      const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
      this.appendBroadcastLedger(`${stamp}｜${p.kind}｜${fromName}｜${p.text}｜→ ${delivered.join('、') || '无'}`);
      process.stderr.write(`[broadcast] ${p.kind} from=${fromName} → ${delivered.length} 成功 / ${failed.length} 失败\n`);
      return { delivered, failed } as BroadcastResult;
    });

    this.ipcServer.setRequestHandler(IPC_METHODS.PEER_MESSAGE, async (params, fromChatId) => {
      const p = params as PeerMessageParams;
      if (!p.chat_id || !p.text) return { ok: false, error: 'missing chat_id/text' } as PeerMessageResult;
      if (p.chat_id === fromChatId) return { ok: false, error: '目标就是本频道' } as PeerMessageResult;
      const known = this.channelConfigStore.get(p.chat_id) || this.allChats().some((c) => c.chat_id === p.chat_id);
      if (!known) return { ok: false, error: `未知频道 ${p.chat_id.slice(-8)}（用 list_active_chats 查）` } as PeerMessageResult;
      const targetApp = this.apps.get(this.resolveAppId(p.chat_id));
      if (!targetApp || !isChatAllowed(targetApp.cfg, p.chat_id)) {
        return { ok: false, error: '目标频道已不在服务范围' } as PeerMessageResult; // allowlist 收紧后的旧群不再被捎话拉起
      }
      if (!(await this.ensureChannelReadyForEvent(p.chat_id))) {
        return { ok: false, error: '目标频道拉不起来' } as PeerMessageResult;
      }
      const fromName = this.getChannelDisplayName(fromChatId);
      const toName = this.getChannelDisplayName(p.chat_id);
      // verbatim=true（ask_person 回复转发等）：原文送达，不加"自行判断怎么说"外壳
      const body = p.verbatim
        ? p.text
        : `【来自「${fromName}」频道的你捎的话】${p.text}\n（先弄清前因后果，按本频道的关系和语气决定说不说、怎么说，不要原样复读。）`;
      const pushed = this.ipcServer.pushChatTrigger(p.chat_id, body, {
        ...(p.meta ?? {}), // 附加 meta 放前面，固定字段不被覆盖
        user: `品品（${fromName}）`,
        sender_type: 'system',
        message_id: `peer-${Date.now()}-${fromChatId.slice(-6)}`,
        trigger: p.trigger ?? 'peer-message',
        from_chat_id: fromChatId,
      });
      process.stderr.write(`[supervisor] peer-message ${fromChatId.slice(-8)} → ${p.chat_id.slice(-8)} ${pushed ? 'ok' : 'push 失败'}\n`);
      return (pushed ? { ok: true, chat_name: toName } : { ok: false, error: 'IPC push 失败' }) as PeerMessageResult;
    });

    // 解散群后停该频道 CLI（stopChannel：stop CLI + 从 channels 删除 + 删配置，不再重 spawn）
    this.ipcServer.setRequestHandler(IPC_METHODS.STOP_CHANNEL, async (params) => {
      const p = params as StopChannelParams;
      if (!p.chat_id) return { ok: false, error: 'missing chat_id' } as WorkOkResult;
      const ok = this.stopChannel(p.chat_id);
      return { ok } as WorkOkResult;
    });

    // 彻底删除频道（delete_channel tool）：群→自建解散/否则退群，私聊→只清本地
    this.ipcServer.setRequestHandler(IPC_METHODS.DELETE_CHANNEL, async (params) => {
      return this.deleteChannel(params as DeleteChannelParams);
    });

    // 记人名（set_person_name tool）：写认人表 + 私聊无名时补显示名
    this.ipcServer.setRequestHandler(IPC_METHODS.SET_PERSON_NAME, async (params) => {
      const p = params as SetPersonNameParams;
      if (!p.open_id || !p.name) return { ok: false, error: 'missing open_id/name' } as WorkOkResult;
      setNameMapping('human', p.open_id, p.name);
      if (p.chat_id) {
        const persisted = this.channelConfigStore.get(p.chat_id)?.display_name;
        if (!persisted || persisted.includes('ou_')) {
          const displayName = `VS ${p.name}（私聊）`;
          this.channelConfigStore.set(p.chat_id, { display_name: displayName });
          this.channels.get(p.chat_id)?.setChatName(displayName);
          this.emit('channel-state-changed', p.chat_id);
        }
      }
      return { ok: true } as WorkOkResult;
    });

    // 叫醒常驻工人会话（wake_worker tool）
    this.ipcServer.setRequestHandler(IPC_METHODS.WAKE_WORKER, async (params) => {
      const p = params as WakeWorkerParams;
      if (!p?.name) return { ok: false, error: 'missing name' } as WakeWorkerResult;
      return this.wakeWorker(p.name);
    });

    // ── 3+4+4.5 多飞书应用：每个 app 各自 init client + FeishuPoll + FeishuEventSubscriber ──
    // poll 与 WS 双轨并存不能动：飞书 chat.list 不返 P2P + 事件订阅不推 bot 消息 = 平台约束必然
    for (const cfg of this.opts.apps) {
      const client = initFeishuClient(cfg.appId, cfg.appSecret);
      const allowed = (chatId: string) => isChatAllowed(cfg, chatId);
      const poll = new FeishuPoll(
        // isOwnApp：多应用同群时，另一应用里的品品发言也是"自己"，不能当别的 bot 回灌
        { appId: cfg.appId, client, isChatAllowed: allowed, isOwnApp: (id) => this.apps.has(id) },
        {
          onMessage: (msg) => this.onFeishuMessage(msg),
          onChatListDiff: (diff) => this.onChatListDiff(diff, cfg.appId),
        },
      );
      await poll.start();

      const subscriber = new FeishuEventSubscriber({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        isChatAllowed: allowed,
        onMessage: (msg) => this.onFeishuMessage(msg),
        onPollAction: (evt, val) => this.onPollAction(evt, val),
        onApprovalAction: (evt, val) => this.onApprovalAction(evt, val, cfg.appId),
        onReaction: (evt) => this.onReaction(evt, cfg.appId),
        onBotAdded: (evt) => this.onBotAdded(evt, cfg.appId),
        onComment: (evt) => this.onComment(evt),
        onApprovalEvent: (evt) => this.onApprovalEvent(evt, cfg.appId),
        onP2pEntered: (chatId, openId) => this.onP2pEntered(chatId, openId, cfg.appId),
        onAttendanceEvent: (evt) => this.onAttendanceEvent(evt, cfg.appId),
      });
      try {
        await subscriber.start();
      } catch (e) {
        // 事件订阅启动失败不阻塞 supervisor 启动（poll 仍跑）—— 飞书后台未开权限时 graceful degradation
        process.stderr.write(
          `[supervisor] FeishuEventSubscriber(app=${cfg.label}) 启动失败 (poll 继续工作): ${e instanceof Error ? e.message : e}\n`,
        );
      }

      this.apps.set(cfg.appId, { cfg, poll, subscriber });
    }

    // 审批事件只推已订阅的定义：豆姐私聊所属应用按 vault 清单逐个订阅（幂等）。
    // 必须等所有 app 都进 this.apps 之后再解析归属——在上面的 for 循环里解析时 apps 还没齐，
    // resolveAppId 会回落 primary，结果拿「个人」应用去订Client的审批定义，全部报 approval code not found。
    const ownerAppId = this.resolveAppId(process.env.PINPIN_OWNER_CHAT_ID ?? '');
    const ownerApp = this.apps.get(ownerAppId);
    if (ownerApp) {
      const defs = readApprovalDefinitions(this.opts.vaultCwd);
      if (defs.length) {
        void subscribeApprovalDefinitions(getFeishuClient(ownerAppId), defs).then((n) =>
          process.stderr.write(`[approval] app=${ownerApp.cfg.label} 订阅审批定义 ${n}/${defs.length}\n`),
        );
      }
    }

    // ── 5. 已识别的所有 chat 自动 spawn 频道 CLI（启动器一打开即全部上线）──
    this.spawnAllKnownChannels();

    // ── 5.5 supervisor 内嵌 cron（2026-05-28 多 CLI 决策）：
    //         feishu-token-keepalive / daily-restart 编排
    //         这 2 个不依赖 CLI 在线，统一在 main process 跑（避免 N 个 CLI 重复触发） ──
    this.cronRunner.start();
    this.recurringTaskRunner.start();

    // ── 5.6 管家口 47900 + 传话口 47901（固定端口、共用本机口令；旁路，失败不崩品品）──
    let bridgeToken = '';
    try {
      bridgeToken = ensureBridgeToken();
    } catch (e) {
      process.stderr.write(`[supervisor] 桥接口令生成失败，管家口 / 传话口不开: ${e instanceof Error ? e.message : e}\n`);
    }
    try {
      if (!bridgeToken) throw new Error('无口令');
      this.wardenBridge = await createWardenBridge({
        getChannels: () => this.channels,
        getDisplayChannels: () => this.getDisplayChannels(),
        applyChannelConfigLive: (chatId, patch) => this.applyChannelConfigLive(chatId, patch),
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
        // 批4 全局设置 + 系统 + 日志
        getDefaults: () => ({
          channel: {
            model: this.opts.defaultModel,
            effort: this.opts.defaultEffort,
            fast: this.opts.defaultFast ?? false,
            autoCompactPct: this.opts.defaultAutoCompactPct,
          },
        }),
        setDefaults: (patch) => this.setDefaults(patch),
        restartSupervisor: () => this.restart(),
        quitApp: () => this.emit('warden-request-quit'),
        getRecentLogs: (limit) => this.recentLogs.slice(-limit),
      }, bridgeToken);
    } catch (e) {
      process.stderr.write(
        `[supervisor] warden-bridge 启动失败（不影响品品主功能）: ${e instanceof Error ? e.message : e}\n`,
      );
    }
    if (bridgeToken) {
      const relay = new RelayBridge({
        dataDir: this.opts.dataDir,
        token: bridgeToken,
        pushTrigger: async (chatId, body, meta) =>
          (await this.ensureChannelReadyForEvent(chatId)) && this.ipcServer.pushChatTrigger(chatId, body, meta),
        listChats: () => [
          ...this.allChats().map((c) => ({ chat_id: c.chat_id, name: c.name ?? c.chat_id })),
          ...this.channelConfigStore.listChatIds().map((id) => ({ chat_id: id, name: this.getChannelDisplayName(id) })),
        ],
        humans: () => getAllMappings().humans,
        ownerOpenIds: () => this.opts.apps.map((a) => a.ownerOpenId).filter((id): id is string => !!id),
        ownerChatId: () => process.env.PINPIN_OWNER_CHAT_ID,
        notifyOwner: (chatId, text) => this.notifyOwnerDm(chatId, text),
      });
      try {
        await relay.start();
        relay.attachChannelIpc(this.ipcServer);
        this.relayBridge = relay;
      } catch (e) {
        await relay.stop().catch(() => {});
        process.stderr.write(`[supervisor] relay-bridge 启动失败（不影响品品主功能）: ${e instanceof Error ? e.message : e}\n`);
      }
    }

    // ── 5.7 常驻工人空闲巡检（60s 一轮；awake 超 30min 无输出 + transcript 也早于 30min → stop）──
    this.workerIdleInterval = setInterval(() => this.checkWorkersIdle(), 60_000);

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
    // 最优先同步树杀所有频道 CLI（放在任何 await 之前：即便后续异步收尾卡住、
    // 或 Electron 抢着退出，taskkill /F /T 也已先发，绝不留孤儿 claude.exe / MCP server）。
    for (const cli of this.channels.values()) cli.stop();
    this.channels.clear();
    for (const w of this.workers.values()) w.stop();
    if (this.workerIdleInterval) {
      clearInterval(this.workerIdleInterval);
      this.workerIdleInterval = null;
    }
    // 清所有就绪看门狗（restart() 复用实例，防 stale 定时器带旧 cli 引用晚触发）
    for (const t of this.helloWatchdogs.values()) clearTimeout(t);
    this.helloWatchdogs.clear();
    // 清所有断线自愈 grace 定时器（同理防 stale 定时器晚触发误杀新 CLI）
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const t of this.liveRestartTimers.values()) clearTimeout(t);
    this.liveRestartTimers.clear();
    this.cronRunner.stop();
    this.recurringTaskRunner.stop();
    await this.ccusagePoller.stop();
    for (const { poll, subscriber } of this.apps.values()) {
      await poll.stop();
      await subscriber.stop();
    }
    this.apps.clear();
    await this.ipcServer.stop();
    await this.wardenBridge?.stop();
    this.wardenBridge = null;
    await this.relayBridge?.stop();
    this.relayBridge = null;
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
      if (ch.status === 'running' && this.ipcServer.hasClient(chatId)) {
        // 上次尝试已稳定运行满 5min 且 MCP 已握手 → 自愈成功，重置熔断状态
        // （仅 running 不够：聋频道 = running 但无 IPC client，不能误判成功）
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
      if (ch.status === 'failed') {
        ch.start();
      } else if (ch.status === 'running' && !this.ipcServer.hasClient(chatId)) {
        // 聋频道（running 但从未/不再握手）→ stop 后延迟重启（与就绪看门狗同路径，同款 jitter 错峰）
        ch.stop();
        setTimeout(() => {
          const c = this.channels.get(chatId);
          if (c === ch && c.status === 'stopped') c.start();
        }, 1_500 + Math.floor(Math.random() * 3_000));
      }
      this.scheduleSlowRecovery(chatId);
    }, 5 * 60_000);
  }

  /** 频道自愈耗尽时给该 chat 发飞书提示——不静默死。复用 supervisor 持有的 Lark 单例。 */
  private async notifyChannelDown(chatId: string): Promise<void> {
    try {
      await getFeishuClient(this.resolveAppId(chatId)).im.v1.message.create({
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

  /** 广播反级联去重：kind+text → 最近发出时间，防同一条内容被原样转播成雪崩（见 BROADCAST handler）。 */
  private recentBroadcasts = new Map<string, number>();

  /** 广播底账：一行一条追加到 vault `Client\广播板.md`，只留最近 200 条（重启后能回看，不占上下文）。 */
  private appendBroadcastLedger(line: string): void {
    try {
      const file = path.join(this.opts.vaultCwd, 'Client', '广播板.md');
      const head = '# 广播板\n\n<!-- 各频道品品的广播底账，supervisor 自动追加，只留最近 200 条。找历史看这里，别问别的频道。 -->\n\n';
      const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : head;
      const kept = prev.split('\n').filter((l) => l.startsWith('- ')).slice(-199);
      fs.writeFileSync(file, head + [...kept, `- ${line}`].join('\n') + '\n', 'utf8');
    } catch (e) {
      process.stderr.write(`[broadcast] 广播板写入失败: ${e instanceof Error ? e.message : e}\n`);
    }
  }

  /** 固定任务连续触发失败时私聊 owner 告警（该 chat 所属应用的 ownerOpenId，无则静默）。 */
  private async notifyOwnerDm(chatId: string, text: string): Promise<void> {
    const app = this.appForChat(chatId);
    if (!app.ownerOpenId) return;
    try {
      await getFeishuClient(app.appId).im.v1.message.create({
        data: { receive_id: app.ownerOpenId, msg_type: 'text', content: JSON.stringify({ text }) },
        params: { receive_id_type: 'open_id' },
      });
    } catch (e) {
      process.stderr.write(`[supervisor] notifyOwnerDm 失败 chat=${chatId.slice(-8)}: ${e instanceof Error ? e.message : e}\n`);
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

  /** 就绪看门狗上膛：每次 CLI spawn（'started'）后调。150s 内（= MCP_TIMEOUT 120s + 30s 余量）该 chat 首次 IPC hello 到达则由
   *  clearHelloWatchdog 取消；到点仍无 hello 且 CLI 还"活着"（running 但无 IPC client）→ 记一次故障
   *  （与崩溃共用熔断，防无限循环）→ stop + 重启。二次启动时 IO 风暴已过，大概率快速握手成功。 */
  private armHelloWatchdog(chatId: string, cli: ChannelCli): void {
    this.clearHelloWatchdog(chatId);
    const timer = setTimeout(() => {
      this.helloWatchdogs.delete(chatId);
      if (this.channels.get(chatId) !== cli) return; // 已被 evict / 替换
      if (cli.status !== 'running') return; // 崩溃/停止路径已接管
      if (this.ipcServer.hasClient(chatId)) return; // 已握手（保险二查）
      process.stderr.write(
        `[supervisor] channel ${chatId.slice(-8)} spawn 后 150s 未完成 MCP 握手（CLI 已放弃连接且不重试）→ 自动重启该频道\n`,
      );
      if (!this.registerFaultAndShouldRestart(chatId)) return; // 熔断中→转慢速自愈链，不硬重启
      cli.stop();
      // 1.5s 基础 + 0~3s 随机 jitter：多频道同 tick 触发看门狗时错峰重 spawn，防重演并发 IO 风暴
      setTimeout(() => {
        const ch = this.channels.get(chatId);
        if (ch === cli && ch.status === 'stopped') ch.start();
      }, 1_500 + Math.floor(Math.random() * 3_000));
    }, 150_000);
    this.helloWatchdogs.set(chatId, timer);
  }

  private clearHelloWatchdog(chatId: string): void {
    const t = this.helloWatchdogs.get(chatId);
    if (t) {
      clearTimeout(t);
      this.helloWatchdogs.delete(chatId);
    }
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
      void getFeishuClient(this.resolveAppId(chatId))
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

  isRunning(): boolean {
    return this.started;
  }

  getIpcPort(): number {
    return this.ipcServer.getPort();
  }

  /** 多飞书应用：合并全部应用当前已知的 chat（带 app_id/app_label），供 list_active_chats / 面板用。 */
  allChats(): ChatSummary[] {
    const out: ChatSummary[] = [];
    for (const { cfg, poll } of this.apps.values()) {
      for (const c of poll.getChats()) {
        out.push({ chat_id: c.chat_id, name: c.name, app_id: cfg.appId, app_label: cfg.label });
      }
    }
    return out;
  }

  /** 某 chat 归属哪个飞书应用：① channel-config.json 已钉死的 appId（仍在 apps 中）→
   *  ② 遍历各 app 的 chat.list 命中即写回钉死 → ③ 都未命中 → primary + WARN（fail-open，不阻断投递）。 */
  resolveAppId(chatId: string): string {
    const persistedAppId = this.channelConfigStore.get(chatId)?.appId;
    if (persistedAppId && this.apps.has(persistedAppId)) return persistedAppId;
    for (const { cfg, poll } of this.apps.values()) {
      if (poll.getChats().some((c) => c.chat_id === chatId)) {
        this.channelConfigStore.markSeen(chatId, cfg.appId);
        return cfg.appId;
      }
    }
    process.stderr.write(
      `[supervisor] resolveAppId(${chatId.slice(-8)}) 未命中任何应用的 chat.list，回落 primary（WARN）\n`,
    );
    return this.primaryApp.appId;
  }

  /** cron-runner 用：某 chat（如Owner DM）归属哪个应用的完整配置。 */
  appForChat(chatId: string): FeishuAppConfig {
    return this.apps.get(this.resolveAppId(chatId))?.cfg ?? this.primaryApp;
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
    const chat = this.allChats().find((c) => c.chat_id === chatId);
    if (chat?.name) return chat.name;
    return chatId.slice(-8);
  }

  getChannelCliStats(): Array<ReturnType<ChannelCli['getStats']>> {
    return [...this.channels.values()].map((c) => c.getStats());
  }

  /** 该 chat 归属飞书应用的 label（供启动器频道列表分组；resolveAppId 命不中时回落 primary，仍能拿到某个 label）。 */
  private appLabelFor(chatId: string): string | undefined {
    return this.apps.get(this.resolveAppId(chatId))?.cfg.label;
  }

  /** 启动器「展示用」频道列表 = 已 spawn 的真实状态 + 已识别但未 spawn（如待机）的合成"停止卡"。 */
  getDisplayChannels(): Array<
    ReturnType<ChannelCli['getStats']> & { app_label?: string; last_activity_at?: number; pending_count?: number }
  > {
    // 盖 standby 戳：已 spawn 的（含被消息唤醒、当前 running 的睡眠频道）从 configStore 读，
    // 让卡片即使 running 也显示"睡眠"徽章（renderChannelCard 渲染，提示归属睡眠：4 点重启不上线、靠消息唤醒）。
    const spawned = this.getChannelCliStats().map((s) => ({
      ...s,
      standby: this.channelConfigStore.isStandby(s.chat_id),
      app_label: this.appLabelFor(s.chat_id),
      last_activity_at: this.lastActivityAt.get(s.chat_id),
      pending_count: this.pendingInbound.get(s.chat_id)?.length ?? 0,
    }));
    const seen = new Set(spawned.map((c) => c.chat_id));
    const out = [...spawned];
    const knownIds: string[] = [];
    for (const c of this.allChats()) knownIds.push(c.chat_id);
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
        app_label: this.appLabelFor(chatId),
        last_activity_at: this.lastActivityAt.get(chatId),
        pending_count: this.pendingInbound.get(chatId)?.length ?? 0,
      });
    }
    return out;
  }

  getChannel(chatId: string): ChannelCli | undefined {
    return this.channels.get(chatId);
  }

  /** spawn 所有已识别频道（飞书 chat.list + channel-config 持久化的，跳过睡眠归属）。start() 调（启动器一开全上线）、
   *  04:10 daily-restart 调（把被 /下线 evict 出 Map 的常驻频道也重新拉起）。spawnChannelCli 幂等，已在 Map 的跳过。 */
  /** 错峰启动共用闸的下一空档时间戳。多频道 CLI+MCP 同 tick 齐开会造成 IO 风暴，
   *  dist/mcp/server.js 启动被拖过 MCP 连接超时线 → 频道聋（同一根因也是就绪看门狗防的）。 */
  private nextStaggerAt = 0;

  /** 把一次频道启动动作排进错峰队列：与上一个排入动作至少隔 8s（空闲时立即执行；单频道 MCP 冷启动实测 12~30s，2s 盖不住重叠）。
   *  app 启动 spawnAllKnownChannels 与 04:10 daily-restart startStoppedChannelsStaggered 共用本闸，
   *  两批混排也整体错峰。action 内部自带幂等/状态防御查。 */
  private staggerChannelBoot(action: () => void): void {
    const now = Date.now();
    const at = Math.max(now, this.nextStaggerAt);
    this.nextStaggerAt = at + 8_000;
    const delay = at - now;
    if (delay <= 0) {
      action();
    } else {
      setTimeout(() => {
        if (this.started) action();
      }, delay);
    }
  }

  /** 04:10 daily-restart 用：把 Map 内 status=stopped 的常驻频道错峰 start()（03:55 stop 不 evict 的那批）。 */
  startStoppedChannelsStaggered(): void {
    for (const [chatId, cli] of this.channels) {
      if (cli.status !== 'stopped') continue;
      this.staggerChannelBoot(() => {
        const ch = this.channels.get(chatId);
        if (ch === cli && ch.status === 'stopped') ch.start();
      });
    }
  }

  spawnAllKnownChannels(): void {
    // 本轮已排队集合：5a 排入的多数是延迟执行（尚未进 channels Map），5b 靠 channels.has 查不到，
    // 用显式集合防同一 chatId 双占错峰槽位（活跃频道几乎必然同时在两份名单里）
    const queued = new Set<string>();
    // 5a. 飞书 chat.list 拿到的群（各 app 已过滤 allowlist，含 app_id；含Owner已加入的群聊）
    for (const c of this.allChats()) {
      if (this.channelConfigStore.isStandby(c.chat_id)) continue; // 待机频道不自动拉起（有人说话才唤醒）
      if (this.channels.has(c.chat_id)) continue; // 已在 Map（spawnChannelCli 本就幂等）→ 不占错峰槽位
      queued.add(c.chat_id);
      this.staggerChannelBoot(() => {
        if (!this.channels.has(c.chat_id)) this.spawnChannelCli(c.chat_id, c.name, c.app_id);
      });
    }
    // 5b. 频道常驻：channel-config.json 持久化但飞书 chat.list 没返的（P2P 单聊 / 历史已识别群）
    const persistedIds = this.channelConfigStore.listChatIds();
    for (const chatId of persistedIds) {
      if (queued.has(chatId)) continue; // 5a 本轮已排队跳过
      if (this.channels.has(chatId)) continue; // 已在 Map 跳过
      if (this.channelConfigStore.isStandby(chatId)) continue; // 待机频道不自动拉起
      const persisted = this.channelConfigStore.get(chatId);
      const appId = persisted?.appId ?? this.primaryApp.appId;
      const appEntry = this.apps.get(appId);
      if (!appEntry || !isChatAllowed(appEntry.cfg, chatId)) continue; // 应用已下线 / allowlist 已收紧 → 不拉起
      this.staggerChannelBoot(() => {
        if (!this.channels.has(chatId)) this.spawnChannelCli(chatId, persisted?.display_name, appId);
      });
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
      const chat = this.allChats().find((c) => c.chat_id === chatId);
      this.spawnChannelCli(chatId, chat?.name ?? this.channelConfigStore.get(chatId)?.display_name, chat?.app_id);
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

  spawnChannelCli(chatId: string, chatName?: string, appId?: string): ChannelCli {
    let cli = this.channels.get(chatId);
    if (cli) return cli;
    // 多飞书应用：该 chat 归属哪个应用（未显式传入则 resolveAppId 反查/回落 primary）
    const app = this.apps.get(appId ?? this.resolveAppId(chatId))?.cfg ?? this.primaryApp;
    // 频道常驻持久化：首次见到该 chat_id 就在 channel-config.json 落 seen=true 标记 + 钉死 appId 归属，
    // 下次重启 start() step 5b 会遍历持久列表自动恢复（含 P2P 单聊）
    this.channelConfigStore.markSeen(chatId, app.appId);
    // P1.2: 优先 persisted config，fallback defaults
    const persisted = this.channelConfigStore.get(chatId);
    // 群名首次见到即落盘：启动器显示与对话记录目录名都从 display_name 取，群改名不再另起目录（Owner改名走启动器）
    if (!persisted?.display_name && chatName && !chatName.startsWith('oc_')) {
      this.channelConfigStore.set(chatId, { display_name: chatName });
    }
    const effectiveChatName = this.channelConfigStore.get(chatId)?.display_name ?? chatName;
    cli = new ChannelCli({
      chatId,
      chatName: effectiveChatName,
      vaultCwd: this.opts.vaultCwd,
      model: persisted?.model ?? this.opts.defaultModel,
      effort: persisted?.effort ?? this.opts.defaultEffort,
      autoCompactPct: persisted?.autoCompactPct ?? this.opts.defaultAutoCompactPct,
      fast: persisted?.fast ?? this.opts.defaultFast ?? false,
      addDirs: persisted?.addDirs ?? app.addDirs,
      voiceDice: persisted?.voiceDice,
      supervisorPort: this.ipcServer.getPort(),
      dbPath: this.dbPath,
      nameMapPath: this.nameMapPath,
      // P1.3: statusLine sink 绝对路径
      statusLineSinkPath: path.join(this.opts.appRoot, 'scripts', 'statusline-sink.cjs'),
      app,
      isDm: chatId === process.env.PINPIN_OWNER_CHAT_ID,
      primaryAppId: this.primaryApp.appId,
    });
    // P1.2: 事件驱动 state push（替代 1Hz 心跳 race）—— 状态变即向 main 推
    cli.on('started', () => {
      // 就绪看门狗：每次 spawn 都上膛，首次 IPC hello 时取消（client-hello handler 调 clear）
      this.armHelloWatchdog(chatId, cli);
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
      this.clearHelloWatchdog(chatId); // 主动停止 → 看门狗随之撤（watchdog 自身重启路径除外，其到点前已 delete）
      this.emit('channel-state-changed', chatId);
    });
    cli.on('failed', () => this.emit('channel-state-changed', chatId));
    // 2026-05-28 多 CLI 兜底：PTY 异常退出（非用户主动 stop）→ 自动重启（带 5s 退避防雪崩）
    // 5min 内连续崩 3 次 → 停止自动重启，等Owner手动 [↻]
    // D1: 计数存 this.crashState（实例级，key=chatId），不随闭包重建清零
    cli.on('crashed', () => {
      this.channelUsage.delete(chatId);
      this.clearHelloWatchdog(chatId); // PTY 已死 → 本次 spawn 的看门狗作废（respawn 的 'started' 会重新上膛）
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

  /** 改模型/effort/压缩/fast 后「续接重启」立即生效：写配置 + 若该频道正在跑（running/starting）
   *  则 reload 进 opts 后 --resume 接回原对话（非"重启清零"），而不是等Owner手动重启。 */
  applyChannelConfigLive(chatId: string, patch: { model?: string; effort?: string; autoCompactPct?: number; fast?: boolean }): void {
    this.setChannelConfig(chatId, patch);
    // 弹窗里连着改几项只重启一次：1.5s 内的后续改动合并
    const prev = this.liveRestartTimers.get(chatId);
    if (prev) clearTimeout(prev);
    this.liveRestartTimers.set(chatId, setTimeout(() => {
      this.liveRestartTimers.delete(chatId);
      const cli = this.channels.get(chatId);
      if (cli && (cli.status === 'running' || cli.status === 'starting')) {
        this.reloadChannelConfigInto(chatId);
        cli.restart({ resume: true });
      }
    }, 1500));
    this.emit('channel-state-changed', chatId);
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
    if (persisted.fast !== undefined) cli.setFast(persisted.fast);
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

  /** D2: CLI ready（client-hello）后 flush 该 chat 缓冲队列：丢弃入队 > 30min 的过期消息，其余重走 push 路径。 */
  private flushPendingInbound(chatId: string): void {
    const queue = this.pendingInbound.get(chatId);
    if (!queue || queue.length === 0) return;
    this.pendingInbound.delete(chatId);
    const now = Date.now();
    // 30 分钟：覆盖每日 03:55–04:10 停机重启窗口，窗口内积压的消息不被判过期丢弃
    const TTL = 30 * 60_000;
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
      if (msg.is_p2p) {
        this.applyNewP2pDefault(msg.chat_id, msg.sender_open_id);
        void this.ensureP2pDisplayName(msg.chat_id, msg.sender_open_id, msg.app_id).then((found) => {
          // 查不到名字 → 30s 后若仍未补上，提醒品品礼貌问一句（每进程每频道只问一次）
          if (found || this.nameAskScheduled.has(msg.chat_id)) return;
          this.nameAskScheduled.add(msg.chat_id);
          setTimeout(() => {
            if (this.channelConfigStore.get(msg.chat_id)?.display_name) return; // 期间已补上
            this.ipcServer.pushChatTrigger(
              msg.chat_id,
              `【系统】还没认出这位私聊对象的名字（open_id=${msg.sender_open_id}）。找个自然的时机礼貌问一句怎么称呼，问到后调 set_person_name 记下。`,
              { user: '系统', sender_type: 'system', message_id: `name-ask-${msg.chat_id}`, trigger: 'name-ask' },
            );
          }, 30_000);
        });
      }
      this.spawnChannelCli(msg.chat_id, guessName, msg.app_id);
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
      const resolved = resolveSenderNameSync(msg.sender_open_id, msg.sender_type, msg.app_id);
      // 机器人（sender_type=app，如飞书智能纪要助手）不进待命名，只给人补名字
      if (!isBot && resolved === msg.sender_open_id.slice(-8)) {
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
      this.allChats().find((c) => c.chat_id === msg.chat_id)?.name;
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
    // 启动器频道列表"最后活动"用；channel-state-changed 已有 100ms 防抖在 main.ts pushState 侧，
    // 高频入站不会导致 renderer 被刷爆。
    this.lastActivityAt.set(msg.chat_id, Date.now());
    this.emit('channel-state-changed', msg.chat_id);
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
    const pollApp = this.apps.get(this.resolveAppId(chatId));
    if (!pollApp || !isChatAllowed(pollApp.cfg, chatId)) return; // 不在 allowlist 的群点票不拉 CLI
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
      await this.apps.get(this.resolveAppId(chatId))!.subscriber.updateCard(messageId, newCard);
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

  /**
   * 审批卡按钮点击：only_owner 非 owner 点 → 卡片提示、不推；否则去重后把卡片刷成已决，
   * 再把结果以 trigger=approval-result 推回发起频道（离线先拉起）。
   */
  private async onApprovalAction(evt: CardActionEvent, val: ApprovalCardValue, appId: string): Promise<void> {
    const { approval_id, origin_chat_id, choice, tag, only_owner, title } = val;
    const clicker = evt.operator.openId;
    const app = this.apps.get(appId);
    if (!app || !isChatAllowed(app.cfg, origin_chat_id)) return;
    const clickerName = resolveSenderNameSync(clicker, 'user', appId);
    try {
      if (only_owner && clicker !== app.cfg.ownerOpenId) {
        await app.subscriber.updateCard(evt.messageId, buildApprovalCard(title, val.lines ?? [], val.buttons ?? [], val, { note: `仅豆姐可点（${clickerName} 点了不算）` }));
        return;
      }
      if (this.handledApprovals.has(approval_id)) return;
      this.handledApprovals.add(approval_id);
      const chosenLabel = val.buttons?.find((b) => b.choice === choice)?.label ?? choice;
      await app.subscriber.updateCard(evt.messageId, buildApprovalCard(title, val.lines ?? [], [], val, { by: clickerName, choice_label: chosenLabel }));
      if (!(await this.ensureChannelReadyForEvent(origin_chat_id, appId))) {
        process.stderr.write(`[supervisor] approval ${approval_id}: 发起频道 ${origin_chat_id.slice(-8)} 拉不起来，结果未送达\n`);
        return;
      }
      this.ipcServer.pushChatTrigger(
        origin_chat_id,
        `【审批结果】${clickerName} 在「${title}」选择了「${choice}」${tag ? `（${tag}）` : ''}。按之前约定继续处理。`,
        {
          user: clickerName,
          sender_type: 'human',
          message_id: `approval-${approval_id}-${clicker.slice(-6)}`,
          trigger: 'approval-result',
          approval_id,
          choice,
          clicker_open_id: clicker,
          clicker_name: clickerName,
          tag: tag ?? '',
        },
      );
    } catch (e) {
      process.stderr.write(`[supervisor] onApprovalAction error: ${e instanceof Error ? e.message : e}\n`);
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
      merge_forward: '合并转发', location: '位置', todo: '任务', vote: '投票', hongbao: '红包',
      video_chat: '视频会议', folder: '文件夹', calendar: '日程', share_calendar_event: '日程', general_calendar: '日程',
    };
    return `非文字内容·${labels[msgType] ?? msgType}`;
  }

  /** reaction 事件无 chat_id 也无"被点消息发送者/内容" → 先查缓存，未命中调飞书 message.get 反查
   *  （一次拿 chat_id + 发送者 + 内容摘要；in-flight 去重防风暴） */
  private async resolveReactedMsg(
    messageId: string,
    appId: string,
  ): Promise<{ chatId: string; senderId: string; senderType: 'user' | 'app'; snippet: string } | null> {
    const cached = this.msgIdToInfo.get(messageId);
    if (cached) return cached;
    const inflight = this.msgInfoResolveInflight.get(messageId);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const res = await getFeishuClient(appId).im.v1.message.get({ path: { message_id: messageId } });
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

  /**
   * 新私聊默认睡眠：首次见到的 p2p chat（还没有 channel-config）→ standby=true（有人说话仍会被唤醒送达，只是 04:10 不自动上线）。
   * 豁免：Owner单聊（PINPIN_OWNER_CHAT_ID）+ env PINPIN_P2P_ALWAYS_ON_OPEN_IDS（CSV open_id，组员）。已 seen 的旧私聊不动，之后由启动器开关决定。
   */
  private applyNewP2pDefault(chatId: string, peerOpenId?: string): void {
    if (chatId === process.env.PINPIN_OWNER_CHAT_ID || this.channelConfigStore.get(chatId)) return;
    if (peerOpenId && this.alwaysOnOpenIds().includes(peerOpenId)) return;
    this.channelConfigStore.setStandby(chatId, true);
    process.stderr.write(`[supervisor] 新私聊 ${chatId.slice(-8)} 默认睡眠（peer=${peerOpenId?.slice(-6) ?? '?'}）\n`);
  }

  /** 常驻私聊豁免名单（env PINPIN_P2P_ALWAYS_ON_OPEN_IDS，CSV open_id）。applyNewP2pDefault / onP2pEntered 共用。 */
  private alwaysOnOpenIds(): string[] {
    return (process.env.PINPIN_P2P_ALWAYS_ON_OPEN_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  /**
   * 新私聊自动落显示名 `VS <全名>（私聊）`：全名按 认人表 → env → 飞书通讯录 API 反查；查到的同时写进认人表，
   * 让对话记录目录用同一个名字。查不到（应用无权限）→ 不落，留给启动器"待命名"。
   */
  /** 返回 true = 已有名（含刚查到落盘）；false = 查不到，需靠 set_person_name 补（onFeishuMessage 据此推问名提示）。 */
  private async ensureP2pDisplayName(chatId: string, peerOpenId: string, appId?: string): Promise<boolean> {
    if (chatId === process.env.PINPIN_OWNER_CHAT_ID || this.channelConfigStore.get(chatId)?.display_name) return true;
    try {
      const name = await resolveUserNameAsync(peerOpenId, appId);
      if (!name) return false;
      if (!getHumanNameMapping(peerOpenId)) setNameMapping('human', peerOpenId, name);
      this.channelConfigStore.set(chatId, { display_name: `VS ${name}（私聊）` });
      this.channels.get(chatId)?.setChatName(`VS ${name}（私聊）`);
      process.stderr.write(`[supervisor] 私聊 ${chatId.slice(-8)} 显示名 → VS ${name}（私聊）\n`);
      return true;
    } catch (e) {
      process.stderr.write(`[supervisor] ensureP2pDisplayName 失败 ${chatId.slice(-8)}: ${e instanceof Error ? e.message : e}\n`);
      return false;
    }
  }

  /**
   * 品品打开的私聊被对方"进入会话"（bot_p2p_chat_entered_v1，无消息内容，纯打开动作）。
   * 仅常驻豁免名单里的人打开会话才建频道（普通人只打开不说话不建，等他发消息才走热路径）；
   * 已有配置或已 spawn 的不重复处理。不推任何 trigger、不发任何消息——纯静默挂号。
   */
  private async onP2pEntered(chatId: string, openId: string, appId: string): Promise<void> {
    if (this.channelConfigStore.get(chatId) || this.channels.has(chatId)) return;
    if (!this.alwaysOnOpenIds().includes(openId)) return;
    const appEntry = this.apps.get(appId);
    if (!appEntry || !isChatAllowed(appEntry.cfg, chatId)) return;
    this.applyNewP2pDefault(chatId, openId); // 常驻豁免名单命中 → 不会被设为睡眠
    this.spawnChannelCli(chatId, undefined, appId);
    void this.ensureP2pDisplayName(chatId, openId, appId);
    process.stderr.write(`[supervisor] 常驻私聊 ${chatId.slice(-8)} 打开会话 → 自动挂号（peer=${openId.slice(-6)}）\n`);
  }

  /** 事件投递前确保目标频道 CLI 就绪（find-or-spawn + 等 hello，仿 onPollAction 离线兜底） */
  private async ensureChannelReadyForEvent(chatId: string, appId?: string): Promise<boolean> {
    // 事件入口（表情 / 拉群 / 评论）与消息入口同受 allowlist 约束，否则旧群一个表情就能拉起一个频道 CLI
    const appEntry = this.apps.get(appId ?? this.resolveAppId(chatId));
    if (!appEntry || !isChatAllowed(appEntry.cfg, chatId)) return false;
    if (!this.channels.has(chatId)) this.spawnChannelCli(chatId, undefined, appId);
    return this.waitForChannelReady(chatId, 15000);
  }

  /** 别人加表情回复 → 唤醒该频道品品（供参考、不强制回复）。撤表情(removed)不通知。
   *  appId = 该表情所属的飞书应用（多应用：反查被点消息用哪个应用的 client）。 */
  private async onReaction(evt: ReactionEvent, appId: string): Promise<void> {
    if (evt.action === 'removed') return; // Not-Doing：撤回表情不算"发来的 react"，不打扰
    const info = await this.resolveReactedMsg(evt.messageId, appId);
    if (!info) {
      process.stderr.write(`[supervisor] onReaction: 反查被点消息失败 (msg ${evt.messageId})，丢弃\n`);
      return;
    }
    const chatId = info.chatId;
    if (!(await this.ensureChannelReadyForEvent(chatId, appId))) {
      process.stderr.write(`[supervisor] onReaction: chat ${chatId.slice(-8)} CLI 未就绪，放弃\n`);
      return;
    }
    const reactor = resolveSenderNameSync(evt.operator.openId, 'user', appId);
    const uni = feishuEmojiTypeToUnicode(evt.emojiType);
    const emojiShow = uni ? `${uni}（${evt.emojiType}）` : evt.emojiType;
    // 被点的消息是不是品品自己发的（app 类型 + sender.id 是我们任一飞书应用的 bot app_id，同 feishu-poll 自环判定）
    const isPinpinOwn = info.senderType === 'app' && this.apps.has(info.senderId);
    let body: string;
    if (isPinpinOwn) {
      body = `【表情信号·供参考】${reactor} 给你这条消息「${info.snippet}」点了 ${emojiShow}。这通常表示认可/回应——你看情况决定要不要继续推进，不必专门回复。`;
    } else {
      const whose = info.senderId === evt.operator.openId
        ? '自己'
        : resolveSenderNameSync(info.senderId, info.senderType, appId);
      body = `【表情信号·供参考】${reactor} 给${whose}的这条消息「${info.snippet}」点了 ${emojiShow}。群里的小互动，供你了解，一般不用回应。`;
    }
    this.ipcServer.pushChatTrigger(chatId, body, {
      user: reactor,
      sender_type: 'human',
      message_id: `reaction-${evt.messageId}-${evt.operator.openId}-${evt.emojiType}`,
      trigger: 'reaction',
    });
  }

  /** 品品被拉进新群 → spawn 该群 CLI + 提示品品可打招呼。appId = 拉群事件所属的飞书应用。 */
  private async onBotAdded(evt: BotAddedEvent, appId: string): Promise<void> {
    const chatId = evt.chatId;
    if (!(await this.ensureChannelReadyForEvent(chatId, appId))) {
      process.stderr.write(`[supervisor] onBotAdded: chat ${chatId.slice(-8)} CLI 未就绪，放弃\n`);
      return;
    }
    let chatName: string | undefined;
    try {
      const res = await getFeishuClient(appId).im.v1.chat.get({ path: { chat_id: chatId } });
      chatName = res.data?.name;
    } catch { /* 拿不到群名不影响打招呼 */ }
    // 落群名：首次拉进的群若还没 display_name，用飞书群名补上（认名补强，2026-09-16）
    if (chatName && !this.channelConfigStore.get(chatId)?.display_name) {
      this.channelConfigStore.set(chatId, { display_name: chatName });
      this.channels.get(chatId)?.setChatName(chatName);
      this.emit('channel-state-changed', chatId);
    }
    const body = `【系统】我刚被拉进这个群${chatName ? `「${chatName}」` : ''}。要不要打个招呼 / 做个自我介绍，你看情况决定。`;
    this.ipcServer.pushChatTrigger(chatId, body, {
      user: '系统',
      sender_type: 'system',
      message_id: `botadded-${chatId}-${evt.operator.openId}`,
      trigger: 'bot-added',
    });
  }

  /** 云文档评论 → 投到兜底频道（PINPIN_COMMENT_CHAT_ID ?? 主聊 PINPIN_OWNER_CHAT_ID）。评论正文未取。 */
  /** 已推过的审批动态（instance:kind:status:task），防同一事件重复推；上限 500 条滚动 */
  /** 本进程启动时刻：审批事件的历史补推按它掐掉 */
  private readonly startedAt = Date.now();
  private approvalSeen = new Set<string>();
  /** 已推过的打卡事件（record_id），防重复推；上限 300 条滚动 */
  private attendanceSeen = new Set<string>();

  /**
   * 打卡事件（实测用最小链路）→ 豆姐私聊 trigger。只推白名单里的人，早于 supervisor 启动的丢弃，按 record_id 去重。
   * 每条（含被丢弃的）都先写后台账本，供实测复盘。晚间加班提醒仍按每小时轮询，本链路只作记录。
   */
  private async onAttendanceEvent(evt: AttendanceEventPayload, appId: string): Promise<void> {
    const dmChatId = process.env.PINPIN_OWNER_CHAT_ID;
    const logKey = `employee_id=${evt.employee_id} check_time=${evt.check_time} record_id=${evt.record_id ?? '无'}`;
    if (!dmChatId || this.resolveAppId(dmChatId) !== appId) {
      logBackground('attendance', `${logKey} app=${appId} 结果=非豆姐私聊所属应用`);
      return;
    }
    const allow = (process.env.PINPIN_ATTENDANCE_EMPLOYEE_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!allow.includes(evt.employee_id)) {
      logBackground('attendance', `${logKey} 结果=非白名单`);
      return;
    }
    const checkAtMs = Number(evt.check_time) * 1000;
    if (checkAtMs && checkAtMs < this.startedAt) {
      logBackground('attendance', `${logKey} 结果=早于启动`);
      return;
    }
    const key = evt.record_id ?? `${evt.employee_id}:${evt.check_time}`;
    if (this.attendanceSeen.has(key)) {
      logBackground('attendance', `${logKey} 结果=重复`);
      return;
    }
    this.attendanceSeen.add(key);
    if (this.attendanceSeen.size > 300) this.attendanceSeen.delete(this.attendanceSeen.values().next().value as string);
    logBackground('attendance', `${logKey} 结果=推送`);
    const at = new Date(checkAtMs);
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    const body =
      `⏰ 打卡事件（实测中）：豆姐 ${hhmm} 打卡${evt.location_name ? `（${evt.location_name}）` : ''}。` +
      `晚间加班提醒仍按每小时轮询，本条只作记录，不用回豆姐（pinpin_no_reply）。`;
    if (!(await this.ensureChannelReadyForEvent(dmChatId, appId))) return;
    this.ipcServer.pushChatTrigger(dmChatId, body, {
      user: '系统',
      sender_type: 'system',
      message_id: `attendance-${key}`,
      trigger: 'attendance-event',
      employee_id: evt.employee_id,
      check_time: evt.check_time,
      record_id: evt.record_id ?? '',
    });
  }

  /**
   * 审批实例 / 任务状态变更 → 拉实例详情（审批名 / 申请人 / 状态 / 表单要点）→ 推 trigger=approval-event 到Owner私聊。
   * 只推Owner私聊所属应用的事件；申请人不在认人表的也推（由品品按"豆姐+组员"口径决定说不说）。
   */
  private async onApprovalEvent(evt: ApprovalEventPayload, appId: string): Promise<void> {
    const dmChatId = process.env.PINPIN_OWNER_CHAT_ID;
    if (!dmChatId || this.resolveAppId(dmChatId) !== appId) return;
    // 飞书在订阅建立时会把历史变更一起灌过来（实测 30+ 条三天前的旧审批，且 PENDING/APPROVED 乱序）。
    // 只认本进程起来之后发生的变更：早于启动时间的一律丢。
    const opMs = Number(evt.operate_time ?? 0);
    const opAt = opMs > 1e12 ? opMs : opMs * 1000; // 秒/毫秒都可能
    if (opAt && opAt < this.startedAt - 60_000) return;
    const key = `${evt.instance_code}:${evt.kind}:${evt.status}:${evt.task_id ?? ''}`;
    if (this.approvalSeen.has(key)) return;
    this.approvalSeen.add(key);
    if (this.approvalSeen.size > 500) this.approvalSeen.delete(this.approvalSeen.values().next().value as string);
    try {
      const res = await getFeishuClient(appId).approval.v4.instance.get({
        path: { instance_id: evt.instance_code },
        params: { user_id_type: 'open_id' },
      });
      const inst = res.data;
      if (!inst) return;
      // 全公司的审批流都会推过来（郑州各部门），只留跟豆姐这一组有关的：
      // 申请人是她或她的组员，或者轮到她审批。其余直接丢，不烧频道 token。
      // fail-closed：PINPIN_APPROVAL_WATCH_OPEN_IDS 缺失/清空时不放行全部——这行环境变量本身就是
      // 今天全租户审批灌爆事故的止血闸，缺配置不该悄悄退回未过滤状态（"轮到豆姐审批"这条件不受此开关影响，照常放行）。
      const watch = (process.env.PINPIN_APPROVAL_WATCH_OPEN_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (watch.length === 0) {
        process.stderr.write('[approval] ⚠️ PINPIN_APPROVAL_WATCH_OPEN_IDS 未配置，仅按"轮到豆姐审批"过滤（申请人相关性无法判断）\n');
      }
      const ownerOpenId = this.apps.get(appId)?.cfg.ownerOpenId;
      const isOurs = (watch.length > 0 && !!inst.open_id && watch.includes(inst.open_id))
        || (ownerOpenId ? (inst.task_list ?? []).some((t) => t.open_id === ownerOpenId) : false);
      if (!isOurs) return;
      const applicant = resolveSenderNameSync(inst.open_id, 'user', appId);
      let formLines = '';
      try {
        const form = JSON.parse(inst.form) as Array<{ name?: string; value?: unknown }>;
        formLines = form
          .filter((f) => f.name && f.value !== undefined && f.value !== null && f.value !== '')
          .slice(0, 5)
          .map((f) => `${f.name}：${String(typeof f.value === 'object' ? JSON.stringify(f.value) : f.value).slice(0, 60)}`)
          .join('｜');
      } catch { /* 表单解析失败就不带要点 */ }
      const operator = evt.kind === 'task' && evt.open_id ? resolveSenderNameSync(evt.open_id, 'user', appId) : '';
      // 自动秒审批（Owner口径）：只对「下属提交、轮到Owner审」的加班申请自动同意；其它一律只推送
      const auto = await this.maybeAutoApproveOvertime(evt, inst, appId);
      const body =
        (auto ? `✅ 已自动同意 ${applicant} 的加班申请（${inst.approval_name}，编号 ${inst.serial_number}）${formLines ? `｜${formLines}` : ''}\n用一句话告诉豆姐即可。\n` : '') +
        `📋 审批动态：「${inst.approval_name}」｜申请人 ${applicant}｜${evt.kind === 'task' ? `节点 ${approvalStatusZh(evt.status)}${operator ? `（${operator}）` : ''}` : `实例 ${approvalStatusZh(evt.status)}`}｜整体 ${approvalStatusZh(inst.status)}｜编号 ${inst.serial_number}\n` +
        (formLines ? `要点：${formLines}\n` : '') +
        `按「豆姐 + 组员」口径：是他们的就用一句话告诉豆姐（谁、什么审批、到哪一步）；豆姐自己是待审批人的说"待你审批"；无关的人 pinpin_no_reply。`;
      if (!(await this.ensureChannelReadyForEvent(dmChatId, appId))) return;
      this.ipcServer.pushChatTrigger(dmChatId, body, {
        user: '系统',
        sender_type: 'system',
        message_id: `approval-event-${evt.instance_code}-${evt.status}-${evt.task_id ?? 'i'}`,
        trigger: 'approval-event',
        approval_code: evt.approval_code,
        instance_code: evt.instance_code,
        status: evt.status,
        applicant_open_id: inst.open_id,
      });
    } catch (e) {
      process.stderr.write(`[approval] 实例 ${evt.instance_code.slice(0, 12)}… 详情失败: ${e instanceof Error ? e.message : e}\n`);
    }
  }

  /**
   * 自动秒审批：evt 是 task 待办 + 审批定义 = 加班（env PINPIN_OVERTIME_APPROVAL_CODE，缺省按名含"加班"）
   * + 申请人 ∈ PINPIN_AUTO_APPROVE_OVERTIME_FROM（下属）+ 该 task 的审批人是Owner且 PENDING → 以Owner身份同意。返回是否同意了。
   */
  private async maybeAutoApproveOvertime(
    evt: ApprovalEventPayload,
    inst: { approval_name: string; open_id: string; task_list: Array<{ id: string; open_id?: string; status: string }> },
    appId: string,
  ): Promise<boolean> {
    if (evt.kind !== 'task' || evt.status !== 'PENDING' || !evt.task_id) return false;
    const from = (process.env.PINPIN_AUTO_APPROVE_OVERTIME_FROM ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!from.includes(inst.open_id)) return false;
    const code = process.env.PINPIN_OVERTIME_APPROVAL_CODE;
    if (code ? evt.approval_code !== code : !inst.approval_name.includes('加班')) return false;
    const owner = this.apps.get(appId)?.cfg.ownerOpenId;
    const task = inst.task_list.find((t) => t.id === evt.task_id);
    if (!owner || !task || task.open_id !== owner || task.status !== 'PENDING') return false;
    try {
      await getFeishuClient(appId).approval.v4.task.approve({
        params: { user_id_type: 'open_id' },
        data: { approval_code: evt.approval_code, instance_code: evt.instance_code, user_id: owner, task_id: evt.task_id, comment: '同意（品品代豆姐自动审批）' },
      });
      process.stderr.write(`[approval] 自动同意加班 instance=${evt.instance_code.slice(0, 12)}… 申请人=${inst.open_id.slice(-6)}\n`);
      return true;
    } catch (e) {
      process.stderr.write(`[approval] 自动同意失败 ${evt.instance_code.slice(0, 12)}…: ${e instanceof Error ? e.message : e}\n`);
      return false;
    }
  }

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

  private onChatListDiff(diff: ChatListDiff, appId: string): void {
    for (const added of diff.added) {
      // 睡眠频道维持"不上线、靠消息唤醒"——chat.list 抖动（removed→added）不能把它无声叫醒
      if (this.channelConfigStore.isStandby(added.chat_id)) continue;
      process.stderr.write(`[supervisor] 新群发现，自动 spawn: ${added.name ?? added.chat_id}\n`);
      this.spawnChannelCli(added.chat_id, added.name, appId);
    }
    // 频道常驻语义（2026-05-28）：飞书 chat.list 返回 removed 不再主动 stop CLI——
    // 被踢/解散事件靠飞书 SDK 可能短时抖动（chat.list 拉空），误判 stop 会导致 CLI 反复重启。
    // 真要"停频道"走 delete_channel → STOP_CHANNEL → stopChannel()。
    for (const removed of diff.removed) {
      process.stderr.write(
        `[supervisor] chat.list 不再返回此 chat（可能短时抖动 / 群解散），保持常驻 CLI: ${removed.name ?? removed.chat_id}\n`,
      );
    }
    this.emit('chat-list-diff', diff);
  }

  /** 挪动文件/目录（先 renameSync，跨盘失败则 cpSync+rmSync 兜底）。 */
  private moveFileOrDir(src: string, dest: string): void {
    try {
      fs.renameSync(src, dest);
    } catch {
      fs.cpSync(src, dest, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
  }

  /**
   * 彻底删除频道（delete_channel tool → DELETE_CHANNEL）：
   *   1. confirm_name 二次核对（去空格全等），对不上直接拒绝
   *   2. 群 → disband 解散（品品自建）或退群（chatMembers.delete 移除自己）；飞书报错则中止，不继续清理
   *      p2p → 不碰飞书，只清本地
   *   3. stopChannel（停 CLI + 删配置 + 清熔断/待就绪/待投递状态）
   *   4. 归档：频道简报 / 对话记录 挪进 vault「归档」子目录；人物注入映射删该 chat_id key
   *   各步异常只记 stderr、不中断（归档失败不该让已完成的解散/清配置回滚）。
   */
  private async deleteChannel(p: DeleteChannelParams): Promise<DeleteChannelResult> {
    if (p.chat_id === process.env.PINPIN_OWNER_CHAT_ID) {
      return { ok: false, error: '豆姐私聊是主频道，不能删除' };
    }
    const persisted = this.channelConfigStore.get(p.chat_id);
    if (!this.channels.has(p.chat_id) && !persisted) {
      return { ok: false, error: '没有这个频道' };
    }
    const name = persisted?.display_name ?? p.chat_id;
    const normalize = (s: string) => s.replace(/\s/g, '');
    // 启动器显示名与飞书群名（list_active_chats 给的）都认
    const feishuName = this.allChats().find((c) => c.chat_id === p.chat_id)?.name;
    const accepted = [name, feishuName].filter((x): x is string => !!x).map(normalize);
    if (!accepted.includes(normalize(p.confirm_name))) {
      return { ok: false, error: `名字对不上：这个频道叫「${name}」${feishuName && feishuName !== name ? `（飞书群名「${feishuName}」）` : ''}` };
    }
    const appId = this.resolveAppId(p.chat_id);
    const client = getFeishuClient(appId);
    let kind: 'group' | 'p2p';
    try {
      const res = await client.im.v1.chat.get({ path: { chat_id: p.chat_id } });
      kind = res.data?.chat_mode === 'p2p' ? 'p2p' : 'group';
    } catch {
      // chat.get 失败（如已不在群/权限问题）→ 按显示名后缀兜底判断
      kind = name.endsWith('（私聊）') ? 'p2p' : 'group';
    }
    if (kind === 'group') {
      try {
        if (p.disband) {
          await client.im.v1.chat.delete({ path: { chat_id: p.chat_id } });
        } else {
          await client.im.v1.chatMembers.delete({
            path: { chat_id: p.chat_id },
            params: { member_id_type: 'app_id' },
            data: { id_list: [appId] },
          });
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    this.stopChannel(p.chat_id);

    const archived: string[] = [];
    const vault = this.opts.vaultCwd;
    const archiveRoot = path.join(vault, '归档');

    // 频道简报归档
    try {
      const briefSrc = path.join(vault, '频道简报', `${p.chat_id}.md`);
      if (fs.existsSync(briefSrc)) {
        const dir = path.join(archiveRoot, '退役频道简报');
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, `${p.chat_id}.md`);
        this.moveFileOrDir(briefSrc, dest);
        archived.push(path.relative(vault, dest));
      }
    } catch (e) {
      process.stderr.write(`[supervisor] deleteChannel 归档简报失败 ${p.chat_id.slice(-8)}: ${e instanceof Error ? e.message : e}\n`);
    }

    // 对话记录归档
    try {
      const safe = safeName(name);
      const logSrc = path.join(vault, '对话记录', safe);
      if (fs.existsSync(logSrc)) {
        const dir = path.join(archiveRoot, '退役对话记录');
        fs.mkdirSync(dir, { recursive: true });
        const d = new Date();
        const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
        let dest = path.join(dir, `${safe}_${stamp}`);
        let n = 2;
        while (fs.existsSync(dest)) {
          dest = path.join(dir, `${safe}_${stamp}-${n}`);
          n++;
        }
        this.moveFileOrDir(logSrc, dest);
        archived.push(path.relative(vault, dest));
      }
    } catch (e) {
      process.stderr.write(`[supervisor] deleteChannel 归档对话记录失败 ${p.chat_id.slice(-8)}: ${e instanceof Error ? e.message : e}\n`);
    }

    // 人物注入映射删 key
    try {
      const mapPath = path.join(vault, '记忆系统', '人物', '_注入映射.json');
      if (fs.existsSync(mapPath)) {
        const map = JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as Record<string, unknown>;
        if (p.chat_id in map) {
          delete map[p.chat_id];
          fs.writeFileSync(mapPath, JSON.stringify(map, null, 2), 'utf-8');
          archived.push('记忆系统/人物/_注入映射.json（已删该频道条目）');
        }
      }
    } catch (e) {
      process.stderr.write(`[supervisor] deleteChannel 清人物映射失败 ${p.chat_id.slice(-8)}: ${e instanceof Error ? e.message : e}\n`);
    }

    return { ok: true, chat_name: name, kind, archived };
  }

  /**
   * 解散群后停该频道 CLI（delete_channel → STOP_CHANNEL）。
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
    // 立即从所有 app 的 FeishuPoll 轮询列表摘除（不等 5min chat.list 刷新）：
    // 否则 poll.getChats() 仍含该 chat → resolveAppId() 遍历命中 → markSeen() 把刚 remove 的配置写回。
    for (const { poll } of this.apps.values()) poll.removeChat(chatId);
    this.channelUsage.delete(chatId);
    this.crashState.delete(chatId); // D1: 频道彻底停掉才清熔断计数（正常 respawn 不清=熔断跨 respawn 持续）
    this.pendingInbound.delete(chatId); // D2: 清未就绪缓冲队列，避免泄漏
    this.clearGraceTimer(chatId); // D3: 清待触发的断线自愈定时器
    this.nameAskScheduled.delete(chatId); // 删后重建的私聊按新频道重新问称呼
    this.lastActivityAt.delete(chatId);
    const live = this.liveRestartTimers.get(chatId);
    if (live) { clearTimeout(live); this.liveRestartTimers.delete(chatId); }
    process.stderr.write(`[supervisor] stop channel: ${chatId}\n`);
    this.emit('channel-state-changed', chatId);
    return true;
  }

  // ── 常驻工人托管（医生/工程师/顺子等；wake_worker tool + 启动器面板）──

  listWorkers(): WorkerStatus[] {
    return [...this.workers.values()].map((w) => w.getStats());
  }

  getWorker(name: string): WorkerCli | undefined {
    return this.workers.get(name);
  }

  stopWorker(name: string): void {
    this.workers.get(name)?.stop();
    this.emit('channel-state-changed');
  }

  /** 品品 wake_worker(name) → 不在则 PTY 拉起，失败重试 1 次；成功后等就绪（PTY 静默 3s，最长 60s）。
   *  失败/超时/broken 时飞书私聊豆姐告警（同一工人 30 分钟内只告警一次）。 */
  async wakeWorker(name: string): Promise<WakeWorkerResult> {
    const w = this.workers.get(name);
    if (!w) return { ok: false, error: `没有叫「${name}」的工人（workers.json 里没配）` };
    if (w.status === 'awake') return { ok: true, state: 'already' };

    let res = await w.start();
    if (!res.ok) res = await w.start(); // 失败重试 1 次
    if (!res.ok) {
      void this.notifyWorkerAlert(name, `拉起失败：${res.error ?? '未知错误'}`);
      return { ok: false, state: 'failed', error: res.error };
    }
    // 首次拉起若原为空 sessionId，start() 已生成新 UUID 写进 cfg——落盘（workers.json 单文件覆盖写全量）
    saveWorkersConfig(this.opts.dataDir, [...this.workers.values()].map((x) => x.cfg));
    this.emit('channel-state-changed');

    const ready = await this.waitWorkerReady(w, 60_000);
    if (!ready) {
      w.stop();
      void this.notifyWorkerAlert(name, '60 秒内没准备好，已结束进程');
      this.emit('channel-state-changed');
      return { ok: false, state: 'failed', error: '启动超时（60s 未就绪）' };
    }
    this.emit('channel-state-changed');
    return { ok: true, state: 'woke' };
  }

  /** 无官方"CLI 已就绪"接口，用 启动满 8 秒 + PTY 输出静默 3 秒 + 进程存活网络判断；最长等 timeoutMs。 */
  private async waitWorkerReady(w: WorkerCli, timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = (): void => {
        if (w.status !== 'awake') { resolve(false); return; }
        if (w.isQuietFor(3000, 8000)) { resolve(true); return; }
        if (Date.now() - started >= timeoutMs) { resolve(false); return; }
        setTimeout(tick, 500);
      };
      tick();
    });
  }

  private checkWorkersIdle(): void {
    const IDLE_THRESHOLD_MS = 30 * 60_000;
    for (const w of this.workers.values()) {
      if (w.isIdleFor(IDLE_THRESHOLD_MS)) {
        process.stderr.write(`[supervisor] worker ${w.name} 空闲超 30 分钟，自动结束进程\n`);
        w.stop();
        this.emit('channel-state-changed');
      }
    }
  }

  /** 工人拉起失败/超时告警（飞书私聊豆姐），同一工人 30 分钟内只告警一次。 */
  private async notifyWorkerAlert(name: string, reason: string): Promise<void> {
    const now = Date.now();
    const last = this.workerAlertedAt.get(name);
    if (last && now - last < 30 * 60_000) return;
    this.workerAlertedAt.set(name, now);
    await this.notifyOwnerDm(process.env.PINPIN_OWNER_CHAT_ID ?? '', `⚠️ 工人「${name}」叫不起来：${reason}`);
  }
}
