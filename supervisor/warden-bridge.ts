/**
 * 管家(warden)桥接 server —— supervisor 暴露给独立管家进程的固定端口 NDJSON 通道。
 *
 * 复用 IpcServer（与子进程 IPC 同款 NDJSON 框架），但监听**固定端口** WARDEN_BRIDGE_PORT——
 * 管家不是 supervisor spawn 的子进程，拿不到动态端口 env，必须约定固定端口才连得上(R1)。
 * 与子进程 IPC（动态端口）完全独立，互不干扰。
 *
 * 提供：list-clis(看状态) / restart-cli / stop-cli / system-info。
 * 终端订阅(sub/unsub + TERMINAL_DATA push) 见步骤 3 扩展。
 */
import { IpcServer } from './ipc-server.js';
import type { ChannelCli } from './channel-cli.js';
import { tokenMatches } from '../src/ipc/bridge-token.js';
import {
  IPC_METHODS,
  WARDEN_BRIDGE_PORT,
  WARDEN_CLIENT_ID,
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  type HelloParams,
  type WorkOkResult,
  type WardenSystemInfo,
  type WardenTerminalDataParams,
  type WardenLogEntry,
} from '../src/ipc/protocol.js';

/** 全局默认设置快照（频道默认，deps.getDefaults() 只需提供这部分） */
export interface ChannelDefaults {
  channel: { model: string; effort: string; fast: boolean; autoCompactPct: number };
}

/** WARDEN_GET_DEFAULTS 的完整响应：频道默认 + model/effort 清单单源（供启动器设置页 / 管家页下拉渲染） */
export interface WardenDefaults extends ChannelDefaults {
  options: { models: string[]; efforts: string[] };
}

// effort 五档单源见 src/ipc/protocol.ts EFFORT_OPTIONS
const VALID_EFFORTS = EFFORT_OPTIONS;

/** set-config / set-defaults 入参净化：只挑 model/effort/fast/autoCompactPct 四个字段（不透传任意其它键）；
 *  effort 传了但不在五档内 → 整请求判非法；autoCompactPct 非有限数则丢弃该字段，是则夹到 20-70。 */
function sanitizeChannelPatch(
  raw: unknown,
): { ok: true; patch: { model?: string; effort?: string; fast?: boolean; autoCompactPct?: number } } | { ok: false; error: string } {
  const p = (raw ?? {}) as {
    model?: unknown;
    effort?: unknown;
    fast?: unknown;
    autoCompactPct?: unknown;
  };
  if (p.effort !== undefined && !VALID_EFFORTS.includes(p.effort as string)) {
    return { ok: false, error: `invalid effort: ${String(p.effort)}` };
  }
  const patch: { model?: string; effort?: string; fast?: boolean; autoCompactPct?: number } = {};
  if (typeof p.model === 'string') patch.model = p.model;
  if (typeof p.effort === 'string') patch.effort = p.effort;
  if (typeof p.fast === 'boolean') patch.fast = p.fast;
  if (typeof p.autoCompactPct === 'number' && Number.isFinite(p.autoCompactPct)) {
    patch.autoCompactPct = Math.min(70, Math.max(20, p.autoCompactPct));
  }
  return { ok: true, patch };
}

export interface WardenBridgeDeps {
  getChannels: () => Map<string, ChannelCli>;
  /** 展示用频道列表：已 spawn 的真实状态 + 已识别但睡眠/未 spawn 的合成"停止卡"（list-clis 用它，不用 getChannels） */
  getDisplayChannels: () => Array<ReturnType<ChannelCli['getStats']>>;
  getSystemInfo: () => WardenSystemInfo;
  /** per-CLI 上下文用量（context_pct/cost 等，来自 statusLine）；透传给手机仪表盘 */
  getUsage: (chatId: string) => unknown;
  // 批1 频道管理
  startChannel: (chatId: string) => void;
  /** 关闭频道 + evict 出 Map（归属不变）→ 下条消息可唤醒。手机✕关闭用。 */
  pauseChannel: (chatId: string) => void;
  setChannelConfig: (
    chatId: string,
    cfg: { model?: string; effort?: string; fast?: boolean; autoCompactPct?: number },
  ) => void;
  /** 改配置并立即生效（运行中的频道 --resume 重启）；未注入时退回只写配置 */
  applyChannelConfigLive?: (
    chatId: string,
    patch: { model?: string; effort?: string; fast?: boolean; autoCompactPct?: number },
  ) => void;
  setDisplayName: (chatId: string, name: string) => void;
  // 批2 额度
  fetchQuota: () => Promise<{ quota: unknown; today_messages: number; rate_limits: unknown }>;
  // 批4 全局设置 + 系统 + 日志
  getDefaults: () => ChannelDefaults;
  setDefaults: (patch: { model?: string; effort?: string; fast?: boolean; autoCompactPct?: number }) => void;
  restartSupervisor: () => Promise<void>;
  quitApp: () => void;
  getRecentLogs: (limit: number) => WardenLogEntry[];
}

export async function createWardenBridge(deps: WardenBridgeDeps, token: string): Promise<IpcServer> {
  const bridge = new IpcServer();
  // 本端口能关品品 / 写 CLI 输入：首帧必须是带口令的 hello
  bridge.setAuthGate(IPC_METHODS.HELLO, (p) => tokenMatches((p as HelloParams | undefined)?.token, token));

  bridge.setRequestHandler(IPC_METHODS.WARDEN_LIST_CLIS, async () => {
    return {
      clis: deps.getDisplayChannels().map((stats) => ({ ...stats, usage: deps.getUsage(stats.chat_id) })),
    };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_SYSTEM_INFO, async () => {
    return deps.getSystemInfo();
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_RESTART_CLI, async (params): Promise<WorkOkResult> => {
    const { chat_id } = (params ?? {}) as { chat_id?: string };
    const cli = chat_id ? deps.getChannels().get(chat_id) : undefined;
    if (!cli) return { ok: false, error: `no CLI for chat ${chat_id}` };
    cli.restart();
    return { ok: true };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_STOP_CLI, async (params): Promise<WorkOkResult> => {
    const { chat_id } = (params ?? {}) as { chat_id?: string };
    if (!chat_id) return { ok: false, error: 'no chat_id' };
    deps.pauseChannel(chat_id); // 关闭 + evict（归属不变）→ 下条消息可唤醒
    return { ok: true };
  });

  // ── 批1 频道完整管理 ──
  bridge.setRequestHandler(IPC_METHODS.WARDEN_START_CLI, async (params): Promise<WorkOkResult> => {
    const { chat_id } = (params ?? {}) as { chat_id?: string };
    if (!chat_id) return { ok: false, error: 'no chat_id' };
    deps.startChannel(chat_id);
    return { ok: true };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_COMPACT_CLI, async (params): Promise<WorkOkResult> => {
    const { chat_id } = (params ?? {}) as { chat_id?: string };
    const cli = chat_id ? deps.getChannels().get(chat_id) : undefined;
    if (!cli) return { ok: false, error: `no CLI for chat ${chat_id}` };
    cli.compact();
    return { ok: true };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_SET_CONFIG, async (params): Promise<WorkOkResult> => {
    const { chat_id } = (params ?? {}) as { chat_id?: string };
    if (!chat_id) return { ok: false, error: 'no chat_id' };
    const sanitized = sanitizeChannelPatch(params);
    if (!sanitized.ok) return { ok: false, error: sanitized.error };
    (deps.applyChannelConfigLive ?? deps.setChannelConfig)(chat_id, sanitized.patch);
    return { ok: true };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_SET_NAME, async (params): Promise<WorkOkResult> => {
    const { chat_id, name } = (params ?? {}) as { chat_id?: string; name?: string };
    if (!chat_id) return { ok: false, error: 'no chat_id' };
    deps.setDisplayName(chat_id, name ?? '');
    return { ok: true };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_SEND_INPUT, async (params): Promise<WorkOkResult> => {
    const { chat_id, text } = (params ?? {}) as { chat_id?: string; text?: string };
    const cli = chat_id ? deps.getChannels().get(chat_id) : undefined;
    if (!cli) return { ok: false, error: `no CLI for chat ${chat_id}` };
    cli.sendInput(text ?? '');
    return { ok: true };
  });

  // 终端订阅：attach ring buffer 回放+实时流，经 TERMINAL_DATA push 给已注册的管家 client。
  // ⚠️ attachTerminal 单 consumer——管家 attach 会接管该频道终端流（桌面终端窗与手机互踢，Not-Doing 已声明）。
  bridge.setRequestHandler(IPC_METHODS.WARDEN_SUB_TERMINAL, async (params): Promise<WorkOkResult> => {
    const { chat_id } = (params ?? {}) as { chat_id?: string };
    const cli = chat_id ? deps.getChannels().get(chat_id) : undefined;
    if (!cli || !chat_id) return { ok: false, error: `no CLI for chat ${chat_id}` };
    cli.attachTerminal((data) => {
      const payload: WardenTerminalDataParams = { chat_id, data };
      bridge.pushNotification(WARDEN_CLIENT_ID, IPC_METHODS.WARDEN_TERMINAL_DATA, payload);
    });
    return { ok: true };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_UNSUB_TERMINAL, async (params): Promise<WorkOkResult> => {
    const { chat_id } = (params ?? {}) as { chat_id?: string };
    const cli = chat_id ? deps.getChannels().get(chat_id) : undefined;
    cli?.detachTerminal();
    return { ok: true };
  });

  // ── 批2 额度 ──
  bridge.setRequestHandler(IPC_METHODS.WARDEN_FETCH_QUOTA, async () => {
    return deps.fetchQuota();
  });

  // ── 批4 全局设置 + 系统 + 日志 ──
  bridge.setRequestHandler(IPC_METHODS.WARDEN_GET_DEFAULTS, async (): Promise<WardenDefaults> => {
    return { ...deps.getDefaults(), options: { models: MODEL_OPTIONS, efforts: EFFORT_OPTIONS } };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_SET_DEFAULTS, async (params): Promise<WorkOkResult> => {
    const sanitized = sanitizeChannelPatch(params);
    if (!sanitized.ok) return { ok: false, error: sanitized.error };
    deps.setDefaults(sanitized.patch);
    return { ok: true };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_RESTART_SUPERVISOR, async (): Promise<WorkOkResult> => {
    // 不 await——restart 会 stop 当前 IPC 连接，await 会让本响应发不回去；fire-and-forget
    void deps.restartSupervisor();
    return { ok: true };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_QUIT_APP, async (): Promise<WorkOkResult> => {
    deps.quitApp();
    return { ok: true };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_RECENT_LOGS, async (params) => {
    const { limit } = (params ?? {}) as { limit?: number };
    return { logs: deps.getRecentLogs(Math.min(Math.max(limit ?? 100, 1), 500)) };
  });

  await bridge.start({ port: WARDEN_BRIDGE_PORT });
  process.stderr.write(`[warden-bridge] listening 127.0.0.1:${WARDEN_BRIDGE_PORT}\n`);
  return bridge;
}
