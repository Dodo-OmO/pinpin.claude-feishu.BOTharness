/**
 * 管家 HTTP + WebSocket 服务入口。
 *
 * 提供：静态托管 public/ + /health + /api/state(聚合状态) + /ws(终端流，步骤3接)。
 * 仅绑 127.0.0.1（R6，只允许 Cloudflare 隧道转发进来）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { HTTP_PORT, PUBLIC_DIR, CODE_ROOT } from './config.js';
import { SupervisorBridge } from './supervisor-bridge.js';
import { IPC_METHODS } from '../src/ipc/protocol.js';
import { checkNet, launchLauncher } from './system-ops.js';

const bridge = new SupervisorBridge();
bridge.start();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// xterm 前端资源白名单（映射到 node_modules，防目录穿越）
const VENDOR: Record<string, string> = {
  '/vendor/xterm/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
};

function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      // 上限 1MB——管家只收终端输入/短指令，超大 body 必是异常/恶意，截断防内存爆
      if (d.length > 1_000_000) { d = d.slice(0, 1_000_000); req.destroy(); }
    });
    req.on('end', () => resolve(d));
    req.on('error', () => resolve(''));
  });
}

/** 处理 /api/* 路由；命中返回 true */
async function handleApi(
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse,
): Promise<boolean> {
  if (url.pathname === '/api/state') {
    const launcher_up = bridge.isConnected();
    let clis: unknown[] = [];
    let system: unknown = null;
    if (launcher_up) {
      try {
        const [r, sys] = await Promise.all([
          bridge.request<{ clis: unknown[] }>(IPC_METHODS.WARDEN_LIST_CLIS),
          bridge.request(IPC_METHODS.WARDEN_SYSTEM_INFO),
        ]);
        clis = r.clis ?? [];
        system = sys;
      } catch {
        /* 桥接抖动 → 当作启动器刚断，clis 留空 */
      }
    }
    sendJson(res, { launcher_up, clis, system });
    return true;
  }

  // 重启 / 杀某 CLI（POST，防误触）
  if (url.pathname === '/api/cli/restart' || url.pathname === '/api/cli/stop') {
    if (req.method !== 'POST') {
      sendJson(res, { ok: false, error: 'POST only' }, 405);
      return true;
    }
    const chat = url.searchParams.get('chat');
    if (!chat) {
      sendJson(res, { ok: false, error: 'no chat' }, 400);
      return true;
    }
    const method = url.pathname.endsWith('restart')
      ? IPC_METHODS.WARDEN_RESTART_CLI
      : IPC_METHODS.WARDEN_STOP_CLI;
    try {
      const r = await bridge.request(method, { chat_id: chat });
      sendJson(res, r);
    } catch (e) {
      sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
    return true;
  }

  // ── 批1 频道完整管理（POST）──
  if (url.pathname === '/api/cli/start' || url.pathname === '/api/cli/compact') {
    if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'POST only' }, 405); return true; }
    const chat = url.searchParams.get('chat');
    if (!chat) { sendJson(res, { ok: false, error: 'no chat' }, 400); return true; }
    const m = url.pathname.endsWith('start') ? IPC_METHODS.WARDEN_START_CLI : IPC_METHODS.WARDEN_COMPACT_CLI;
    try { sendJson(res, await bridge.request(m, { chat_id: chat })); }
    catch (e) { sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 502); }
    return true;
  }
  if (url.pathname === '/api/cli/start-all') {
    if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'POST only' }, 405); return true; }
    try { sendJson(res, await bridge.request(IPC_METHODS.WARDEN_START_ALL)); }
    catch (e) { sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 502); }
    return true;
  }
  if (url.pathname === '/api/cli/config') {
    if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'POST only' }, 405); return true; }
    const chat = url.searchParams.get('chat');
    if (!chat) { sendJson(res, { ok: false, error: 'no chat' }, 400); return true; }
    const cfg: Record<string, unknown> = { chat_id: chat };
    if (url.searchParams.has('model')) cfg.model = url.searchParams.get('model');
    if (url.searchParams.has('effort')) cfg.effort = url.searchParams.get('effort');
    if (url.searchParams.has('fast')) cfg.fast = url.searchParams.get('fast') === 'true';
    if (url.searchParams.has('autoCompactPct')) cfg.autoCompactPct = Number(url.searchParams.get('autoCompactPct'));
    try { sendJson(res, await bridge.request(IPC_METHODS.WARDEN_SET_CONFIG, cfg)); }
    catch (e) { sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 502); }
    return true;
  }
  if (url.pathname === '/api/cli/name') {
    if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'POST only' }, 405); return true; }
    const chat = url.searchParams.get('chat');
    if (!chat) { sendJson(res, { ok: false, error: 'no chat' }, 400); return true; }
    try { sendJson(res, await bridge.request(IPC_METHODS.WARDEN_SET_NAME, { chat_id: chat, name: url.searchParams.get('name') ?? '' })); }
    catch (e) { sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 502); }
    return true;
  }
  if (url.pathname === '/api/cli/input') {
    if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'POST only' }, 405); return true; }
    const chat = url.searchParams.get('chat');
    if (!chat) { sendJson(res, { ok: false, error: 'no chat' }, 400); return true; }
    const text = await readBody(req);
    try { sendJson(res, await bridge.request(IPC_METHODS.WARDEN_SEND_INPUT, { chat_id: chat, text })); }
    catch (e) { sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 502); }
    return true;
  }

  // ── 批2 额度（POST，触发 fetchQuotaNow 刷新后返）──
  if (url.pathname === '/api/quota') {
    if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'POST only' }, 405); return true; }
    try { sendJson(res, await bridge.request(IPC_METHODS.WARDEN_FETCH_QUOTA)); }
    catch (e) { sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 502); }
    return true;
  }

  // ── 批2 频道删除 / 恢复 ──
  if (url.pathname === '/api/cli/forget' || url.pathname === '/api/cli/restore') {
    if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'POST only' }, 405); return true; }
    const chat = url.searchParams.get('chat');
    if (!chat) { sendJson(res, { ok: false, error: 'no chat' }, 400); return true; }
    const m = url.pathname.endsWith('forget') ? IPC_METHODS.WARDEN_FORGET_CHANNEL : IPC_METHODS.WARDEN_RESTORE_CHANNEL;
    try { sendJson(res, await bridge.request(m, { chat_id: chat })); }
    catch (e) { sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 502); }
    return true;
  }
  if (url.pathname === '/api/forgotten') {
    try { sendJson(res, await bridge.request(IPC_METHODS.WARDEN_LIST_FORGOTTEN)); }
    catch (e) { sendJson(res, { channels: [], error: e instanceof Error ? e.message : String(e) }, 502); }
    return true;
  }

  // ── 批3 work session（列表 + 发消息 + 结束；终端走 /ws?chat=<session_id>）──
  if (url.pathname === '/api/work') {
    try { sendJson(res, await bridge.request(IPC_METHODS.WARDEN_LIST_WORK)); }
    catch (e) { sendJson(res, { sessions: [], error: e instanceof Error ? e.message : String(e) }, 502); }
    return true;
  }
  if (url.pathname === '/api/work/send' || url.pathname === '/api/work/end') {
    if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'POST only' }, 405); return true; }
    const id = url.searchParams.get('id');
    if (!id) { sendJson(res, { ok: false, error: 'no id' }, 400); return true; }
    if (url.pathname.endsWith('send')) {
      const text = await readBody(req);
      try { sendJson(res, await bridge.request(IPC_METHODS.WARDEN_WORK_SEND, { session_id: id, text })); }
      catch (e) { sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 502); }
    } else {
      try { sendJson(res, await bridge.request(IPC_METHODS.WARDEN_WORK_END, { session_id: id })); }
      catch (e) { sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 502); }
    }
    return true;
  }

  // ── 批4 全局默认设置（GET 读 channel+work；POST 写）──
  if (url.pathname === '/api/defaults') {
    if (req.method === 'POST') {
      const patch: Record<string, unknown> = {};
      if (url.searchParams.has('model')) patch.model = url.searchParams.get('model');
      if (url.searchParams.has('effort')) patch.effort = url.searchParams.get('effort');
      if (url.searchParams.has('fast')) patch.fast = url.searchParams.get('fast') === 'true';
      if (url.searchParams.has('autoCompactPct')) patch.autoCompactPct = Number(url.searchParams.get('autoCompactPct'));
      try { sendJson(res, await bridge.request(IPC_METHODS.WARDEN_SET_DEFAULTS, patch)); }
      catch (e) { sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 502); }
      return true;
    }
    try { sendJson(res, await bridge.request(IPC_METHODS.WARDEN_GET_DEFAULTS)); }
    catch (e) { sendJson(res, { error: e instanceof Error ? e.message : String(e) }, 502); }
    return true;
  }
  if (url.pathname === '/api/defaults/work') {
    if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'POST only' }, 405); return true; }
    const patch: Record<string, unknown> = {};
    if (url.searchParams.has('model')) patch.model = url.searchParams.get('model');
    if (url.searchParams.has('effort')) patch.effort = url.searchParams.get('effort');
    if (url.searchParams.has('fast')) patch.fast = url.searchParams.get('fast') === 'true';
    try { sendJson(res, await bridge.request(IPC_METHODS.WARDEN_SET_WORK_DEFAULTS, patch)); }
    catch (e) { sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 502); }
    return true;
  }

  // ── 批4 系统：重启品品 / 关闭品品（POST，强二次确认在前端）──
  if (url.pathname === '/api/system/restart' || url.pathname === '/api/system/quit') {
    if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'POST only' }, 405); return true; }
    const m = url.pathname.endsWith('restart') ? IPC_METHODS.WARDEN_RESTART_SUPERVISOR : IPC_METHODS.WARDEN_QUIT_APP;
    try { sendJson(res, await bridge.request(m)); }
    catch (e) { sendJson(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 502); }
    return true;
  }

  // ── 批4 日志流（GET）──
  if (url.pathname === '/api/logs') {
    const limit = Number(url.searchParams.get('limit') ?? 100);
    try { sendJson(res, await bridge.request(IPC_METHODS.WARDEN_RECENT_LOGS, { limit })); }
    catch (e) { sendJson(res, { logs: [], error: e instanceof Error ? e.message : String(e) }, 502); }
    return true;
  }

  // 网络 健康检查（只读）
  if (url.pathname === '/api/net') {
    sendJson(res, await checkNet());
    return true;
  }

  // 拉起启动器（POST）
  if (url.pathname === '/api/system/launch-launcher') {
    if (req.method !== 'POST') { sendJson(res, { ok: false, error: 'POST only' }, 405); return true; }
    sendJson(res, launchLauncher());
    return true;
  }

  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/health') {
    sendJson(res, { ok: true, ts: Date.now() });
    return;
  }

  if (VENDOR[url.pathname]) {
    const vp = path.join(CODE_ROOT, VENDOR[url.pathname]);
    fs.readFile(vp, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(vp).toLowerCase()] ?? 'application/octet-stream',
      });
      res.end(data);
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    void handleApi(req, url, res)
      .then((handled) => {
        if (!handled) sendJson(res, { error: 'unknown api' }, 404);
      })
      .catch((e) => {
        if (!res.headersSent) sendJson(res, { error: String(e) }, 500);
      });
    return;
  }

  // 静态文件（防目录穿越）
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    });
    res.end(data);
  });
});

// 终端实时流：前端 ws(/ws?chat=<id>) ↔ 管家 ↔ supervisor 桥接。
// 同一 chat 多个前端 ws 在管家层 fan-out（突破 supervisor 单 consumer，支持多页签看同一终端）。
const chatSubs = new Map<string, Set<WebSocket>>();

// 终端订阅路由：work session（ws_ 前缀）走 work 方法，频道走 chat 方法。
// 两者 push 都复用 TERMINAL_DATA、以 key（session_id / chat_id）路由，前端 ws 同一套机制。
function subTerminal(key: string): Promise<unknown> {
  return key.startsWith('ws_')
    ? bridge.request(IPC_METHODS.WARDEN_WORK_SUB_TERMINAL, { session_id: key })
    : bridge.subscribeTerminal(key);
}
function unsubTerminal(key: string): Promise<unknown> {
  return key.startsWith('ws_')
    ? bridge.request(IPC_METHODS.WARDEN_WORK_UNSUB_TERMINAL, { session_id: key })
    : bridge.unsubscribeTerminal(key);
}

bridge.onTerminalData = (chatId, data) => {
  const set = chatSubs.get(chatId);
  if (!set) return;
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
};
// 桥接（重）连后，重订阅当前仍在看的终端（断线期间 supervisor 侧 attach 已失效）
bridge.onReconnect = () => {
  for (const chat of chatSubs.keys()) subTerminal(chat).catch(() => {});
};

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  // 手机切 WiFi/4G 等底层 socket 异常 → ws emit 'error'，无监听器会 uncaught 崩管家进程
  ws.on('error', (err) => console.error('[warden/ws]', err.message));
  const u = new URL(req.url ?? '/', 'http://localhost');
  const chat = u.searchParams.get('chat');
  if (!chat) {
    ws.close();
    return;
  }
  let set = chatSubs.get(chat);
  if (!set) {
    set = new Set();
    chatSubs.set(chat, set);
  }
  const subs = set;
  const first = subs.size === 0;
  subs.add(ws);
  if (first) subTerminal(chat).catch(() => {});
  ws.on('close', () => {
    subs.delete(ws);
    if (subs.size === 0) {
      chatSubs.delete(chat);
      unsubTerminal(chat).catch(() => {});
    }
  });
});

server.on('error', (err) => {
  // 端口占用（上次未正常退出残留等）→ 独立进程无父进程兜底，明确报错退出便于排查
  console.error('[warden] HTTP server error:', err);
  process.exit(1);
});

server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[warden] 管家在线 → http://127.0.0.1:${HTTP_PORT}`);
});
