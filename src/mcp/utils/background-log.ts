// 后台账本（MCP 版）
// 结构：vault\系统日志\后台账本\YYYY-MM\YYYY-MM-DD.md（月目录 + 每天一个文件）。
// 多类别用行内 [category] 字段区分（cron 跑动 / 心境衰减 / token 保活 / mcp-boot / inbound 等）。
// 保留串行队列 + EBUSY 重试（同 chat-log 模式）。

import fs from "node:fs";
import path from "node:path";
import { dateYYYYMM, dateYYYYMMDD, timeHHMM, getVaultRoot, ensureDir } from "./helper.js";

const LOG_ROOT = path.join(getVaultRoot(), "系统日志", "后台账本");

let writeQueue: Promise<void> = Promise.resolve();

function getLogPath(): string {
  const monthDir = path.join(LOG_ROOT, dateYYYYMM());
  ensureDir(monthDir);
  return path.join(monthDir, `${dateYYYYMMDD()}.md`);
}

async function tryAppend(filePath: string, content: string): Promise<void> {
  const delays = [50, 100, 150];
  for (let i = 0; i <= delays.length; i++) {
    try {
      fs.appendFileSync(filePath, content, "utf-8");
      return;
    } catch (e) {
      if (i === delays.length) {
        console.warn(
          `[background-log] Failed to append after ${delays.length + 1} tries:`,
          e instanceof Error ? e.message : e
        );
        return;
      }
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

/**
 * 记一条后台事件——cron 跑动 / 心境衰减 / token 保活 / sub-agent 调度 等全用这个
 * 格式：`YYYY-MM-DD HH:MM [category] content`
 */
export function logBackground(category: string, content: string): void {
  const line = `${dateYYYYMMDD()} ${timeHHMM()} [${category}] ${content.trim()}\n`;
  writeQueue = writeQueue.then(() => tryAppend(getLogPath(), line));
}
