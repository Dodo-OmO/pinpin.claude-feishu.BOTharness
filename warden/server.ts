/**
 * 管家 HTTP + WebSocket 服务入口。
 *
 * 提供：静态托管 public/ + /health + /api/state(聚合状态) + /ws(终端流，步骤3接)。
 * 仅绑 127.0.0.1（R6，只允许 Cloudflare 隧道转发进来）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { HTTP_PORT, PUBLIC_DIR, CODE_ROOT } from './config.js';
import { SupervisorBridge } from './supervisor-bridge.js';
import { IPC_METHODS } from '../src/ipc/protocol.js';
import { checkNet, launchLauncher } from './system-ops.js';
import { handleHuixing } from './huixing-qr.js';

const bridge = new SupervisorBridge();
bridge.start();

// Cloudflare Access（管家外网隧道）验签：团队域 + 本应用 aud，固定常量，不外置配置。
const CF_ACCESS_TEAM_DOMAIN = 'https://<your-team>.cloudflareaccess.com';
const CF_ACCESS_AUD = '<your-access-app-aud>';
const CF_ACCESS_CERTS_URL = `${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
const CF_ACCESS_CERTS_TTL_MS = 60 * 60 * 1000; // 证书缓存 1 小时

interface CfAccessJwk {
  kid: string;
  [k: string]: unknown;
}
let cfAccessCertsCache: { keys: CfAccessJwk[]; fetchedAt: number } | null = null;

async function getCfAccessKeys(): Promise<CfAccessJwk[]> {
  if (cfAccessCertsCache && Date.now() - cfAccessCertsCache.fetchedAt < CF_ACCESS_CERTS_TTL_MS) {
    return cfAccessCertsCache.keys;
  }
  const res = await fetch(CF_ACCESS_CERTS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`拉 Cloudflare Access 证书失败: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: CfAccessJwk[] };
  const keys = body.keys ?? [];
  cfAccessCertsCache = { keys, fetchedAt: Date.now() };
  return keys;
}

/** 验 Cloudflare Access JWT：RS256 签名 + exp + aud。任何解析/网络异常都判失败（fail-closed）。 */
async function verifyCfAccessJwt(token: string): Promise<boolean> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [headerB64, payloadB64, sigB64] = parts;
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8')) as {
      kid?: string;
      alg?: string;
    };
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as {
      exp?: number;
      aud?: string | string[];
    };
    if (header.alg !== 'RS256' || !header.kid) return false;

    const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    if (!aud.includes(CF_ACCESS_AUD)) return false;
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return false;

    const keys = await getCfAccessKeys();
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return false;

    const publicKey = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: 'jwk' });
    const signature = Buffer.from(sigB64, 'base64url');
    const signedData = Buffer.from(`${headerB64}.${payloadB64}`);
    return crypto.verify('RSA-SHA256', signedData, publicKey, signature);
  } catch {
    return false;
  }
}

/**
 * 请求带 cf-connecting-ip（说明经 Cloudflare 隧道进来）→ 必须带 cf-access-jwt-assertion 且验签通过；
 * 不带 cf-connecting-ip 的本机直连请求照常放行、不受影响。
 */
async function isRequestAuthorized(req: http.IncomingMessage): Promise<boolean> {
  if (!req.headers['cf-connecting-ip']) return true;
  const assertion = req.headers['cf-access-jwt-assertion'];
  const token = Array.isArray(assertion) ? assertion[0] : assertion;
  if (!token) return false;
  return verifyCfAccessJwt(token);
}

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
  // 汇星授权二维码：豆姐自己开 /huixing.html 当场看当场扫（见 huixing-qr.ts）
  if (url.pathname.startsWith('/api/huixing/')) return handleHuixing(url, req, res);

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

  // ── 批4 全局默认设置（GET 读 channel；POST 写）──
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
  void handleRequest(req, res);
});

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!(await isRequestAuthorized(req))) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
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
}

// 终端实时流：前端 ws(/ws?chat=<id>) ↔ 管家 ↔ supervisor 桥接。
// 同一 chat 多个前端 ws 在管家层 fan-out（突破 supervisor 单 consumer，支持多页签看同一终端）。
const chatSubs = new Map<string, Set<WebSocket>>();

// 终端订阅路由：频道 chat_id 走 subscribeTerminal，push 复用 TERMINAL_DATA 以 chat_id 路由。
function subTerminal(key: string): Promise<unknown> {
  return bridge.subscribeTerminal(key);
}
function unsubTerminal(key: string): Promise<unknown> {
  return bridge.unsubscribeTerminal(key);
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

const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info, cb) => {
    void isRequestAuthorized(info.req).then((ok) => cb(ok, ok ? undefined : 403));
  },
});
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
