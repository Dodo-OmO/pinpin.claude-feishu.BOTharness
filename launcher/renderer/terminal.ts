/**
 * 频道终端子窗口 renderer —— xterm.js 渲染 PTY 实时流 + 底部输入框直连该频道 CLI（写 PTY）。
 *
 * 数据流：
 *   主面板"打开终端"→ ipcRenderer.invoke('terminal.open', chat_id) → main 开新 BrowserWindow
 *   该 BrowserWindow 用 query string ?chat_id=... 让 renderer 知道服务哪个 chat
 *   IPC main → renderer：subscribe-pty(chat_id) 主进程 forward ChannelCli.attachTerminal data
 *                       send('pty-data:<chat_id>', chunk)
 *   IPC renderer → main：terminal.input(chat_id, text) - 直接 PTY write 进 claude stdin
 *                      / terminal.compact(chat_id) - PTY write /compact\n
 *                      / terminal.restart(chat_id)
 *                      / terminal.clear() - 清 xterm
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalApi {
  attachPty: (chatId: string, cb: (data: string) => void) => () => void;
  resizePty: (chatId: string, cols: number, rows: number) => Promise<void>;
  sendInput: (chatId: string, text: string) => Promise<void>;
  compact: (chatId: string) => Promise<void>;
  restart: (chatId: string) => Promise<boolean>;
  getMeta: (chatId: string) => Promise<{ chat_name?: string; model: string; effort: string; status: string }>;
}

declare global {
  interface Window { terminal: TerminalApi; }
}

const params = new URLSearchParams(location.search);
const chatId = params.get('chat_id') ?? '';

const term = new Terminal({
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  theme: { background: '#1e1e1f', foreground: '#e0e0e2', cursor: '#C8B6E2' },
  scrollback: 5000,
  convertEol: false, // PTY 已输出 \r\n，关掉防双重换行 + 避免干扰 claude \r 原地刷新
});
const fit = new FitAddon();
term.loadAddon(fit);

const streamEl = document.getElementById('term-stream') as HTMLDivElement;
term.open(streamEl);

/** fit 后把实际列/行数同步回 PTY，让 claude TUI 按真实宽度排版 */
function fitAndSync(): void {
  fit.fit();
  void window.terminal.resizePty(chatId, term.cols, term.rows);
}

setTimeout(() => fitAndSync(), 100);
window.addEventListener('resize', () => fitAndSync());

// #6: 监听终端容器自身尺寸变化（窗口缩小 / 布局变动），实时 fit 防格式错乱。
// window resize 抓不到容器被 flex/grid 挤压的情况，ResizeObserver 才能精准跟随。
const resizeObserver = new ResizeObserver(() => fitAndSync());
resizeObserver.observe(streamEl);

// 订阅 PTY 流（main process push 每个 chunk）；返回 unsubscribe
const detachPty = window.terminal.attachPty(chatId, (chunk: string) => {
  term.write(chunk);
});

// 修内审 Nit #10：beforeunload 解 IPC listener，避免多开终端 leak
window.addEventListener('beforeunload', () => {
  detachPty();
  resizeObserver.disconnect(); // #6: 终端关闭时断开 observer 防泄漏
});

// header meta init
void (async () => {
  try {
    const meta = await window.terminal.getMeta(chatId);
    const nameEl = document.getElementById('header-name');
    const metaEl = document.getElementById('header-meta');
    const health = document.getElementById('health');
    if (nameEl) nameEl.textContent = meta.chat_name ?? chatId.slice(-12);
    if (metaEl) metaEl.textContent = `${meta.model} · ${meta.effort} · ${meta.status}`;
    if (health) health.className = 'health-dot ' + (meta.status === 'running' ? 'green' : meta.status === 'starting' ? 'yellow' : meta.status === 'failed' ? 'red' : 'gray');
    document.title = `${meta.chat_name ?? chatId} · 品品频道终端`;
  } catch { /* ignore */ }
})();

// 快速发消息：textarea 直连该频道 CLI（纯文本写 PTY）
const inputEl = document.getElementById('input-text') as HTMLTextAreaElement;
const sendBtn = document.getElementById('btn-send') as HTMLButtonElement;
const hintEl = document.getElementById('input-hint') as HTMLDivElement;

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void doSend();
  }
});

sendBtn.addEventListener('click', () => { void doSend(); });

function setHint(text: string, cls: 'ok' | 'error' | '' = ''): void {
  hintEl.textContent = text;
  hintEl.className = 'input-hint' + (cls ? ' ' + cls : '');
}

async function doSend(): Promise<void> {
  const text = inputEl.value.trim();
  if (!text) return;
  sendBtn.disabled = true;
  try {
    // #4: 输入框直连该频道的 CLI 进程（写 PTY stdin），不再过飞书。
    // 走 terminal.input → ChannelCli.sendInput → pty.submitLine：只发纯文本，
    // 提交的 \r 由 submitLine 的"双段静默门"分次补发（等 TUI 就绪再发 \r 防被吞），
    // 不在此拼 \r\n（一坨发会被 Ink TUI 当粘贴、回车失效，与 work 终端同机制）。
    await window.terminal.sendInput(chatId, text);
    inputEl.value = '';
    setHint('已发送给 CLI', 'ok');
  } catch (e) {
    setHint(`发送失败：${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    sendBtn.disabled = false;
  }
}

document.getElementById('btn-compact')?.addEventListener('click', () => {
  void window.terminal.compact(chatId);
  setHint('/compact 已注入，等品品自行重新载入上下文', 'ok');
});
document.getElementById('btn-clear')?.addEventListener('click', () => {
  term.clear();
});
document.getElementById('btn-restart')?.addEventListener('click', () => {
  // 确认对话框在 main process 的 ipcMain.handle('terminal.restart') 里（dialog.showMessageBox），
  // handler 返回 boolean：true = 用户确认重启，false = 用户取消
  void window.terminal.restart(chatId).then((ok) => {
    setHint(ok ? '已发起重启' : '已取消', ok ? 'ok' : '');
  });
});

export {};
