/**
 * 汇星登录二维码直供（管家侧）。
 *
 * 豆姐自己打开 /huixing.html 就能看到**当场生成**的码：页面每 2 秒拉一次 /api/huixing/qr，
 * 这个接口直接连登录脚本那个无头 Chrome 的调试口现截一张，所以她看到的永远是浏览器里此刻那张，
 * 不再经"别人截图→转发给她"的延迟（飞书码约 1 分钟一换，转发一轮就废了）。
 *
 * 浏览器没起来 → 先 POST /api/huixing/start 拉起登录脚本（它自己带后台等扫码 + 写 token）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { CODE_ROOT } from './config.js';
import { getVaultRoot } from '../src/mcp/utils/helper.js';

const CDP_PORT = 9337;
const SCRIPT = path.join(CODE_ROOT, 'scripts', 'huixing-token.mjs');
const TOKEN_FILE = path.join(getVaultRoot(), 'Client', '豆姐专属', '汇星token.txt');
const QR_FILE = path.join(getVaultRoot(), 'Client', '豆姐专属', '汇星登录二维码.png');

function getJson<T>(url: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => {
        try {
          resolve(JSON.parse(d) as T);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('cdp timeout')));
  });
}

/**
 * 连登录脚本的无头 Chrome 现截二维码。
 * 飞书的码约 1 分钟过期，过期后页面盖一层"刷新二维码"蒙版——**截图前先把它点掉**再截，
 * 否则截到的永远是那张失效提示图（豆姐反馈"发来的码全是要刷新的"就是这个）。
 * 只截二维码卡片那块（canvas 外扩一圈），手机上更大更好扫。
 */
async function captureLive(): Promise<Buffer | null> {
  let pages: Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
  try {
    pages = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  } catch {
    return null; // 浏览器没起来
  }
  const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) return null;
  return new Promise((resolve) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl!, { perMessageDeflate: false });
    let settled = false;
    const done = (b: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* 已关 */
      }
      resolve(b);
    };
    const timer = setTimeout(() => done(null), 9000);
    const send = (id: number, method: string, params: unknown) => ws.send(JSON.stringify({ id, method, params }));
    // id 1 = 过期就点刷新（返回是否点了）；id 2 = 量二维码位置；id 3 = 截图
    const REFRESH_IF_STALE = `(() => {
      const el = [...document.querySelectorAll('span,button,a,div')].find((e) => e.childElementCount === 0
        && /刷新二维码|立即刷新|重新获取/.test((e.textContent || '').trim())
        && e.getBoundingClientRect().width > 0);
      if (!el) return false;
      (el.closest('button,a') || el).click();
      return true;
    })()`;
    const QR_RECT = `(() => {
      const c = document.querySelector('canvas');
      if (!c) return '';
      const r = c.getBoundingClientRect();
      const pad = 26;
      return JSON.stringify({ x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 2 });
    })()`;
    ws.on('error', () => done(null));
    ws.on('open', () => send(1, 'Runtime.evaluate', { returnByValue: true, expression: REFRESH_IF_STALE }));
    ws.on('message', (m: Buffer) => {
      let o: { id?: number; result?: { data?: string; result?: { value?: unknown } } };
      try {
        o = JSON.parse(m.toString());
      } catch {
        return;
      }
      if (o.id === 1) {
        // 点过刷新要等新码渲染出来（实测 ~1s），没点过就直接量
        const clicked = o.result?.result?.value === true;
        setTimeout(() => send(2, 'Runtime.evaluate', { returnByValue: true, expression: QR_RECT }), clicked ? 1500 : 0);
        return;
      }
      if (o.id === 2) {
        const raw = o.result?.result?.value;
        const clip = typeof raw === 'string' && raw ? (JSON.parse(raw) as Record<string, number>) : undefined;
        send(3, 'Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
        return;
      }
      if (o.id === 3 && o.result?.data) done(Buffer.from(o.result.data, 'base64'));
    });
  });
}

function tokenState(): { has_token: boolean; exp?: number; mtime?: number } {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    const st = fs.statSync(TOKEN_FILE);
    const payload = JSON.parse(Buffer.from(raw.split('.')[1] ?? '', 'base64').toString('utf8')) as { exp?: number };
    return { has_token: !!raw, exp: payload.exp, mtime: st.mtimeMs };
  } catch {
    return { has_token: false };
  }
}

/** 返回 true = 本次请求已处理 */
export async function handleHuixing(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (url.pathname === '/api/huixing/qr') {
    const live = await captureLive();
    const png = live ?? (fs.existsSync(QR_FILE) ? fs.readFileSync(QR_FILE) : null);
    if (!png) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('登录浏览器没在跑，先点「重新生成」');
      return true;
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-live': live ? '1' : '0' });
    res.end(png);
    return true;
  }
  if (url.pathname === '/api/huixing/state') {
    const s = tokenState();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(s));
    return true;
  }
  if (url.pathname === '/api/huixing/start' && req.method === 'POST') {
    const child = spawn(process.execPath, [SCRIPT, '--force'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, note: '登录流程已拉起，约 5 秒后码就出来' }));
    return true;
  }
  return false;
}
