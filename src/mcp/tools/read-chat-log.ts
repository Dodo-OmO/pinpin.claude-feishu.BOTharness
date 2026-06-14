// read_chat_log tool（MCP 版）
// 阶段 4 批次 1 步骤 1.5：优雅清单 4 落实——统一接口供 sub-agent 调（合并 早期版本
// read_recent_chat_log / restart_care_read_log / daily_diary_read_yesterday_logs）
//
// inputSchema：
//   chat_id?: string  指定单 chat（不传 = 所有 chat）
//   date?: string     指定单日 YYYY-MM-DD（不传 = 默认今天，days/hours 优先）
//   days?: number     近 N 天（含今天）
//   hours?: number    近 N 小时（按行内 HH:MM 时间戳过滤；隐式 days=1）
//
// 返回：{ chat_name → 拼好的对话日志文本 } JSON 字典

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { readChatLog } from "../utils/chat-log.js";

export const readChatLogTool: Tool = {
  name: "read_chat_log",
  description:
    "读对话日志——拿指定 chat / 指定日期 / 近 N 天或 N 小时的对话原文。" +
    "调用约定：① chat_id 不传 = 所有 chat（量大慎用）；② date / days / hours 三选一（优先级 date > days > hours）；" +
    "③ 默认（全不传）= 今天所有 chat。返回 JSON 字典 chat_name → 文本。",
  inputSchema: {
    type: "object",
    properties: {
      chat_id: {
        type: "string",
        description: "目标 chat_id（如 oc_xxx）。不传 = 所有 chat 全读。",
      },
      date: {
        type: "string",
        description: "目标日期 YYYY-MM-DD（如 2026-05-27）。不传 = 默认今天。",
      },
      days: {
        type: "number",
        description: "近 N 天（含今天）。例：days=7 = 最近 7 天。优先级高于 date。",
      },
      hours: {
        type: "number",
        description: "近 N 小时（按行内 HH:MM 时间戳过滤，自动含昨天+今天文件支持跨午夜）。例：hours=12 = 近 12 小时。优先级低于 date/days。",
      },
    },
  },
};

export async function handleReadChatLog(args: {
  chat_id?: string;
  date?: string;
  days?: number;
  hours?: number;
}) {
  const result = readChatLog(args);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
