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
import type { WorkSession } from './work-session.js';
import {
  IPC_METHODS,
  WARDEN_BRIDGE_PORT,
  WARDEN_CLIENT_ID,
  type WorkOkResult,
  type WardenSystemInfo,
  type WardenTerminalDataParams,
  type WardenLogEntry,
} from '../src/ipc/protocol.js';

/** 全局默认设置快照（频道默认 + work 默认） */
export interface WardenDefaults {
  channel: { model: string; effort: string; fast: boolean; autoCompactPct: number };
  work: { model: string; effort: string; fast: boolean };
}

export interface WardenBridgeDeps {
  getChannels: () => Map<string, ChannelCli>;
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
  setDisplayName: (chatId: string, name: string) => void;
  // 批2 额度
  fetchQuota: () => Promise<{ quota: unknown; today_messages: number; rate_limits: unknown }>;
  // 批3 work session
  getWorkSessions: () => Map<string, WorkSession>;
  getWorkSession: (sessionId: string) => WorkSession | undefined;
  // 批4 全局设置 + 系统 + 日志
  getDefaults: () => WardenDefaults;
  setDefaults: (patch: { model?: string; effort?: string; fast?: boolean; autoCompactPct?: number }) => void;
  setWorkDefaults: (patch: { model?: string; effort?: string; fast?: boolean }) => void;
  restartSupervisor: () => Promise<void>;
  quitApp: () => void;
  getRecentLogs: (limit: number) => WardenLogEntry[];
}

export async function createWardenBridge(deps: WardenBridgeDeps): Promise<IpcServer> {
  const bridge = new IpcServer();

  bridge.setRequestHandler(IPC_METHODS.WARDEN_LIST_CLIS, async () => {
    return {
      clis: [...deps.getChannels().values()].map((c) => {
        const stats = c.getStats();
        return { ...stats, usage: deps.getUsage(stats.chat_id) };
      }),
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
    const p = (params ?? {}) as {
      chat_id?: string;
      model?: string;
      effort?: string;
      fast?: boolean;
      autoCompactPct?: number;
    };
    if (!p.chat_id) return { ok: false, error: 'no chat_id' };
    deps.setChannelConfig(p.chat_id, p);
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

  // ── 批3 work session（列表 + 终端看/写/结束）──
  bridge.setRequestHandler(IPC_METHODS.WARDEN_LIST_WORK, async () => {
    return { sessions: [...deps.getWorkSessions().values()].map((ws) => ws.getStats()) };
  });

  // work 终端复用 TERMINAL_DATA 推送，以 session_id 作路由 key（与频道 chat_id 不冲突，ws_ 前缀）
  bridge.setRequestHandler(IPC_METHODS.WARDEN_WORK_SUB_TERMINAL, async (params): Promise<WorkOkResult> => {
    const { session_id } = (params ?? {}) as { session_id?: string };
    const ws = session_id ? deps.getWorkSession(session_id) : undefined;
    if (!ws || !session_id) return { ok: false, error: `no work session ${session_id}` };
    ws.attachTerminal((data) => {
      const payload: WardenTerminalDataParams = { chat_id: session_id, data };
      bridge.pushNotification(WARDEN_CLIENT_ID, IPC_METHODS.WARDEN_TERMINAL_DATA, payload);
    });
    return { ok: true };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_WORK_UNSUB_TERMINAL, async (params): Promise<WorkOkResult> => {
    const { session_id } = (params ?? {}) as { session_id?: string };
    const ws = session_id ? deps.getWorkSession(session_id) : undefined;
    ws?.detachTerminal();
    return { ok: true };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_WORK_SEND, async (params): Promise<WorkOkResult> => {
    const { session_id, text } = (params ?? {}) as { session_id?: string; text?: string };
    const ws = session_id ? deps.getWorkSession(session_id) : undefined;
    if (!ws) return { ok: false, error: `no work session ${session_id}` };
    const sent = ws.sendMessage(text ?? '');
    return sent ? { ok: true } : { ok: false, error: 'work CLI not running' };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_WORK_END, async (params): Promise<WorkOkResult> => {
    const { session_id } = (params ?? {}) as { session_id?: string };
    const ws = session_id ? deps.getWorkSession(session_id) : undefined;
    if (!ws) return { ok: false, error: `no work session ${session_id}` };
    ws.end();
    return { ok: true };
  });

  // ── 批4 全局设置 + 系统 + 日志 ──
  bridge.setRequestHandler(IPC_METHODS.WARDEN_GET_DEFAULTS, async () => {
    return deps.getDefaults();
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_SET_DEFAULTS, async (params): Promise<WorkOkResult> => {
    const p = (params ?? {}) as { model?: string; effort?: string; fast?: boolean; autoCompactPct?: number };
    deps.setDefaults(p);
    return { ok: true };
  });

  bridge.setRequestHandler(IPC_METHODS.WARDEN_SET_WORK_DEFAULTS, async (params): Promise<WorkOkResult> => {
    const p = (params ?? {}) as { model?: string; effort?: string; fast?: boolean };
    deps.setWorkDefaults(p);
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
