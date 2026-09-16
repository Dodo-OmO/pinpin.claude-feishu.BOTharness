// read_chat_log tool（MCP 版）
// 阶段 4 批次 1 步骤 1.5：优雅清单 4 落实——统一接口供 sub-agent 调（合并 早期版本
// read_recent_chat_log / restart_care_read_log / daily_diary_read_yesterday_logs）
//
// inputSchema：
//   chat_id?: string  指定单 chat（不传 = 所有 chat）
//   date?: string     指定单日 YYYY-MM-DD
//   days?: number     近 N 天（含今天）
//   hours?: number    近 N 小时（无 since 时转成 since）
//   since?/until?     "YYYY-MM-DD HH:MM" 本地时间窗口
//   优先级：date > days > since/until(含 hours 转换) > 默认今天
//
// 返回：{ chat_name → 拼好的对话日志文本 } JSON 字典

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { readChatLog } from "../utils/chat-log.js";

export const readChatLogTool: Tool = {
  name: "read_chat_log",
  description:
    "读对话日志——拿指定 chat / 指定日期 / 近 N 天 / 时间窗口的对话原文。" +
    "调用约定：① chat_id 不传 = 所有 chat（量大慎用）；② date / days / since-until / hours 优先级 date > days > since-until(hours 会转成 since) ；" +
    "③ 默认（全不传）= 今天所有 chat；④ since/until 用 \"YYYY-MM-DD HH:MM\" 本地时间，窗口最多跨 3 天。返回 JSON 字典 chat_name → 文本。",
  inputSchema: {
    type: "object",
    properties: {
      chat_id: {
        type: "string",
        description: "目标 chat_id（如 oc_xxx）。不传 = 所有 chat 全读。",
      },
      date: {
        type: "string",
        description: "目标日期 YYYY-MM-DD（如 2026-05-27）。优先级最高。",
      },
      days: {
        type: "number",
        description: "近 N 天（含今天）。例：days=7 = 最近 7 天。优先级次于 date。",
      },
      hours: {
        type: "number",
        description: "近 N 小时（无 since 时自动转成 since=now-N小时）。优先级低于 date/days/since。",
      },
      since: {
        type: "string",
        description: "窗口起点，本地时间 \"YYYY-MM-DD HH:MM\"。优先级高于 hours。",
      },
      until: {
        type: "string",
        description: "窗口终点，本地时间 \"YYYY-MM-DD HH:MM\"（不传 = 到现在）。需搭配 since 使用。",
      },
    },
  },
};

/** 解析本地时间 "YYYY-MM-DD HH:MM" → 毫秒时间戳；格式非法返回 null */
function parseLocalDateTime(s: string): number | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  return Number.isNaN(dt.getTime()) ? null : dt.getTime();
}

export async function handleReadChatLog(args: {
  chat_id?: string;
  date?: string;
  days?: number;
  hours?: number;
  since?: string;
  until?: string;
}) {
  let sinceMs: number | undefined;
  let untilMs: number | undefined;
  if (args.since !== undefined) {
    const parsed = parseLocalDateTime(args.since);
    if (parsed === null) {
      return {
        content: [{ type: "text" as const, text: `since 格式非法，需 "YYYY-MM-DD HH:MM"：${args.since}` }],
        isError: true,
      };
    }
    sinceMs = parsed;
  }
  if (args.until !== undefined) {
    const parsed = parseLocalDateTime(args.until);
    if (parsed === null) {
      return {
        content: [{ type: "text" as const, text: `until 格式非法，需 "YYYY-MM-DD HH:MM"：${args.until}` }],
        isError: true,
      };
    }
    untilMs = parsed;
  }
  const result = readChatLog({
    chat_id: args.chat_id,
    date: args.date,
    days: args.days,
    hours: args.hours,
    since: sinceMs,
    until: untilMs,
  });
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
