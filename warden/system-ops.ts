/**
 * 管家系统级能力（独立于启动器）：网络 健康检查（只读）/ 一键拉起启动器。
 *
 * 网络：用「网络端口连通 + 经网络访问国外 + 延迟」三件套判健康（够回答"网络 抽风没"）。
 */
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { CODE_ROOT } from './config.js';

const LOCAL_NET_PORT = 7897;

/** TCP 探测某端口是否可连（端口在 = 服务在跑） */
function tcpPing(port: number, host = '127.0.0.1', timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok: boolean): void => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

/** 经 网络 混合网络(7897)访问国外站(google generate_204)，测连通+延迟 */
function netProbe(): Promise<{ ok: boolean; latency_ms: number | null }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.request(
      {
        host: '127.0.0.1',
        port: LOCAL_NET_PORT,
        method: 'GET',
        path: 'http://www.google.com/generate_204', // 绝对 URL 走 http 网络；国内直连不通，经网络才 204
        headers: { Host: 'www.google.com' },
        timeout: 5000,
      },
      (res) => {
        res.resume();
        const code = res.statusCode ?? 0;
        resolve({ ok: code >= 200 && code < 400, latency_ms: Date.now() - start });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, latency_ms: null });
    });
    req.on('error', () => resolve({ ok: false, latency_ms: null }));
    req.end();
  });
}

export interface NetStatus {
  running: boolean; // 网络端口在 = 网络 在跑
  net_port: number;
  internet_ok: boolean; // 经网络能访问国外
  latency_ms: number | null;
}

export async function checkNet(): Promise<NetStatus> {
  const running = await tcpPing(LOCAL_NET_PORT);
  const probe = running ? await netProbe() : { ok: false, latency_ms: null };
  return {
    running,
    net_port: LOCAL_NET_PORT,
    internet_ok: probe.ok,
    latency_ms: probe.latency_ms,
  };
}

/** 一键拉起启动器（管家以Owner登录态跑 → spawn 的 Electron 窗口在桌面可见，R3） */
export function launchLauncher(): { ok: boolean; error?: string } {
  try {
    const child = spawn('cmd.exe', ['/c', 'npm', 'run', 'launcher:dev'], {
      cwd: CODE_ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
