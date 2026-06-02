// 后台账本（MCP 版）
// 结构：vault\系统日志\后台账本\YYYY-MM\YYYY-MM-DD.md（月目录 + 每天一个文件）。
// 多类别用行内 [category] 字段区分（cron 跑动 / 心境衰减 / token 保活 / mcp-boot / inbound 等）。
// 保留串行队列 + EBUSY 重试（同 chat-log 模式）。

import fs from "node:fs";
import path from "node:path";
import { dateYYYYMM, dateYYYYMMDD, timeHHMM, getVaultRoot } from "./helper.js";

const LOG_ROOT = path.join(getVaultRoot(), "系统日志", "后台账本");

let writeQueue: Promise<void> = Promise.resolve();

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

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

/**
 * 读后台账本——读某月目录下所有按天文件（拼接），支持按 category 过滤
 * @param month YYYY-MM（默认本月）
 * @param category 可选过滤
 */
export function readBackgroundLog(month?: string, category?: string): string {
  const m = month ?? dateYYYYMM();
  const monthDir = path.join(LOG_ROOT, m);
  if (!fs.existsSync(monthDir)) return "";
  let content: string;
  try {
    const files = fs
      .readdirSync(monthDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    content = files.map((f) => fs.readFileSync(path.join(monthDir, f), "utf-8")).join("");
  } catch {
    return "";
  }
  if (!category) return content;
  return content
    .split("\n")
    .filter((line) => line.includes(`[${category}]`))
    .join("\n");
}
