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

// chat_id → friendly name 映射（chat-message.ts 收到入站消息时填；env PINPIN_CHAT_NAME 兜底）
const chatNameCache = new Map<string, string>();

export function setChatNameCache(chatId: string, name: string): void {
  chatNameCache.set(chatId, name);
}

export function getChatName(chatId: string): string {
  // 缓存优先（入站消息填的友好名）→ 仅本频道（PINPIN_CHAT_ID）时退到启动时 env 里的频道名
  // （覆盖"首次写盘早于首条入站"的路径，例如重启后先发定时/触发产出）→ 最后才用 chat_id 兜底。
  return (
    chatNameCache.get(chatId) ??
    (chatId === process.env.PINPIN_CHAT_ID ? process.env.PINPIN_CHAT_NAME : undefined) ??
    chatId
  );
}

/** 是否已有该 chat 的友好名（缓存命中，或本频道 env 名非空）——供 chat-message.ts 判断是否需要派生单聊名 */
export function hasChatName(chatId: string): boolean {
  if (chatNameCache.has(chatId)) return true;
  return chatId === process.env.PINPIN_CHAT_ID && Boolean(process.env.PINPIN_CHAT_NAME);
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
  /** 近 N 小时（无 since 时转换成 since = now - hours*3600e3） */
  hours?: number;
  /** 窗口起点（毫秒时间戳）。给了 since 时按 [since, until] 精确过滤，优先级高于 hours */
  since?: number;
  /** 窗口终点（毫秒时间戳，不传 = 不设上限） */
  until?: number;
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

  // 2. since/until：无 since 时 hours 转换成 since = now - hours*3600e3
  let sinceMs = opts.since;
  if (sinceMs === undefined && opts.hours && opts.hours > 0) {
    sinceMs = Date.now() - opts.hours * 3600_000;
  }
  const untilMs = opts.until;

  // 3. 确定要读哪些日期（优先级：date > days > since/until(含 hours 转换) > 默认今天）
  const dates: string[] = [];
  if (opts.date) {
    dates.push(opts.date);
  } else if (opts.days && opts.days > 0) {
    for (let i = 0; i < opts.days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(dateYYYYMMDD(d));
    }
  } else if (sinceMs !== undefined) {
    // since 所在日 → (until ?? now) 所在日，逐日列出；上限 3 天，超出只取最近 3 天
    const endMs = untilMs ?? Date.now();
    const cur = new Date(sinceMs);
    cur.setHours(0, 0, 0, 0);
    const last = new Date(endMs);
    last.setHours(0, 0, 0, 0);
    const dayList: string[] = [];
    while (cur <= last) {
      dayList.push(dateYYYYMMDD(cur));
      cur.setDate(cur.getDate() + 1);
    }
    dates.push(...(dayList.length > 3 ? dayList.slice(-3) : dayList));
  } else {
    dates.push(dateYYYYMMDD()); // 默认今天
  }

  // 4. 读 + 可选按 since/until 窗口过滤
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
      if (sinceMs !== undefined) {
        content = filterByWindow(content, date, sinceMs, untilMs);
      }
      if (content.trim()) parts.push(`### ${date}\n${content.trim()}`);
    }
    if (parts.length) result[chatName] = parts.join("\n\n");
  }

  return result;
}

/**
 * 重启回神锚点：本频道在 beforeMs 之前、lookbackMs 以内最后一条对话的时刻（毫秒）；这段时间没有对话 → undefined。
 * 「重启前最近 1 小时」按这个锚点往前取——凌晨定时重启前通常没人说话，按重启时刻取会总是空的。
 */
export function lastActivityBefore(chatId: string, beforeMs: number, lookbackMs: number): number | undefined {
  const logs = readChatLog({ chat_id: chatId, since: beforeMs - lookbackMs, until: beforeMs });
  let last: number | undefined;
  for (const text of Object.values(logs)) {
    let date = "";
    for (const line of text.split("\n")) {
      const d = line.match(/^### (\d{4}-\d{2}-\d{2})$/);
      if (d) { date = d[1]; continue; }
      const m = line.match(/^(\d{2}):(\d{2})\s/);
      if (m && date) {
        const ms = new Date(`${date}T${m[1]}:${m[2]}:00`).getTime();
        if (last === undefined || ms > last) last = ms;
      }
    }
  }
  return last;
}

/**
 * 按时间窗口 [since, until] 过滤内容。
 * fileDate: 该行所属文件的日期（YYYY-MM-DD），用于组成完整 Date 再比较（弃 HH:MM 字符串比较——
 * 跨午夜时昨天 23:xx > 今天 01:xx 字符串比较会误判）。
 * 非时间行：H1/H2 标题行总收集（放上下文）；其它非时间行（多行消息续行）跟随上一时间行的 keep 状态。
 * 若整个文件没有任何时间行落在窗口内，返回 ""（避免只剩标题的空堆输出）。
 */
function filterByWindow(content: string, fileDate: string, since: number, until?: number): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let lastKeep = false;
  let anyTimeLineKept = false;
  for (const line of lines) {
    const m = line.match(/^(\d{2}):(\d{2})\s/);
    if (m) {
      const lineMs = new Date(`${fileDate}T${m[1]}:${m[2]}:00`).getTime();
      lastKeep = lineMs >= since && (until === undefined || lineMs <= until);
      if (lastKeep) {
        out.push(line);
        anyTimeLineKept = true;
      }
    } else if (line.startsWith("# ") || line.startsWith("## ")) {
      out.push(line);
    } else if (lastKeep) {
      out.push(line);
    }
  }
  return anyTimeLineKept ? out.join("\n") : "";
}
