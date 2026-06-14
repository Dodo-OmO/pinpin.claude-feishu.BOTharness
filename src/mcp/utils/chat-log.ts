// 对话记录读写（MCP 版）
// 阶段 4 批次 0 步骤 0.4：从 早期版本 src/utils/chat-log.ts (277 行) CLI 优雅压到 ~200 行
// CLI 优雅化改动：
//   1. 砍"跨天延续"自动 heading 重写（复杂边界，启动时显式调 appendRestartHeading 即可）
//   2. 砍 readChatLogSinceLastRestart + prepareCompactInput + appendCompactSummary（/compact 留阶段 5/6）
//   3. 新增 readChatLog({ chat_id?, date?, days?, hours? })（优雅清单 4 落实，sub-agent 统一读日志接口）
//   4. 新增 setChatNameCache（chat-message.ts 启动 loadChatList 时填，chat_id → friendly name 映射）
//   5. 保留 EBUSY 重试 + 串行队列 + 跨天检测（实战必要）

import fs from "node:fs";
import path from "node:path";
import { dateYYYYMMDD, timeHHMM, safeName, getVaultRoot, ensureDir } from "./helper.js";

// 对话记录根目录：vault 根（getVaultRoot）下「对话记录」子目录
const LOG_ROOT = path.join(getVaultRoot(), "对话记录");

// chat_id → friendly name 映射（chat-message.ts 启动时填）
const chatNameCache = new Map<string, string>();

export function setChatNameCache(chatId: string, name: string): void {
  chatNameCache.set(chatId, name);
}

export function getChatName(chatId: string): string {
  return chatNameCache.get(chatId) ?? chatId; // cache miss 用 chat_id 兜底
}

// 按 chat 分目录：每 chat 独立 currentDate / currentLogPath 避免跨 chat 并发写串目录
interface ChannelState {
  currentDate: string;
  currentLogPath: string;
  lastRestart?: string; // "YYYY-MM-DD HH:MM"——跨天延续 header 引用"上次重启时间"
}
const channelStates = new Map<string, ChannelState>();

// 按 chat 分串行队列：同 chat 串行避 EBUSY，不同 chat 独立 Promise 链可并行
const writeQueues = new Map<string, Promise<void>>();

function getLogPath(date: string, chatName: string): string {
  const month = date.slice(0, 7); // YYYY-MM
  const monthDir = path.join(LOG_ROOT, safeName(chatName), month);
  ensureDir(monthDir);
  return path.join(monthDir, `${date}.md`);
}

function getNextRestartCount(filePath: string): number {
  if (!fs.existsSync(filePath)) return 1;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const matches = content.match(/^# \d{4}-\d{2}-\d{2} 第 \d+ 轮重启/gm);
    return (matches?.length ?? 0) + 1;
  } catch {
    return 1;
  }
}

async function tryAppend(filePath: string, content: string): Promise<void> {
  // EBUSY 重试：Obsidian watcher 偶尔短暂占用 .md 文件
  const delays = [50, 100, 150];
  for (let i = 0; i <= delays.length; i++) {
    try {
      fs.appendFileSync(filePath, content, "utf-8");
      return;
    } catch (e) {
      if (i === delays.length) {
        console.warn(
          `[chat-log] Failed to append after ${delays.length + 1} tries:`,
          e instanceof Error ? e.message : e
        );
        return;
      }
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

function appendLine(chatId: string, line: string): void {
  const chatName = getChatName(chatId);
  const prevQueue = writeQueues.get(chatId) ?? Promise.resolve();
  const newQueue = prevQueue.then(async () => {
    // 跨天检测
    const today = dateYYYYMMDD();
    let state = channelStates.get(chatId);
    if (state && today !== state.currentDate) {
      state.currentDate = today;
      state.currentLogPath = getLogPath(today, chatName);
      // 跨天延续（品品一直没下线、跨过零点）：新一天文件开头标一行，注明上次重启时间
      const contHeading = `# ${today}（跨天延续·未重启，上次重启 ${state.lastRestart ?? "未知"}）\n\n`;
      await tryAppend(state.currentLogPath, contHeading);
    }
    if (!state) {
      state = { currentDate: today, currentLogPath: getLogPath(today, chatName) };
      channelStates.set(chatId, state);
    }
    await tryAppend(state.currentLogPath, line);
  });
  writeQueues.set(chatId, newQueue);
}

// ── 写接口（被 chat-message.ts 入站 / pinpin_reply_* 出站调用）────

/** MCP server 启动时为每个 chat 调一次：append `# YYYY-MM-DD 第 N 轮重启 HH:MM` 标题 */
export function appendRestartHeading(chatId: string): void {
  const chatName = getChatName(chatId);
  const today = dateYYYYMMDD();
  const logPath = getLogPath(today, chatName);
  const restartLabel = `${today} ${timeHHMM()}`;
  channelStates.set(chatId, { currentDate: today, currentLogPath: logPath, lastRestart: restartLabel });
  const n = getNextRestartCount(logPath);
  const heading = `# ${today} 第 ${n} 轮重启 ${timeHHMM()}\n\n`;
  try {
    fs.appendFileSync(logPath, heading, "utf-8");
  } catch (e) {
    console.warn(
      `[chat-log] Failed to append restart heading for ${chatName}:`,
      e instanceof Error ? e.message : e
    );
  }
}

/** 用户消息入站：append `HH:MM 发送者｜内容` */
export function appendUserMessage(
  chatId: string,
  senderName: string,
  content: string,
  replyTo?: string
): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  const senderTag = replyTo ? `${senderName} ↩️${replyTo}` : senderName;
  appendLine(chatId, `${timeHHMM()} ${senderTag}｜${trimmed}\n\n`);
}

/** 品品回复出站：append `HH:MM 品品｜内容` */
export function appendBotReply(chatId: string, content: string): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  appendLine(chatId, `${timeHHMM()} 品品｜${trimmed}\n\n`);
}

// ── 读接口（优雅清单 4：read_chat_log tool 统一签名）────

export interface ReadChatLogOpts {
  /** 指定单 chat（不传 = 所有 chat） */
  chat_id?: string;
  /** 指定单日（YYYY-MM-DD，不传 = 默认今天，days/hours 优先） */
  date?: string;
  /** 近 N 天（含今天） */
  days?: number;
  /** 近 N 小时（按行内 HH:MM 时间戳过滤；要求 days 隐式 = 1） */
  hours?: number;
}

/**
 * 统一读对话日志（合并 早期版本的 read_recent_chat_log / restart_care_read_log /
 * daily_diary_read_yesterday_logs 三个 tool 入口）
 *
 * 返回 { chat_name → 文本内容拼接 } 字典（chat_id 不传时多 chat 全量）
 */
export function readChatLog(opts: ReadChatLogOpts = {}): Record<string, string> {
  const result: Record<string, string> = {};

  // 1. 确定要读哪些 chat 子目录
  let chatNames: string[];
  if (opts.chat_id) {
    chatNames = [safeName(getChatName(opts.chat_id))];
  } else {
    if (!fs.existsSync(LOG_ROOT)) return result;
    chatNames = fs
      .readdirSync(LOG_ROOT)
      .filter((d) => fs.statSync(path.join(LOG_ROOT, d)).isDirectory());
  }

  // 2. 确定要读哪些日期
  const dates: string[] = [];
  if (opts.date) {
    dates.push(opts.date);
  } else if (opts.days && opts.days > 0) {
    for (let i = 0; i < opts.days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(dateYYYYMMDD(d));
    }
  } else if (opts.hours && opts.hours > 0) {
    // hours 模式：跨午夜时需要昨天+今天两天文件
    dates.push(dateYYYYMMDD()); // 今天
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    dates.push(dateYYYYMMDD(yesterday)); // 昨天（窗口可能跨午夜）
  } else {
    dates.push(dateYYYYMMDD()); // 默认今天
  }

  // 3. 读 + 可选按 hours 过滤
  for (const chatName of chatNames) {
    const parts: string[] = [];
    for (const date of dates) {
      const month = date.slice(0, 7);
      const filePath = path.join(LOG_ROOT, chatName, month, `${date}.md`);
      if (!fs.existsSync(filePath)) continue;
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      if (opts.hours && opts.hours > 0) {
        content = filterByRecentHours(content, opts.hours, date);
      }
      if (content.trim()) parts.push(`### ${date}\n${content.trim()}`);
    }
    if (parts.length) result[chatName] = parts.join("\n\n");
  }

  return result;
}

/**
 * 按行内 HH:MM 时间戳过滤近 N 小时。
 * fileDate: 该行所属文件的日期（YYYY-MM-DD），用于跨午夜场景下正确组成完整 Date 再比较。
 * 弃 HH:MM 字符串比较——跨午夜时昨天 23:xx > 今天 01:xx 字符串比较会误判。
 */
function filterByRecentHours(content: string, hours: number, fileDate?: string): string {
  const cutoffMs = Date.now() - hours * 3600_000;
  const lines = content.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(\d{2}):(\d{2})\s/);
    if (m) {
      let lineMs: number;
      if (fileDate) {
        // 用文件日期 + 行内 HH:MM 组成完整时间戳比较
        lineMs = new Date(`${fileDate}T${m[1]}:${m[2]}:00`).getTime();
      } else {
        // 降级：用今天日期（无 fileDate 时）
        lineMs = new Date(`${dateYYYYMMDD()}T${m[1]}:${m[2]}:00`).getTime();
      }
      if (lineMs >= cutoffMs) out.push(line);
    } else if (line.startsWith("# ") || line.startsWith("## ")) {
      // H1/H2 标题行（如 "# 2026-05-27 第 N 轮重启"）总保留作上下文
      out.push(line);
    }
  }
  return out.join("\n");
}
