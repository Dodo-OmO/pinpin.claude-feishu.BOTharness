import { contextBridge, ipcRenderer } from 'electron';
import type {
  ChannelStatusInfo,
  SupervisorStateSnapshot,
  LogEntry,
  AppSettings,
  QuotaSnapshot,
  RateLimitWindow,
  NameMappings,
  PendingNameEntry,
  WorkerStatusInfo,
} from '../shared-types.js';

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  /** 拉一次完整 supervisor 状态（频道 + chats） */
  getState: (): Promise<SupervisorStateSnapshot> => ipcRenderer.invoke('get-state'),
  /** 订阅状态变更（每次 supervisor 内部事件触发时 push） */
  onState: (cb: (state: SupervisorStateSnapshot) => void): (() => void) => {
    const listener = (_: unknown, state: SupervisorStateSnapshot): void => cb(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
  /** 订阅统一日志流 */
  onLog: (cb: (entry: LogEntry) => void): (() => void) => {
    const listener = (_: unknown, entry: LogEntry): void => cb(entry);
    ipcRenderer.on('log', listener);
    return () => ipcRenderer.removeListener('log', listener);
  },
  /** 订阅 ccusage quota 推送 */
  onQuota: (cb: (snap: QuotaSnapshot) => void): (() => void) => {
    const listener = (_: unknown, snap: QuotaSnapshot): void => cb(snap);
    ipcRenderer.on('quota', listener);
    return () => ipcRenderer.removeListener('quota', listener);
  },
  /** 频道动作 */
  channel: {
    start: (chatId: string): Promise<void> => ipcRenderer.invoke('channel.start', chatId),
    stop: (chatId: string): Promise<void> => ipcRenderer.invoke('channel.stop', chatId),
    restart: (chatId: string): Promise<void> => ipcRenderer.invoke('channel.restart', chatId),
    compact: (chatId: string): Promise<void> => ipcRenderer.invoke('channel.compact', chatId),
    openTerminal: (chatId: string): Promise<void> => ipcRenderer.invoke('terminal.open', chatId),
    setModel: (chatId: string, model: string): Promise<void> =>
      ipcRenderer.invoke('channel.set-model', chatId, model),
    setEffort: (chatId: string, effort: string): Promise<void> =>
      ipcRenderer.invoke('channel.set-effort', chatId, effort),
    setCompactThreshold: (chatId: string, pct: number): Promise<void> =>
      ipcRenderer.invoke('channel.set-compact-threshold', chatId, pct),
    setFast: (chatId: string, fast: boolean): Promise<void> =>
      ipcRenderer.invoke('channel.set-fast', chatId, fast),
    setStandby: (chatId: string, standby: boolean): Promise<void> =>
      ipcRenderer.invoke('channel.set-standby', chatId, standby),
    setDisplayName: (chatId: string, name: string): Promise<void> =>
      ipcRenderer.invoke('channel.set-display-name', chatId, name),
  },
  /** App 控制 */
  app: {
    restartBot: (): Promise<void> => ipcRenderer.invoke('app.restart-bot'),
    quit: (): Promise<void> => ipcRenderer.invoke('app.quit'),
  },
  /** 设置 */
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings.get'),
    set: (s: Partial<AppSettings>): Promise<void> => ipcRenderer.invoke('settings.set', s),
  },
  /** P1.3: quota 按需获取（footer "获取 quota" 按钮） */
  quota: {
    fetchNow: (): Promise<{ ok: true } | null> => ipcRenderer.invoke('quota.fetch-now'),
  },
  /** 认识的人 / bot 映射管理（设置 page 面板用） */
  names: {
    getMappings: (): Promise<NameMappings> => ipcRenderer.invoke('names.get-mappings'),
    getPending: (): Promise<PendingNameEntry[]> => ipcRenderer.invoke('names.get-pending'),
    set: (type: 'human' | 'bot', id: string, name: string): Promise<void> =>
      ipcRenderer.invoke('names.set', type, id, name),
  },
  /** 每频道注入哪些人物画像（多选；纯写 vault json，重启该频道生效） */
  personas: {
    list: (): Promise<string[]> => ipcRenderer.invoke('personas.list'),
    get: (chatId: string): Promise<string[] | '__ALL__'> => ipcRenderer.invoke('personas.get', chatId),
    set: (chatId: string, sel: string[] | '__ALL__'): Promise<void> =>
      ipcRenderer.invoke('personas.set', chatId, sel),
  },
  /** 常驻工人托管（医生 / 总导演 / 顺子）：唤醒 / 结束；终端沿用 channel.openTerminal 传 `worker:<name>`。 */
  worker: {
    wake: (name: string): Promise<{ ok: boolean; state?: 'woke' | 'already' | 'failed'; error?: string }> =>
      ipcRenderer.invoke('worker.wake', name),
    stop: (name: string): Promise<void> => ipcRenderer.invoke('worker.stop', name),
  },
};

export type {
  ChannelStatusInfo,
  SupervisorStateSnapshot,
  LogEntry,
  AppSettings,
  QuotaSnapshot,
  RateLimitWindow,
  NameMappings,
  PendingNameEntry,
  WorkerStatusInfo,
} from '../shared-types.js';

contextBridge.exposeInMainWorld('pinpin', api);

// ── 终端子窗口 API（terminal.html 用）──
const terminalApi = {
  /** 主进程开始 forward 该 chat 的 PTY 流到本窗口；返回 unsubscribe */
  attachPty: (chatId: string, cb: (data: string) => void): (() => void) => {
    const channel = `pty-data:${chatId}`;
    const listener = (_: unknown, chunk: string): void => cb(chunk);
    ipcRenderer.on(channel, listener);
    // 通知 main 把 PTY ring buffer replay + 后续 onData 转发过来
    ipcRenderer.send('terminal.subscribe-pty', chatId);
    return () => {
      ipcRenderer.removeListener(channel, listener);
      ipcRenderer.send('terminal.unsubscribe-pty', chatId);
    };
  },
  /** 把 xterm FitAddon fit 后的实际尺寸同步回 PTY（修复 ANSI 排版错位） */
  resizePty: (chatId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('terminal.resize-pty', chatId, cols, rows),
  /** PTY write to channel CLI stdin（如 /compact 由 compact() 已包） */
  sendInput: (chatId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('terminal.input', chatId, text),
  /** PTY write /compact\\n */
  compact: (chatId: string): Promise<void> => ipcRenderer.invoke('terminal.compact', chatId),
  /** restart 该频道 CLI */
  restart: (chatId: string): Promise<boolean> => ipcRenderer.invoke('terminal.restart', chatId),
  /** 取 header meta */
  getMeta: (chatId: string): Promise<{ chat_name?: string; model: string; effort: string; status: string }> =>
    ipcRenderer.invoke('terminal.get-meta', chatId),
};

contextBridge.exposeInMainWorld('terminal', terminalApi);

export type PinpinApi = typeof api;
export type TerminalApi = typeof terminalApi;

