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
import type { CardActionEvent } from '@larksuiteoapi/node-sdk';
import { buildPollCard } from '../src/mcp/feishu/cards/diy-card.js';
import { IpcServer } from './ipc-server.js';
import { ChannelCli } from './channel-cli.js';
import { ChannelConfigStore, DEFAULT_AUTOCOMPACT_PCT } from './channel-config-store.js';
import { WorkSession, type WorkSessionStopInfo } from './work-session.js';
import { CcusagePoller, type QuotaSnapshot } from './ccusage-poller.js';
import { SupervisorCronRunner } from './cron-runner.js';
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
  type WorkStopSignalParams,
  type CompactViaPtyParams,
  type SpawnChannelParams,
  type ForgetChannelParams,
  type FeishuInboundMessagePayload,
  type PollVoteParams,
  type PollVoteResult,
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

/** 完工提醒去重窗口：'stopped' 由 Stop hook 主路径 + idle 兜底两条发出，各自靠文本身份去重，
 *  但两条提取代码/文件来源不同，文本偶有不一致会双发（甚至多发）。同一 work session 在此窗口内的
 *  重复推送收敛为一遍。需 > QUIESCE_MS(6s)+IDLE_TICK_MS(2s) 才能盖住 hook→idle 的发出时间差；
 *  回合制串行下真实两次完工间隔（品品 peek+汇报+Owner再发指令）远大于此值，故不会误吞真完工。 */
const WORK_STOP_PUSH_DEDUP_MS = 15_000;

export class Supervisor extends EventEmitter {
  readonly opts: Required<SupervisorOptions>;
  private feishuPoll: FeishuPoll | null = null;
  /** P4.Q3: 事件订阅长连接（接 user 消息含 P2P 单聊；跟 poll 双轨并存） */
  private feishuEventSubscriber: FeishuEventSubscriber | null = null;
  /** P4.Q3: supervisor 入口 message_id 去重（防 WSClient + poll 双源重复推） */
  private supervisorProcessedIds = new Set<string>();
  private ipcServer: IpcServer;
  private ccusagePoller: CcusagePoller;
  private channelConfigStore: ChannelConfigStore;
  private cronRunner: SupervisorCronRunner;
  /** YYYY-MM-DD → 当日入站消息数（修内审 Optional #8 E7 本日消息统计） */
  private dailyMessageCount = new Map<string, number>();
  /** chat_id → ChannelCli */
  private channels = new Map<string, ChannelCli>();
  /** D1: chat_id → 崩溃熔断计数（实例级，不随 spawnChannelCli 重建闭包清零；forgetChannel 才删）。
   *  原为 spawnChannelCli 闭包局部 var，forget→respawn 会重建闭包跳过熔断；提到实例级使熔断跨 respawn 持续。 */
  private crashState = new Map<
    string,
    { count: number; windowStart: number; slowRecoveryActive?: boolean; recoveryCount?: number }
  >();
  /** D2: chat_id → CLI 未就绪时缓冲的入站消息（带入队时间戳）。CLI ready（client-hello）后 flush 投递。
   *  每 chat 上限 50 条（超丢最旧）、flush 时丢弃入队 > 10min 的过期消息。forgetChannel 时清。 */
  private pendingInbound = new Map<string, Array<{ msg: FeishuInboundMessagePayload; enqueuedAt: number }>>();
  /** P1.3: chat_id → 最新 statusLine 推过来的上下文用量 */
  private channelUsage = new Map<string, ChannelUsageInfo>();
  /** P1.3: ccusage quota 最近一次手动获取 snapshot（删 5min poll 后改按需触发） */
  private lastQuotaSnapshot: QuotaSnapshot | null = null;
  /** 账号级额度（5h+7天，来自任一 CLI statusLine 的 rate_limits）；逐窗口存最新已知值，无数据为 null */
  private lastRateLimits: RateLimits | null = null;
  /** session_id → WorkSession（诉求 B 传话筒） */
  private workSessions = new Map<string, WorkSession>();
  /** work session 独立默认 model/effort（启动时从 channel-config.json __work_defaults__ load；null = fallback 频道默认） */
  private workDefaultModel: string | null = null;
  private workDefaultEffort: string | null = null;
  /** work session 默认 fast（启动时从 __work_defaults__ load；null = 不开） */
  private workDefaultFast: boolean | null = null;
  private started = false;
  /** 批3: 频道暂停态——构造器默认 true（启动器打开后不自动开启任何频道，完全静默）。
   *  startAllChannels()（「开启所有」按钮）置 false 后才自动 spawn；stop() 不重置它，
   *  所以「开启所有」一次后即使重启品品也会恢复频道（符合「重启品品」语义）。 */
  private channelsPaused = true;
  private dbPath: string;

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

    // ── 1. DB ──
    // 方案A：supervisor 自身**不再**碰 DB（彻底卸 better-sqlite3，根治 Electron v130 vs 子进程 v137
    // 双 ABI）。dbPath 仅作为路径透传给各频道子进程（它们跑系统 Node、better-sqlite3 prebuild 匹配，
    // DB 读写全在子端）。投票记票走 IPC 路由到子端执行。
    process.stderr.write(`[supervisor] DB path (passthrough to children): ${this.dbPath}\n`);

    // ── 2. IPC server start ──
    const port = await this.ipcServer.start();
    this.ipcServer.on('client-hello', (info: { chat_id: string; pid: number }) => {
      process.stderr.write(`[supervisor] IPC client up: chat=${info.chat_id} pid=${info.pid}\n`);
      // 通知对应 ChannelCli 启动期结束（停止 auto-confirm 启动 prompts）
      this.channels.get(info.chat_id)?.emit('ipc-ready');
      // D2: CLI 已就绪 → flush 该 chat 在未就绪期间缓冲的入站消息
      this.flushPendingInbound(info.chat_id);
      this.emit('channel-mcp-ready', info);
    });
    this.ipcServer.on('client-disconnected', (info: { chat_id: string; pid: number }) => {
      process.stderr.write(`[supervisor] IPC client down: chat=${info.chat_id} pid=${info.pid}\n`);
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

    // ── 批2 work CLI 完工信号：work-stop-sink Stop hook → supervisor（替 idle 猜停的确定性主路径）──
    this.ipcServer.on('worksession-stop-signal', (p: WorkStopSignalParams) => {
      const session = this.workSessions.get(p.ws_id);
      if (!session) {
        process.stderr.write(`[supervisor] work-stop-signal 收到但 ws_id 未知: ${p.ws_id}\n`);
        return;
      }
      session.notifyStopFromHook(p.transcript_path, p.last_text);
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
        // 批2: work CLI 的 Stop hook 靠 env 端口回连 supervisor（仿 channel-cli 显式注入，不能靠 process.env 继承）
        supervisorPort: this.ipcServer.getPort(),
        stopSinkPath: path.join(this.opts.appRoot, 'scripts', 'work-stop-sink.cjs'),
      });
      this.workSessions.set(session.id, session);
      // 完工去重兜底（闭包 per-session）：见 WORK_STOP_PUSH_DEDUP_MS 注释。
      let lastStopPushAt = 0;
      session.on('stopped', (info: WorkSessionStopInfo) => {
        const now = Date.now();
        if (now - lastStopPushAt < WORK_STOP_PUSH_DEDUP_MS) {
          process.stderr.write(
            `[supervisor] work-stopped 去重跳过：session=${session.id} 距上次推送 ${now - lastStopPushAt}ms` +
              ` < ${WORK_STOP_PUSH_DEDUP_MS}ms（reason=${info.stop_reason}）—— 同一次停止的重复信号\n`,
          );
          return;
        }
        lastStopPushAt = now;
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
      session.sendMessage(p.message);
      const result: WorkOkResult = { ok: true };
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

    // 品品主动单聊 / 建群后即时挂频道监听（spawnChannelCli 幂等，已存在直接返回）
    this.ipcServer.setRequestHandler(IPC_METHODS.SPAWN_CHANNEL, async (params) => {
      const p = params as SpawnChannelParams;
      if (!p.chat_id) return { ok: false, error: 'missing chat_id' } as WorkOkResult;
      this.spawnChannelCli(p.chat_id, p.chat_name);
      return { ok: true } as WorkOkResult;
    });

    // 解散群后停该频道 CLI（forgetChannel：stop CLI + markForgotten + 从 channels 删除）
    this.ipcServer.setRequestHandler(IPC_METHODS.FORGET_CHANNEL, async (params) => {
      const p = params as ForgetChannelParams;
      if (!p.chat_id) return { ok: false, error: 'missing chat_id' } as WorkOkResult;
      const ok = this.forgetChannel(p.chat_id);
      return { ok } as WorkOkResult;
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
    });
    try {
      await this.feishuEventSubscriber.start();
    } catch (e) {
      // 事件订阅启动失败不阻塞 supervisor 启动（poll 仍跑）—— 飞书后台未开权限时 graceful degradation
      process.stderr.write(
        `[supervisor] FeishuEventSubscriber 启动失败 (poll 继续工作): ${e instanceof Error ? e.message : e}\n`,
      );
    }

    // ── 5. 已识别的所有 chat 自动 spawn 频道 CLI ──
    // 批3: 默认 paused（完全静默）→ 不自动 spawn；Owner点「开启所有」走 startAllChannels()。
    // 「开启所有」过一次后 paused=false，重启品品（stop 清 Map + start）会自动恢复频道。
    if (!this.channelsPaused) this.spawnAllKnownChannels();

    // ── 5.5 supervisor 内嵌 cron（2026-05-28 多 CLI 决策）：
    //         mood-decay / feishu-token-keepalive / daily-restart 编排
    //         这 3 个不依赖 CLI 在线，统一在 main process 跑（避免 N 个 CLI 重复触发） ──
    this.cronRunner.start();

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
    this.cronRunner.stop();
    await this.ccusagePoller.stop();
    for (const cli of this.channels.values()) cli.stop();
    this.channels.clear();
    for (const ws of this.workSessions.values()) ws.end();
    this.workSessions.clear();
    await this.feishuPoll?.stop();
    this.feishuPoll = null;
    await this.feishuEventSubscriber?.stop();
    this.feishuEventSubscriber = null;
    await this.ipcServer.stop();
    process.stderr.write('[supervisor] stopped\n');
  }

  /** 启动器「重启品品」：stop + start，并恢复频道。
   *  修 bug：stop() 不重置 channelsPaused、start() 拉频道受 `!channelsPaused` 门控，默认
   *  paused=true（用户逐个手动启动频道也不改它）→ 旧 stop()+start() 只下线不拉起。
   *  快照 stop 前是否有活跃频道（Map 非空 或 已解除暂停），重启后若仍 paused 但原本有频道则补 startAllChannels()。 */
  async restart(): Promise<void> {
    const hadChannels = this.channels.size > 0 || !this.channelsPaused;
    await this.stop();
    await this.start();
    if (hadChannels && this.channelsPaused) this.startAllChannels();
  }

  /** 抗断线加固：熔断后的有界慢速自愈链。每 5min 一跳——
   *  已稳定运行 → 重置熔断状态；达上限(6次) → 通知Owner + 交手动 [↻]；否则重试一次再排下一跳。
   *  crashState 被 manual-restart/forgetChannel 清掉时链自动终止（回调内重取 state 判空）。 */
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

  /** 批3 Bug 修复：启动器「展示用」频道列表 = 已 spawn 的真实状态 + 已识别但未 spawn 的合成"停止卡"。
   *  让 paused（完全静默/未点开启所有）时启动器仍显示所有已知频道（停止态、可预配 model/effort），
   *  Owner配好再点开启所有——这才是「启动前先配模型」的用途。已 forget 的不显示。 */
  getDisplayChannels(): Array<ReturnType<ChannelCli['getStats']>> {
    const spawned = this.getChannelCliStats();
    const seen = new Set(spawned.map((c) => c.chat_id));
    const out = [...spawned];
    const knownIds: string[] = [];
    for (const c of this.feishuPoll?.getChats() ?? []) knownIds.push(c.chat_id);
    for (const id of this.channelConfigStore.listChatIds()) knownIds.push(id);
    for (const chatId of knownIds) {
      if (seen.has(chatId)) continue;
      seen.add(chatId);
      if (this.channelConfigStore.isForgotten(chatId)) continue;
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
      });
    }
    return out;
  }

  getChannel(chatId: string): ChannelCli | undefined {
    return this.channels.get(chatId);
  }

  /** 批3: spawn 所有已识别频道（飞书 chat.list + channel-config 持久化的，跳过 forgotten）。
   *  原 start() step 5a/5b 逻辑抽出，供 start()（非 paused 时）+ startAllChannels() 共用。 */
  private spawnAllKnownChannels(): void {
    // 5a. 飞书 chat.list 拿到的群（含Owner已加入的群聊）
    for (const c of this.feishuPoll?.getChats() ?? []) {
      if (this.channelConfigStore.isForgotten(c.chat_id)) continue;
      this.spawnChannelCli(c.chat_id, c.name);
    }
    // 5b. 频道常驻：channel-config.json 持久化但飞书 chat.list 没返的（P2P 单聊 / 历史已识别群）
    const persistedIds = this.channelConfigStore.listChatIds();
    for (const chatId of persistedIds) {
      if (this.channels.has(chatId)) continue; // 5a 已 spawn 跳过
      const persisted = this.channelConfigStore.get(chatId);
      this.spawnChannelCli(chatId, persisted?.display_name);
    }
  }

  /** 批3「开启所有」按钮入口：解除 paused + 把所有已识别频道开起来。
   *  不在 Map → spawn；在 Map 但已 stopped → start()（让之前单独关掉的频道也一并重开）。 */
  startAllChannels(): void {
    this.channelsPaused = false;
    this.spawnAllKnownChannels();
    // 已存在但 stopped 的频道（之前被单独关掉）也重开
    for (const c of this.getChannelCliStats()) {
      if (c.status === 'stopped') this.channels.get(c.chat_id)?.start();
    }
    process.stderr.write('[supervisor] startAllChannels：已解除暂停 + 开启所有已识别频道\n');
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
      // sleep_self tool 写过 .bot.sleep.<chatId 末 8>：Owner主动下线本频道 → 不自动重启
      const sleepMarker = path.join(this.opts.appRoot, `.bot.sleep.${chatId.slice(-8)}`);
      if (fs.existsSync(sleepMarker)) {
        process.stderr.write(
          `[supervisor] channel ${chatId.slice(-8)} 已下线（.bot.sleep marker 存在），不自动重启 — Owner手动从启动器恢复\n`,
        );
        return;
      }
      const now = Date.now();
      let state = this.crashState.get(chatId);
      if (!state) {
        state = { count: 0, windowStart: now };
        this.crashState.set(chatId, state);
      }
      // 已进入有界慢速自愈期：快重启与计数都交给慢速链，本次崩溃只记日志
      // （避免"快重启 + 慢速重启"双重启 + 计数窗口被重置打架）。
      if (state.slowRecoveryActive) {
        process.stderr.write(
          `[supervisor] channel ${chatId.slice(-8)} 慢速自愈期内又崩，等下次慢速尝试\n`,
        );
        return;
      }
      if (now - state.windowStart > 5 * 60_000) {
        state.windowStart = now;
        state.count = 0;
      }
      state.count++;
      if (state.count > 3) {
        // 抗断线加固：不再"永久等手动"，转入有界慢速自愈（每 5min 一次、上限 6 次≈30min）；
        // 仍救不回才发飞书通知Owner并彻底交手动 [↻]——绝不无限刷。
        state.slowRecoveryActive = true;
        state.recoveryCount = 0;
        process.stderr.write(
          `[supervisor] channel ${chatId.slice(-8)} 5min 内崩 ${state.count} 次，转入慢速自愈（每5min，上限6次）\n`,
        );
        this.scheduleSlowRecovery(chatId);
        return;
      }
      process.stderr.write(
        `[supervisor] channel ${chatId.slice(-8)} 崩溃，5s 后自动重启 (count=${state.count})\n`,
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

    // 频道常驻 + forget 守卫：若Owner主动 forgotten 过此频道，直接丢消息不重新 spawn
    if (this.channelConfigStore.isForgotten(msg.chat_id)) {
      process.stderr.write(
        `[supervisor] msg drop (chat ${msg.chat_id.slice(-8)} 已被Owner forget): ${(msg.text ?? '').slice(0, 40)}\n`,
      );
      return;
    }

    // 批3 完全静默：paused 时**只拦"自动新开频道"**，不拦已在运行的频道。
    // ⚠️ 关键修正：paused 仅阻止"未启动的频道被消息自动唤醒/spawn"；若该频道已被
    // 单独「启动」或「开启所有」拉起（在 channels Map 里），消息必须照常 push 给它——
    // 否则会出现"手动启动了频道却收不到消息"（Owner实测：单启 opus-4-6 频道仍被 paused 丢消息）。
    if (this.channelsPaused && !this.channels.has(msg.chat_id)) {
      process.stderr.write(
        `[supervisor] paused 且该频道未启动→丢弃消息（不自动 spawn）chat=${msg.chat_id.slice(-8)}: ${(msg.text ?? '').slice(0, 30)}\n`,
      );
      return;
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

    // 反查 chat_name 给子端 setChatNameCache 写盘日志用（消化 step 3 review Required #1）
    // 优先级：channel-config.json display_name > feishu chat.list name（chat.list 不含 P2P 单聊）
    const chatName =
      this.channelConfigStore.get(msg.chat_id)?.display_name ??
      this.feishuPoll?.getChats().find((c) => c.chat_id === msg.chat_id)?.name;
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

  private onChatListDiff(diff: ChatListDiff): void {
    for (const added of diff.added) {
      if (this.channelConfigStore.isForgotten(added.chat_id)) {
        process.stderr.write(
          `[supervisor] chat.list 新增但已被Owner forget，跳过 spawn: ${added.name ?? added.chat_id}\n`,
        );
        continue;
      }
      // 批3 完全静默：paused 时新群也不自动 spawn（点开启所有时 startAllChannels 走飞书 chat.list 会带上它）
      if (this.channelsPaused) {
        process.stderr.write(`[supervisor] paused，新群暂不 spawn（待开启所有）: ${added.name ?? added.chat_id}\n`);
        continue;
      }
      process.stderr.write(`[supervisor] 新群发现，自动 spawn: ${added.name ?? added.chat_id}\n`);
      this.spawnChannelCli(added.chat_id, added.name);
    }
    // 频道常驻语义（2026-05-28）：飞书 chat.list 返回 removed 不再主动 stop CLI——
    // 被踢/解散事件靠飞书 SDK 可能短时抖动（chat.list 拉空），误判 stop 会导致 CLI 反复重启。
    // 真要"删频道"走Owner主动 forget 路径（启动器 X 按钮 → forgetChannel()）。
    for (const removed of diff.removed) {
      process.stderr.write(
        `[supervisor] chat.list 不再返回此 chat（可能短时抖动 / 群解散），保持常驻 CLI: ${removed.name ?? removed.chat_id}\n`,
      );
    }
    this.emit('chat-list-diff', diff);
  }

  /**
   * Owner主动 forget 频道（启动器 X 按钮）。
   *   1. channel-config.json 落 forgotten=true 标记
   *   2. stop 该频道 CLI + 从 channels Map 移除
   *   3. 后续 onFeishuMessage 会因 isForgotten 直接丢消息不重 spawn
   *   4. 同频道有 pending scheduled_jobs 时本次不主动清——Owner未来再加该频道时这些 timer 自然 fire（按 chat_id 路由）
   */
  /** 设置页"已删除频道列表"用——含 chat_id + display_name */
  listForgottenChannels(): Array<{ chat_id: string; display_name?: string }> {
    return this.channelConfigStore.listForgottenChatIds();
  }

  /**
   * 设置页"恢复"按钮：清 forgotten 标记 + 立刻 spawn 该频道 CLI
   * 返回 true = 恢复成功；false = 该 chat_id 不在 forgotten 列表
   */
  restoreForgottenChannel(chatId: string): boolean {
    const ok = this.channelConfigStore.unmarkForgotten(chatId);
    if (!ok) return false;
    // 找一下飞书 chat.list 里的 chat_name（如有）反查 + 立刻 spawn
    const chatName = this.feishuPoll?.getChats().find((c) => c.chat_id === chatId)?.name;
    this.spawnChannelCli(chatId, chatName);
    process.stderr.write(`[supervisor] restored forgotten channel: ${chatId}\n`);
    this.emit('channel-state-changed', chatId);
    return true;
  }

  forgetChannel(chatId: string): boolean {
    if (!this.channels.has(chatId) && !this.channelConfigStore.get(chatId)) return false;
    this.channelConfigStore.markForgotten(chatId);
    const cli = this.channels.get(chatId);
    if (cli) {
      cli.stop();
      this.channels.delete(chatId);
    }
    this.channelUsage.delete(chatId);
    this.crashState.delete(chatId); // D1: 频道彻底忘记才清熔断计数（正常 respawn 不清=熔断跨 respawn 持续）
    this.pendingInbound.delete(chatId); // D2: 清未就绪缓冲队列，避免泄漏
    process.stderr.write(`[supervisor] forget channel: ${chatId}\n`);
    this.emit('channel-state-changed', chatId);
    return true;
  }
}
