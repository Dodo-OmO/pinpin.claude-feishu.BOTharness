// trigger_free_activity tool（MCP 版）
// 阶段 4 批次 2 步骤 2.5：手动入口——Owner发"/自由活动"等触发时主 session 调本 tool
// 等同于 cron 提前手动触发一次

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { pushChannelTrigger } from "../utils/push-channel.js";

export const triggerFreeActivityTool: Tool = {
  name: "trigger_free_activity",
  description:
    "手动触发一次自由活动（Owner说'/自由活动'或菜单🎲按钮 → 主 session 调本 tool）。" +
    "本 tool 推 free-activity trigger 给主 session 自己（绕一圈走自由活动 skill），等同于 cron 提前触发。",
  inputSchema: {
    type: "object",
    properties: {
      chat_id: { type: "string", description: "触发自由活动的 chat_id（一般是茶水间或单聊Owner）" },
    },
    required: ["chat_id"],
  },
};

export async function handleTriggerFreeActivity(args: { chat_id: string }) {
  const { chat_id } = args;
  await pushChannelTrigger({
    trigger: "free-activity",
    chat_id,
    body:
      "🌿 自由活动（手动触发）。请按 `.claude/skills/自由活动/SKILL.md` 走流程——8 选项任选。" +
      "如选「外出学习/网上冲浪」记得 Task 派 journey-agent。结束 write_journey_log 写台账。",
    meta: { manual: true },
  });
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ triggered: true, chat_id }) }],
  };
}
