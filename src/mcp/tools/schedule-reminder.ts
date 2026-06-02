// schedule_reminder tool（MCP 版）
// 协议 #41——主 session 注册"N 分钟后 / 某个具体时间 提醒我 X"
// 合并自原 schedule_after_minutes + schedule_at_time：minutes 与 fire_at_iso 二选一

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { addTimerJob } from "../db/database.js";
import { scheduleJob } from "../cron/scheduled-jobs-tick.js";

export const scheduleReminderTool: Tool = {
  name: "schedule_reminder",
  description:
    "注册一个定时提醒。fire 时品品会收到 scheduled-timer trigger 自动按 context_hint + payload 说出提醒。" +
    "时间二选一：minutes（多少分钟后）或 fire_at_iso（ISO 8601 绝对时间，如 '2026-05-27T18:30:00+08:00'），恰好提供一个。" +
    "intent=hard 必须提醒（Owner吃药等），intent=soft 可错过（休闲建议）。",
  inputSchema: {
    type: "object",
    properties: {
      chat_id: { type: "string", description: "提醒发到哪个 chat" },
      minutes: { type: "number", description: "多少分钟后触发（1-43200，即 1 分钟~30 天）。与 fire_at_iso 二选一" },
      fire_at_iso: { type: "string", description: "ISO 8601 绝对时间（含时区）。与 minutes 二选一" },
      context_hint: { type: "string", description: "事情简述（如 '提醒Owner吃药'）" },
      payload: { type: "string", description: "可选——具体提醒内容/上下文，fire 时 trigger 带出" },
      intent: { type: "string", enum: ["hard", "soft"], description: "hard=必须提醒 / soft=可错过" },
    },
    required: ["chat_id", "context_hint", "intent"],
  },
};

export async function handleScheduleReminder(args: {
  chat_id: string;
  minutes?: number;
  fire_at_iso?: string;
  context_hint: string;
  payload?: string;
  intent: "hard" | "soft";
}) {
  const { minutes, fire_at_iso, context_hint, payload, intent } = args;

  // 时间入参二选一校验
  const hasMinutes = minutes !== undefined && minutes !== null;
  const hasIso = fire_at_iso !== undefined && fire_at_iso !== null && fire_at_iso !== "";
  if (hasMinutes === hasIso) {
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: hasMinutes
          ? "minutes 和 fire_at_iso 不能同时提供，二选一"
          : "必须提供 minutes 或 fire_at_iso 其中一个",
      }],
    };
  }

  // 多 CLI 架构（2026-05-28 Owner决策）：临时 cron 归属当前频道 CLI。
  // 即使 LLM 传入其它 chat_id 也强制改成自家 PINPIN_CHAT_ID——避免在 A 频道设的 timer
  // 被 B 频道 CLI 错位调度（scheduled-jobs-tick handler 也按 PINPIN_CHAT_ID 过滤兜底）
  const ownChatId = process.env.PINPIN_CHAT_ID;
  const chat_id = ownChatId ?? args.chat_id;
  if (ownChatId && args.chat_id && args.chat_id !== ownChatId) {
    process.stderr.write(
      `[schedule_reminder] LLM 传入 chat_id=${args.chat_id.slice(-8)} 与自家 ${ownChatId.slice(-8)} 不一致，强制改为自家\n`,
    );
  }

  // 计算 fire_at
  let fireMs: number;
  if (hasMinutes) {
    if (!Number.isFinite(minutes) || (minutes as number) < 1 || (minutes as number) > 43200) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `minutes 越界 (${minutes})，请填 1-43200（1 分钟到 30 天）` }],
      };
    }
    fireMs = Date.now() + (minutes as number) * 60 * 1000;
  } else {
    fireMs = Date.parse(fire_at_iso as string);
    if (Number.isNaN(fireMs)) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `fire_at_iso 解析失败：${fire_at_iso}（应是 ISO 8601 格式）` }],
      };
    }
    if (fireMs <= Date.now()) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `fire_at_iso 已过去：${fire_at_iso}（现在 ${new Date().toISOString()}）` }],
      };
    }
  }

  const fireAtIso = new Date(fireMs).toISOString();
  const jobId = addTimerJob({ chatId: chat_id, fireAtIso, contextHint: context_hint, payload, intent });
  scheduleJob(jobId);
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ scheduled: true, job_id: jobId, fire_at: fireAtIso }) },
    ],
  };
}
