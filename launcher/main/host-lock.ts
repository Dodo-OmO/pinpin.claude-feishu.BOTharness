/**
 * 主机开关：多台电脑共享同步盘时，同一时刻只允许一台跑品品（飞书长连接 / 隧道只投一个客户端，双开会随机分流）。
 *
 * `<代码包>/../品品主机.txt`：第 1 行 = 该跑品品的电脑名，第 2 行 = 切换口令。
 * 启动器开启时主机是别台 → 问Owner要不要切 → 改开关 → 等那台 guard 停机后写回执 `品品主机-已停-<那台>.txt`（带同一口令）
 * → 导入那台交出的频道配置 / 认人表。
 * 那台的停机 / 导出状态包逻辑在 warden/warden-guard.ps1。
 */

import { dialog, Notification } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ME = process.env['COMPUTERNAME'] ?? os.hostname();
const WAIT_MS = 10 * 60_000; // guard 30s 一查 + 停机 + 导出状态包 + 同步盘传播
const POLL_MS = 5_000;

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim());
  } catch {
    return [];
  }
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** true = 本机可以跑品品；false = Owner取消，调用方退出。 */
export async function ensureThisMachineIsHost(appRoot: string, userDataDir: string): Promise<boolean> {
  const dir = path.join(appRoot, '..');
  const hostFile = path.join(dir, '品品主机.txt');
  const current = readLines(hostFile)[0];
  if (current && sameName(current, ME)) return true;
  if (!current) {
    fs.writeFileSync(hostFile, `${ME}\n`, 'utf8');
    return true;
  }

  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: '品品',
    message: `品品现在由「${current}」这台电脑运行`,
    detail: '两台电脑不能同时跑品品。切到这台后，那台会在几分钟内自动停下，这台接手。',
    buttons: ['切到这台', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;

  const token = randomUUID();
  fs.writeFileSync(hostFile, `${ME}\n${token}\n`, 'utf8');
  new Notification({ title: '品品', body: `正在等「${current}」停下，通常 1～3 分钟…` }).show();

  const receipt = path.join(dir, `品品主机-已停-${current}.txt`);
  for (const end = Date.now() + WAIT_MS; Date.now() < end; ) {
    if (readLines(receipt)[0] === token) {
      // 接手那台停机时交出的频道配置 / 认人表（userData 是每台电脑各一份）
      const handoff = path.join(dir, '品品主机-交接');
      for (const f of ['channel-config.json', 'name-mappings.json']) {
        try {
          fs.copyFileSync(path.join(handoff, f), path.join(userDataDir, f));
        } catch {
          /* 那台没有该文件 → 沿用本机 */
        }
      }
      return true;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  const { response: goOn } = await dialog.showMessageBox({
    type: 'warning',
    title: '品品',
    message: `没等到「${current}」停下的确认`,
    detail: '可能那台已经关机，或同步盘还没传过来。请确认那台电脑的品品已经停了，再继续——两台同时跑会让飞书消息随机丢到另一台。',
    buttons: ['那台已停，继续启动', '退出'],
    defaultId: 1,
    cancelId: 1,
  });
  return goOn === 0;
}
