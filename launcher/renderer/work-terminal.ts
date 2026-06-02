/**
 * work session 终端子窗口 —— xterm.js 渲染 PTY 原始流（跟 channel terminal 同款）
 *
 * 数据流（Owner P3 v2 反馈：jsonl 翻译路径太慢——4 分钟终端空白；改走 PTY raw）：
 *   主面板"打开终端"→ ipcRenderer.invoke('work-terminal.open', session_id) → main 开新 BrowserWindow
 *   BrowserWindow 用 query string ?session_id=... 让 renderer 知道服务哪个 work
 *   IPC main → renderer：subscribe-pty → main forward WorkSession PTY data
 *                       send('work-pty-data:<session_id>', chunk)
 *   IPC renderer → main：work-terminal.send-input(sid, text) - PTY write 给 work CLI stdin
 *                      / work-terminal.end(sid) - 真结束（杀 PTY）
 *                      / work-terminal.get-meta(sid)
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export {};

declare global {
  interface Window {
    workTerminal: {
      attachPty: (sessionId: string, cb: (data: string) => void) => () => void;
      resizePty: (sessionId: string, cols: number, rows: number) => Promise<void>;
      sendInput: (sessionId: string, text: string) => Promise<void>;
      endSession: (sessionId: string) => Promise<boolean>;
      getMeta: (sessionId: string) => Promise<{
        work_dir: string;
        model: string;
        effort: string;
        status: string;
        origin_chat_name?: string;
      } | null>;
    };
  }
}

const params = new URLSearchParams(location.search);
const sessionId = params.get('session_id') ?? '';

if (!sessionId) {
  document.body.innerHTML = '<div style="padding:24px;color:#c0392b">缺少 session_id 参数</div>';
} else {
  init(sessionId);
}

function init(sid: string): void {
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
    void window.workTerminal.resizePty(sid, term.cols, term.rows);
  }

  setTimeout(() => fitAndSync(), 100);
  window.addEventListener('resize', () => fitAndSync());

  // 监听终端容器自身尺寸变化（窗口缩小 / 布局变动），实时 fit 防格式错乱。
  // window resize 抓不到容器被 flex/grid 挤压的情况，ResizeObserver 才能精准跟随。
  // 与频道终端 terminal.ts 同款，让两个同类终端格式显示一致。
  const resizeObserver = new ResizeObserver(() => fitAndSync());
  resizeObserver.observe(streamEl);

  // 订阅 PTY 流（PtyManager.attach replay ring buffer + 实时 onData）
  const detachPty = window.workTerminal.attachPty(sid, (chunk: string) => {
    term.write(chunk);
  });
  window.addEventListener('beforeunload', () => {
    detachPty();
    resizeObserver.disconnect(); // 终端关闭时断开 observer 防泄漏
  });

  // header meta init
  void (async () => {
    try {
      const meta = await window.workTerminal.getMeta(sid);
      if (!meta) return;
      const dirShort = meta.work_dir.split(/[\\/]/).pop() ?? meta.work_dir;
      const nameEl = document.getElementById('header-name');
      const metaEl = document.getElementById('header-meta');
      const health = document.getElementById('health');
      if (nameEl) nameEl.textContent = `work · ${dirShort}`;
      if (metaEl) metaEl.textContent = `${meta.model} · ${meta.effort} · ${meta.status}${meta.origin_chat_name ? ` · 来自 ${meta.origin_chat_name}` : ''}`;
      if (health) {
        health.className = 'health-dot ' + (meta.status === 'running' ? 'green' : meta.status === 'starting' ? 'yellow' : meta.status === 'failed' ? 'red' : 'gray');
      }
      document.title = `work · ${dirShort} · 品品`;
    } catch { /* ignore */ }
  })();

  // 输入区：textarea + 发送按钮 + Ctrl+Enter
  const inputEl = document.getElementById('input-text') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('btn-send') as HTMLButtonElement;

  async function doSend(): Promise<void> {
    const text = inputEl.value.trim();
    if (!text) return;
    try {
      await window.workTerminal.sendInput(sid, text);
      inputEl.value = '';
    } catch (e) {
      term.write(`\r\n[发送失败] ${e instanceof Error ? e.message : String(e)}\r\n`);
    }
  }

  sendBtn?.addEventListener('click', () => void doSend());
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void doSend();
    }
  });

  document.getElementById('btn-clear')?.addEventListener('click', () => term.clear());
  document.getElementById('btn-end')?.addEventListener('click', () => {
    // 确认对话框在 main process 的 ipcMain.handle('work-terminal.end') 里（dialog.showMessageBox），
    // handler 返回 boolean：true = 用户确认结束，false = 用户取消
    void window.workTerminal.endSession(sid).then((ok) => { if (ok) window.close(); });
  });
}
