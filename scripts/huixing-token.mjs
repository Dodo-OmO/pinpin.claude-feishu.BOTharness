#!/usr/bin/env node
// 汇星（test-ma.shortflix.life）登录 token 自动获取。
// 网站只支持"飞书授权"登录：本脚本用一份专用 Chrome 档案走一遍授权跳转，从页面 localStorage 读出 token 写盘。
// 飞书网页登录态存在专用档案里 → 首次需Owner扫一次二维码，之后每天静默续期。
//
// 用法：node scripts/huixing-token.mjs [--force]  # 输出一行 JSON：{ok:true, exp} | {ok:false, need_scan:true, qr_png} | {ok:false, error}
//       need_scan 时脚本已在后台继续等（最长 10 分钟）——Owner扫码后 token 自动写盘、二维码图自动删除。
// 文件：token → vault Client/豆姐专属/汇星token.txt；二维码 → 同目录 汇星登录二维码.png；档案 → %APPDATA%/pinpin-feishu-mcp/huixing-chrome-profile

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') }); // cwd 常是 vault，按脚本位置找代码包 .env

const SITE = 'https://test-ma.shortflix.life';
const VAULT = process.env.BASE_PROJECT_DIR ?? '/path/to/obsidian-vault';
const TOKEN_FILE = path.join(VAULT, 'Client', '豆姐专属', '汇星token.txt');
const QR_FILE = path.join(VAULT, 'Client', '豆姐专属', '汇星登录二维码.png');
const PROFILE = path.join(process.env.APPDATA ?? '', 'pinpin-feishu-mcp', 'huixing-chrome-profile');
const PORT = 9337;
const LOCK = PROFILE + '.lock'; // 同一时刻只允许一份在跑（--wait-bg 最长 30 分钟）
const LOCK_TTL_MS = 31 * 60 * 1000;
const MIN_LEFT_SEC = 2 * 3600; // 剩余不足 2h 才续
const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function tokenExp(tok) {
  try { const p = tok.split('.')[1]; return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).exp ?? 0; } catch { return 0; }
}
function readToken() { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CDP 极简客户端（Node 22+ 自带 WebSocket）──
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } }; }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result?.value; }
}
async function connectPage(port) {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); return new Cdp(ws); }
    } catch { /* 浏览器还没起来 */ }
    await sleep(500);
  }
  throw new Error('浏览器调试口未就绪');
}
function launchBrowser() {
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('没找到 Chrome / Edge');
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=900,1000', 'about:blank'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}
function killBrowser(pid) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { /* 已退出 */ } }
function cleanup(pid, { keepQr = false } = {}) { killBrowser(pid); if (!keepQr) try { fs.unlinkSync(QR_FILE); } catch { /* 无 */ } try { fs.unlinkSync(LOCK); } catch { /* 无 */ } }

// 扫完码后飞书还会停一张授权确认页（豆姐那边只看得到截图、点不到），这里替她点掉
async function clickConsent(cdp) {
  try {
    return await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('button,a,div[role=button],span')].find((e) =>
        e.childElementCount === 0
        && /^(确认授权|同意授权|授权并登录|授权|同意|确认登录|确认|允许|继续)$/.test((e.textContent || '').trim())
        && e.getBoundingClientRect().width > 0);
      if (!el) return false;
      (el.closest('button,a,[role=button]') || el).click();
      return true;
    })()`);
  } catch { return false; }
}

async function tryFinish(cdp) {
  const href = await cdp.eval('location.href');
  if (href.startsWith(SITE)) {
    const tok = await cdp.eval("localStorage.getItem('token')");
    if (tok) { fs.writeFileSync(TOKEN_FILE, tok + '\n', 'utf8'); try { fs.unlinkSync(QR_FILE); } catch { /* 无二维码 */ } return tok; }
  }
  return null;
}

async function main() {
  const waitBg = process.argv.includes('--wait-bg');
  if (!waitBg && !process.argv.includes('--force')) {
    const cur = readToken();
    const left = tokenExp(cur) - Math.floor(Date.now() / 1000);
    if (cur && left > MIN_LEFT_SEC) return out({ ok: true, exp: tokenExp(cur), refreshed: false });
  }
  if (!waitBg) {
    try { const age = Date.now() - fs.statSync(LOCK).mtimeMs; if (age < LOCK_TTL_MS) return out({ ok: false, error: '汇星登录续期正在进行中（等豆姐扫码），稍后再试' }); } catch { /* 无锁 */ }
    fs.mkdirSync(PROFILE, { recursive: true });
    fs.writeFileSync(LOCK, String(process.pid));
  }
  let pid;
  let cdp;
  try {
    pid = waitBg ? Number(process.argv[process.argv.indexOf('--wait-bg') + 1]) : launchBrowser();
    cdp = await connectPage(PORT);
    if (!waitBg) {
      const { authorize_url } = await (await fetch(`${SITE}/api/auth/feishu/login`)).json();
      await cdp.send('Page.navigate', { url: authorize_url });
      // 已有飞书登录态 → 几秒内自动授权跳回站点
      for (let i = 0; i < 12; i++) { await sleep(1000); await clickConsent(cdp); const tok = await tryFinish(cdp); if (tok) { cleanup(pid); return out({ ok: true, exp: tokenExp(tok), refreshed: true }); } }
      // 停在飞书登录页 → 截二维码，后台继续等
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(QR_FILE, Buffer.from(shot.data, 'base64'));
      cdp.ws.close();
      const bg = spawn(process.execPath, [process.argv[1], '--wait-bg', String(pid)], { detached: true, stdio: 'ignore', windowsHide: true });
      bg.unref();
      return out({ ok: false, need_scan: true, qr_png: QR_FILE, note: '把二维码发给豆姐用飞书扫，10 分钟内有效；扫完 token 自动写盘、图自动删' });
    }
    // --wait-bg：最长 30 分钟轮询
    for (let i = 0; i < 900; i++) {
      await sleep(2000);
      await clickConsent(cdp);
      const tok = await tryFinish(cdp);
      if (tok) { cleanup(pid); return; }
      // 飞书二维码约 1 分钟过期、页面会自动换新码：每 40s 重截一次，保证盘上那张扫得了
      if (i % 20 === 19) { try { const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(QR_FILE, Buffer.from(shot.data, 'base64')); } catch { /* 下轮再试 */ } }
    }
    cleanup(pid);
  } catch (e) {
    cleanup(pid);
    if (!waitBg) out({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
main();
