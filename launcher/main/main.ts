import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } from 'electron';
import windowStateKeeper from 'electron-window-state';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Supervisor } from '../../supervisor/index.js';
import {
  resolveSenderNameSync,
  resolveMentions,
  type FeishuMention,
} from '../../supervisor/sender-resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const APP_ROOT = app.getAppPath();
const VAULT_CWD = process.env['PINPIN_VAULT_CWD'] ?? '/path/to/obsidian-vault';

dotenv.config({ path: join(APP_ROOT, '.env') });
process.env['PINPIN_DB_PATH'] = join(APP_ROOT, 'data.db');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuiting = false;
let supervisor: Supervisor | null = null;
/** chat_id → 终端子窗口（同 chat 只允许一个终端窗，避免 detach 紊乱） */
const terminalWindows = new Map<string, BrowserWindow>();
/** Q5: session_id → work session 终端子窗（同 session 只允许一个窗，避免 detach 紊乱） */
const workTerminalWindows = new Map<string, BrowserWindow>();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

function createMainWindow(): void {
  const winState = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 800,
  });

  mainWindow = new BrowserWindow({
    x: winState.x,
    y: winState.y,
    width: winState.width,
    height: winState.height,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: '品品 channel',
    icon: join(__dirname, '../../launcher/renderer/assets/品品图标.png'),
    autoHideMenuBar: true,
    // Win 11 原生 caption（任务 MD §其他对齐：Win 11 原生最小化/最大化/关闭 buttons）
    titleBarStyle: 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  winState.manage(mainWindow);

  if (winState.isMaximized) mainWindow.maximize();

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function createTray(): void {
  const iconPath = join(__dirname, '../../launcher/renderer/assets/品品图标.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('品品 channel');
  const menu = Menu.buildFromTemplate([
    {
      label: '显示主面板',
      click: () => {
        if (!mainWindow) createMainWindow();
        else {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出品品',
      click: () => {
        isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

interface SupervisorStateSnapshot {
  ipc_port: number;
  chats: Array<{ chat_id: string; name?: string }>;
  channels: ChannelStatusInfo[];
  work_sessions: WorkSessionInfo[];
  today_messages: number;
}

interface ChannelStatusInfo {
  chat_id: string;
  chat_name?: string;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  pid?: number;
  uptime_ms: number;
  /** CLI 进程启动时刻（Date.now()）；停止时为 null。用于卡片显示绝对启动时间 */
  started_at?: number | null;
  model: string;
  effort: string;
  /** 自动压缩阈值（上下文用量百分比）。 */
  autoCompactPct?: number;
  /** fast 模式（Opus 加速输出）。 */
  fast?: boolean;
  /** P1.3: per-CLI 上下文用量（statusLine sink 推过来） */
  context_pct?: number | null;
  context_tokens?: number | null;
  context_window_size?: number | null;
  cost_usd?: number | null;
  usage_updated_at?: number;
}

interface WorkSessionInfo {
  session_id: string;
  origin_chat_id: string;
  work_dir: string;
  fast?: boolean;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  pid?: number;
  uptime_ms: number;
  model: string;
  effort: string;
  /** Q4 续: work session 上下文用量（jsonl assistant.usage 实时解析） */
  context_tokens?: number;
  context_window_size?: number | null;
  context_pct?: number | null;
}

function snapshotState(): SupervisorStateSnapshot {
  if (!supervisor) {
    return { ipc_port: 0, chats: [], channels: [], work_sessions: [], today_messages: 0 };
  }
  const sv = supervisor;
  return {
    ipc_port: sv.getIpcPort(),
    chats: sv.getChats(),
    // P1.3: 拼装 per-CLI usage（statusLine sink 推过来的，事件驱动）
    // 批3 Bug 修复：用 getDisplayChannels（含 paused 时未 spawn 的已知频道合成停止卡），
    // 让启动前能看到所有频道卡、预配 model/effort 再开启所有。
    channels: sv.getDisplayChannels().map((c) => {
      const u = sv.getChannelUsage(c.chat_id);
      return {
        ...c,
        context_pct: u?.context_pct ?? null,
        context_tokens: u?.context_tokens ?? null,
        context_window_size: u?.context_window_size ?? null,
        cost_usd: u?.cost_usd ?? null,
        usage_updated_at: u?.updated_at,
      };
    }),
    work_sessions: sv.getWorkSessionStats(),
    today_messages: sv.getTodayMessageCount(),
  };
}

interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

function pushLog(entry: LogEntry): void {
  // 同步灌进 supervisor ring buffer，供管家手机端 warden.recent-logs 读
  supervisor?.recordLog(entry);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', entry);
  }
}

/** P1.3: pushState debounce 100ms，避免 statusline-update 高频触发时 renderer 被淹 */
let pendingPush: NodeJS.Timeout | null = null;
function pushState(): void {
  if (pendingPush) return;
  pendingPush = setTimeout(() => {
    pendingPush = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('state', snapshotState());
    }
  }, 100);
}

/** 把 chat_id 翻译成飞书可读名（群名/单聊名）；找不到 fallback chat_id 末 8 位。
 *  feedback domain-feishu-mcp: UI 层飞书标识符必须翻译成可读名称，禁止显示 chat_id/oc_xxx
 *  2026-05-28 修：原版只查飞书 chat.list（P2P 不返），改用 supervisor.getChannelDisplayName
 *  优先级 = 用户自定义 display_name > 飞书 chat_name > chat_id slice. */
function getChatDisplayName(chatId: string): string {
  if (!supervisor) return chatId.slice(-8);
  return supervisor.getChannelDisplayName(chatId);
}

// 1Hz state push（low-rate；事件驱动 + 周期心跳兼用）
let stateTickTimer: NodeJS.Timeout | null = null;

app.whenReady().then(async () => {
  const feishuAppId = process.env['FEISHU_APP_ID'];
  const feishuAppSecret = process.env['FEISHU_APP_SECRET'];
  if (!feishuAppId || !feishuAppSecret) {
    process.stderr.write(
      '[main] FATAL: FEISHU_APP_ID / FEISHU_APP_SECRET 缺失（.env 未配置）\n',
    );
    app.quit();
    return;
  }

  supervisor = new Supervisor({
    appRoot: APP_ROOT,
    // P1.2: channel-config.json 等 runtime 配置落 userData（app.getAppPath() 打包后是 asar 只读）
    dataDir: app.getPath('userData'),
    vaultCwd: VAULT_CWD,
    feishuAppId,
    feishuAppSecret,
  });
  // 把 supervisor 关键事件转日志推 renderer
  supervisor.on('feishu-message', (msg) => {
    // Owner P3 反馈：日志流 sender 显真名 + @人占位符替换为 @真名（不显 user_X 编号）
    const senderName = resolveSenderNameSync(msg.sender_open_id, msg.sender_type);
    const raw = msg.raw as { mentions?: FeishuMention[] } | undefined;
    const txt = resolveMentions(msg.text ?? `(${msg.msg_type})`, raw?.mentions);
    pushLog({
      ts: Date.now(),
      level: 'info',
      source: getChatDisplayName(msg.chat_id),
      message: `收到 from ${senderName}: ${txt.slice(0, 80)}`,
    });
  });
  supervisor.on('chat-list-diff', (diff) => {
    for (const a of diff.added) {
      pushLog({ ts: Date.now(), level: 'info', source: 'supervisor', message: `新群发现：${a.name ?? a.chat_id}` });
    }
    for (const r of diff.removed) {
      pushLog({ ts: Date.now(), level: 'warn', source: 'supervisor', message: `群被踢/解散：${r.name ?? r.chat_id}` });
    }
    pushState();
  });
  supervisor.on('channel-mcp-ready', (info) => {
    pushLog({ ts: Date.now(), level: 'info', source: getChatDisplayName(info.chat_id), message: `IPC client up (pid=${info.pid})` });
    pushState();
  });
  supervisor.on('quota', (snap) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('quota', snap);
    }
    if (!snap.available && snap.error) {
      pushLog({ ts: Date.now(), level: 'warn', source: 'ccusage', message: `quota 暂不可用: ${snap.error.slice(0, 80)}` });
    }
  });
  // 管家手机端"关闭品品"：经 supervisor 事件转 app.quit（带 isQuiting 标志，否则只最小化到托盘）。
  // 不弹桌面确认框——Owner远程不在电脑前，手机端已二次确认。
  supervisor.on('warden-request-quit', () => {
    pushLog({ ts: Date.now(), level: 'warn', source: 'app', message: '管家手机端请求关闭品品' });
    isQuiting = true;
    app.quit();
  });
  // P1.2: channel 状态变即推 state（事件驱动，替代 1Hz 心跳 race）
  supervisor.on('channel-state-changed', () => pushState());

  await supervisor.start();
  process.stderr.write(`[main] supervisor up (ipc=:${supervisor.getIpcPort()})\n`);
  pushLog({ ts: Date.now(), level: 'info', source: 'supervisor', message: `started (ipc=:${supervisor.getIpcPort()})` });

  createMainWindow();
  createTray();

  // P1.3: 心跳 push 从 1Hz 改 30s（uptime 文本"X min 前"30s 精度足够；
  //       状态变化已由 channel-state-changed 事件驱动 + debounced pushState 兜底）
  stateTickTimer = setInterval(() => pushState(), 30000);

  // ── IPC handlers ──
  ipcMain.handle('ping', () => {
    const running = supervisor?.isRunning() ? 'running' : 'stopped';
    const port = supervisor?.getIpcPort() ?? 0;
    return `pong · supervisor=${running} · ipc=${port}`;
  });

  ipcMain.handle('get-state', () => snapshotState());

  ipcMain.handle('channel.start', (_, chatId: string) => {
    const c = supervisor?.getChannel(chatId);
    if (c) {
      c.start();
    } else {
      // 没在 pool 里 → spawn
      const chat = supervisor?.getChats().find((x) => x.chat_id === chatId);
      supervisor?.spawnChannelCli(chatId, chat?.name);
    }
    pushState();
  });
  // 批3「开启所有」：解除 paused + 开启所有已识别频道（启动器默认完全静默，点这个才上线）
  ipcMain.handle('channel.start-all', () => {
    supervisor?.startAllChannels();
    pushLog({ ts: Date.now(), level: 'info', source: 'app', message: '已开启所有频道（解除暂停）' });
    pushState();
  });
  ipcMain.handle('channel.stop', async (_, chatId: string) => {
    // 2026-05-28 多 CLI 兜底：停"系统 cron host"（茶水间 / Owner单聊）前先弹原生 warning
    // 让Owner知情——这两个 CLI 持有 daily-news / weekly-recap / memory-audit 等系统 cron
    const isCronHost =
      (process.env['PINPIN_TEA_CHAT_ID'] && chatId === process.env['PINPIN_TEA_CHAT_ID']) ||
      (process.env['PINPIN_OWNER_CHAT_ID'] && chatId === process.env['PINPIN_OWNER_CHAT_ID']);
    if (isCronHost) {
      const isTea = chatId === process.env['PINPIN_TEA_CHAT_ID'];
      const role = isTea ? '茶水间' : 'Owner单聊';
      const crons = isTea
        ? 'daily-news / weekly-recap / daily-diary / free-activity'
        : 'daily-briefing / memory-audit';
      const choice = await dialog.showMessageBox(mainWindow ?? new BrowserWindow({ show: false }), {
        type: 'warning',
        buttons: ['取消', '仍要停止'],
        defaultId: 0,
        cancelId: 0,
        title: '停止系统 cron host CLI',
        message: `「${getChatDisplayName(chatId)}」是 ${role} CLI，持有系统 cron`,
        detail: [
          `停止后以下 cron 会暂停，直到Owner手动重启该 CLI：`,
          `  ${crons}`,
          '',
          `（mood-decay / feishu-token-keepalive / daily-restart 三个由 supervisor 跑，不受 CLI stop 影响。）`,
        ].join('\n'),
        noLink: true,
      });
      if (choice.response !== 1) return; // 0 = 取消 / 关窗
    }
    supervisor?.getChannel(chatId)?.stop();
    pushState();
  });
  ipcMain.handle('channel.restart', (_, chatId: string) => {
    // P1.2: restart 前先把 persisted config 灌进 channel-cli.opts，避免切完配置后 restart 仍用旧值
    supervisor?.reloadChannelConfigInto(chatId);
    supervisor?.getChannel(chatId)?.restart();
    pushState();
  });
  ipcMain.handle('channel.compact', (_, chatId: string) => {
    supervisor?.getChannel(chatId)?.compact();
  });
  // P1.2: 切 model / effort（持久化 + 更新 channel-cli.opts；CLI 不支持热切换，需手动 restart 生效）
  ipcMain.handle('channel.set-model', (_, chatId: string, model: string) => {
    supervisor?.setChannelConfig(chatId, { model });
    pushState();
  });
  ipcMain.handle('channel.set-effort', (_, chatId: string, effort: string) => {
    supervisor?.setChannelConfig(chatId, { effort });
    pushState();
  });
  // 每频道自动压缩阈值（持久化 + 更新 channel-cli.opts；同 model/effort 需 restart 生效）
  ipcMain.handle('channel.set-compact-threshold', (_, chatId: string, pct: number) => {
    supervisor?.setChannelConfig(chatId, { autoCompactPct: pct });
    pushState();
  });
  // 每频道 fast 模式（持久化 + 更新 channel-cli.opts；需 restart 生效）
  ipcMain.handle('channel.set-fast', (_, chatId: string, fast: boolean) => {
    supervisor?.setChannelConfig(chatId, { fast });
    pushState();
  });
  // P4.Q3 续：改卡片显示名
  ipcMain.handle('channel.set-display-name', (_, chatId: string, name: string) => {
    supervisor?.setChannelDisplayName(chatId, name);
    pushState();
  });
  // 2026-05-28 频道常驻 + forget：设置页"已删除频道"列表 + 恢复入口
  ipcMain.handle('channel.list-forgotten', () => supervisor?.listForgottenChannels() ?? []);
  ipcMain.handle('channel.restore-forgotten', (_, chatId: string): boolean => {
    const ok = supervisor?.restoreForgottenChannel(chatId) ?? false;
    pushLog({
      ts: Date.now(),
      level: ok ? 'info' : 'warn',
      source: 'launcher',
      message: ok ? `频道 ${chatId.slice(-8)} 已恢复` : `频道 ${chatId.slice(-8)} 恢复失败（不在 forgotten 列表）`,
    });
    pushState();
    return ok;
  });
  // 2026-05-28 频道常驻 + forget：先 main process 弹原生确认 dialog（renderer window.confirm 默认禁用）
  // → 用户确认 → 标记 forgotten + stop CLI + 后续不再重 spawn
  ipcMain.handle('channel.forget', async (_, chatId: string): Promise<boolean> => {
    if (!supervisor) return false;
    const displayName = getChatDisplayName(chatId);
    const choice = await dialog.showMessageBox(mainWindow ?? new BrowserWindow({ show: false }), {
      type: 'warning',
      buttons: ['取消', '删除'],
      defaultId: 0,
      cancelId: 0,
      title: '删除频道',
      message: `确定删除频道「${displayName}」？`,
      detail: [
        '· 停止该频道的品品 CLI',
        '· 启动器不再显示此卡片',
        '· 飞书在此频道再发消息也不会重连',
        '',
        '若想恢复：手动编辑 channel-config.json，把对应 chat_id 的 forgotten 字段删掉，重启品品即可',
      ].join('\n'),
      noLink: true,
    });
    if (choice.response !== 1) return false; // 0 = 取消 / 关窗
    const ok = supervisor.forgetChannel(chatId);
    pushLog({
      ts: Date.now(),
      level: ok ? 'info' : 'warn',
      source: 'launcher',
      message: ok ? `频道 ${displayName} 已 forget` : `频道 ${chatId} forget 失败`,
    });
    pushState();
    return ok;
  });
  // P1.3: 按需触发 ccusage 拉一次（footer "获取 quota" 按钮）
  ipcMain.handle('quota.fetch-now', async () => {
    if (!supervisor) return null;
    await supervisor.fetchQuotaNow();
    // snapshot 走 supervisor.on('quota') → mainWindow.send('quota', snap)，不必直接返回
    return { ok: true };
  });
  ipcMain.handle('work.end', (_, sessionId: string) => {
    // 修内审 Required #1：UI 主动 end 接 supervisor.endWorkSession
    const ok = supervisor?.endWorkSession(sessionId);
    pushLog({
      ts: Date.now(),
      level: ok ? 'info' : 'warn',
      source: 'launcher',
      message: ok ? `work session ${sessionId} 已结束` : `work session ${sessionId} 不存在`,
    });
    pushState();
  });
  ipcMain.handle('app.restart-bot', async () => {
    if (!supervisor) return;
    // renderer window.confirm 默认禁用，确认对话框移到 main process
    const choice = await dialog.showMessageBox(mainWindow ?? new BrowserWindow({ show: false }), {
      type: 'warning',
      buttons: ['取消', '重启'],
      defaultId: 0,
      cancelId: 0,
      title: '重启品品',
      message: '确认重启 supervisor + 所有频道 CLI？',
      detail: '· 所有频道 CLI 将停止并重新启动\n· 进行中的对话上下文保留（CLI 重连后继续）',
      noLink: true,
    });
    if (choice.response !== 1) return;
    pushLog({ ts: Date.now(), level: 'info', source: 'app', message: '重启品品 supervisor…' });
    await supervisor.restart();
    pushState();
    pushLog({ ts: Date.now(), level: 'info', source: 'app', message: '品品 supervisor 已重启' });
  });
  ipcMain.handle('app.quit', async () => {
    // renderer window.confirm 默认禁用，确认对话框移到 main process
    const choice = await dialog.showMessageBox(mainWindow ?? new BrowserWindow({ show: false }), {
      type: 'warning',
      buttons: ['取消', '关闭品品'],
      defaultId: 0,
      cancelId: 0,
      title: '关闭品品',
      message: '确认完全关闭品品（含所有后台频道 CLI）？',
      noLink: true,
    });
    if (choice.response !== 1) return;
    isQuiting = true;
    app.quit();
  });
  ipcMain.handle('settings.get', () => ({
    default_model: supervisor?.opts.defaultModel ?? '',
    default_effort: supervisor?.opts.defaultEffort ?? 'high',
    work_default_model: supervisor?.getWorkDefaults().model ?? '',
    work_default_effort: supervisor?.getWorkDefaults().effort ?? 'high',
    work_default_fast: supervisor?.getWorkDefaults().fast ?? false,
    default_fast: supervisor?.opts.defaultFast ?? false,
    default_compact_pct: supervisor?.opts.defaultAutoCompactPct ?? 25,
  }));
  ipcMain.handle('settings.set', (_, s: { default_model?: string; default_effort?: string; work_default_model?: string; work_default_effort?: string; work_default_fast?: boolean; default_fast?: boolean; default_compact_pct?: number }) => {
    // P2.2: settings.set 实装——写 channel-config.json 的 __defaults__ / __work_defaults__ + 更新 supervisor opts
    if (!supervisor) return;
    supervisor.setDefaults({
      model: s.default_model,
      effort: s.default_effort,
      autoCompactPct: s.default_compact_pct,
      fast: s.default_fast,
    });
    supervisor.setWorkDefaults({
      model: s.work_default_model,
      effort: s.work_default_effort,
      fast: s.work_default_fast,
    });
    pushLog({
      ts: Date.now(),
      level: 'info',
      source: 'app',
      message: `默认已保存：频道 model=${s.default_model ?? '(unchanged)'}/effort=${s.default_effort ?? '(unchanged)'}；work model=${s.work_default_model ?? '(unchanged)'}/effort=${s.work_default_effort ?? '(unchanged)'}`,
    });
  });

  // ── step 6: 终端子窗口 IPC handlers ──
  ipcMain.handle('terminal.open', (_, chatId: string) => {
    openTerminalWindow(chatId);
  });

  ipcMain.on('terminal.subscribe-pty', (e, chatId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const cli = supervisor?.getChannel(chatId);
    if (!cli) {
      e.sender.send(`pty-data:${chatId}`, `\r\n[supervisor] 频道 CLI 未启动\r\n`);
      return;
    }
    cli.attachTerminal((data) => {
      if (!win.isDestroyed()) e.sender.send(`pty-data:${chatId}`, data);
    });
  });

  ipcMain.on('terminal.unsubscribe-pty', (_, chatId: string) => {
    supervisor?.getChannel(chatId)?.detachTerminal();
  });

  ipcMain.handle('terminal.input', (_, chatId: string, text: string) => {
    supervisor?.getChannel(chatId)?.sendInput(text);
  });

  ipcMain.handle('terminal.resize-pty', (_, chatId: string, cols: number, rows: number) => {
    supervisor?.getChannel(chatId)?.resizeTerminal(cols, rows);
  });

  ipcMain.handle('terminal.compact', (_, chatId: string) => {
    supervisor?.getChannel(chatId)?.compact();
  });

  ipcMain.handle('terminal.restart', async (_, chatId: string) => {
    // renderer window.confirm 默认禁用，确认对话框移到 main process
    const displayName = getChatDisplayName(chatId);
    const termWin = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w !== mainWindow,
    );
    const choice = await dialog.showMessageBox(termWin ?? mainWindow ?? new BrowserWindow({ show: false }), {
      type: 'warning',
      buttons: ['取消', '重启'],
      defaultId: 0,
      cancelId: 0,
      title: '重启频道 CLI',
      message: `确认重启频道「${displayName}」的 CLI？`,
      detail: '· 当前对话上下文会丢失\n· CLI 将在 500ms 后自动重新启动',
      noLink: true,
    });
    if (choice.response !== 1) return false;
    supervisor?.getChannel(chatId)?.restart();
    pushState();
    return true;
  });

  ipcMain.handle('terminal.get-meta', (_, chatId: string) => {
    const cli = supervisor?.getChannel(chatId);
    const stats = cli?.getStats();
    return {
      chat_name: stats?.chat_name,
      model: stats?.model ?? '?',
      effort: stats?.effort ?? '?',
      status: stats?.status ?? 'stopped',
    };
  });

  // ── Q5: work session 终端子窗口 IPC handlers ──
  ipcMain.handle('work-terminal.open', (_, sessionId: string) => {
    openWorkTerminalWindow(sessionId);
  });

  ipcMain.on('work-terminal.subscribe-pty', (e, sessionId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const ws = supervisor?.getWorkSession(sessionId);
    if (!ws) {
      e.sender.send(`work-pty-data:${sessionId}`, `\r\n[supervisor] work session 未找到\r\n`);
      return;
    }
    ws.attachTerminal((data) => {
      if (!win.isDestroyed()) e.sender.send(`work-pty-data:${sessionId}`, data);
    });
  });

  ipcMain.on('work-terminal.unsubscribe-pty', (_, sessionId: string) => {
    supervisor?.getWorkSession(sessionId)?.detachTerminal();
  });

  ipcMain.handle('work-terminal.resize-pty', (_, sessionId: string, cols: number, rows: number) => {
    supervisor?.getWorkSession(sessionId)?.resizeTerminal(cols, rows);
  });

  ipcMain.handle('work-terminal.send-input', (_, sessionId: string, text: string) => {
    supervisor?.getWorkSession(sessionId)?.sendMessage(text);
  });

  ipcMain.handle('work-terminal.end', async (_, sessionId: string) => {
    // renderer window.confirm 默认禁用，确认对话框移到 main process
    const workTermWin = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w !== mainWindow,
    );
    const choice = await dialog.showMessageBox(workTermWin ?? mainWindow ?? new BrowserWindow({ show: false }), {
      type: 'warning',
      buttons: ['取消', '结束 session'],
      defaultId: 0,
      cancelId: 0,
      title: '结束 work session',
      message: '确认结束这个 work session？',
      detail: '· 关窗 ≠ 结束；点「结束 session」才真的杀掉 work CLI\n· 结束后无法恢复，请确认 work 已完成',
      noLink: true,
    });
    if (choice.response !== 1) return false;
    supervisor?.endWorkSession(sessionId);
    pushState();
    return true;
  });

  ipcMain.handle('work-terminal.get-meta', (_, sessionId: string) => {
    const ws = supervisor?.getWorkSession(sessionId);
    if (!ws) return null;
    const stats = ws.getStats();
    const originChat = supervisor?.getChats().find((c) => c.chat_id === stats.origin_chat_id);
    return {
      work_dir: stats.work_dir,
      model: stats.model,
      effort: stats.effort,
      status: stats.status,
      origin_chat_name: originChat?.name,
    };
  });

});

function openWorkTerminalWindow(sessionId: string): void {
  const existing = workTerminalWindows.get(sessionId);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 880,
    height: 620,
    minWidth: 600,
    minHeight: 380,
    title: '品品 work session 终端',
    icon: join(__dirname, '../../launcher/renderer/assets/品品图标.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  workTerminalWindows.set(sessionId, win);
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(`${devUrl}/work-terminal.html?session_id=${encodeURIComponent(sessionId)}`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/work-terminal.html'), {
      search: `session_id=${encodeURIComponent(sessionId)}`,
    });
  }
  win.on('close', () => {
    // workCLI 窗 X = 真结束这个 work session：ws.end() 走 pty.kill→taskkill /F /T 树杀
    // work CLI + 其 MCP server + Task 子 agent 等全部衍生进程（Owner要求：X 掉不留僵尸）。
    supervisor?.getWorkSession(sessionId)?.end();
  });
  win.on('closed', () => {
    workTerminalWindows.delete(sessionId);
  });
}

function openTerminalWindow(chatId: string): void {
  const existing = terminalWindows.get(chatId);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 640,
    minHeight: 400,
    title: '品品 频道终端',
    icon: join(__dirname, '../../launcher/renderer/assets/品品图标.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  terminalWindows.set(chatId, win);
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(`${devUrl}/terminal.html?chat_id=${encodeURIComponent(chatId)}`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/terminal.html'), {
      search: `chat_id=${encodeURIComponent(chatId)}`,
    });
  }
  win.on('close', () => {
    // 关 X = detach（任务 MD §决策 G：CLI 后台继续跑）
    supervisor?.getChannel(chatId)?.detachTerminal();
  });
  win.on('closed', () => {
    terminalWindows.delete(chatId);
  });
}

app.on('window-all-closed', () => {
  // Don't quit — stay alive in tray
});

app.on('before-quit', async () => {
  isQuiting = true;
  if (stateTickTimer) clearInterval(stateTickTimer);
  await supervisor?.stop();
});
