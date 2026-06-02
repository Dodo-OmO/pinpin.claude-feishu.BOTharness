// cancel_scheduled tool（MCP 版）
// 阶段 4 批次 3 步骤 3.3：协议 #41 取消调度任务
// 传 job_id = 取消该任务；不传 = 返当前 pending 任务清单文本（卡片版留阶段后续）

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { cancelJob, listAllPendingJobs } from "../db/database.js";
import { unscheduleJob } from "../cron/scheduled-jobs-tick.js";

export const cancelScheduledTool: Tool = {
  name: "cancel_scheduled",
  description:
    "取消一个之前注册的 timer/speak-watch 任务。" +
    "传 job_id = 取消该任务（仅 status=pending 可取消）；" +
    "不传 = 返当前所有 pending 任务列表（Owner说'有啥任务' / '取消任务'但没给 id 时用）。",
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "number", description: "要取消的任务 id（不传 = 列清单）" },
      chat_id: { type: "string", description: "可选过滤——只列某 chat 的 pending" },
    },
  },
};

export async function handleCancelScheduled(args: { job_id?: number; chat_id?: string }) {
  if (args.job_id !== undefined) {
    const ok = cancelJob(args.job_id);
    if (ok) unscheduleJob(args.job_id);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ cancelled: ok, job_id: args.job_id, reason: ok ? "已取消" : "job 不存在或已 fire/cancel" }),
        },
      ],
    };
  }
  const pending = listAllPendingJobs(args.chat_id);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          count: pending.length,
          jobs: pending.map((j) => ({
            id: j.id,
            type: j.type,
            chat_id: j.chat_id,
            fire_at: j.fire_at,
            watch_user_id: j.watch_user_id,
            context_hint: j.context_hint,
            intent: j.intent,
          })),
        }),
      },
    ],
  };
}
