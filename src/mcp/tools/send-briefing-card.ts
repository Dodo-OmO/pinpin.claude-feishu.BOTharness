// send_briefing_card tool（MCP 版）
// 阶段 4 批次 2 步骤 2.2：主 session 拿 daily-briefing-agent items 推关注事项给Owner
// **阶段 4 MVP**：text 消息（飞书 interactive 卡片留阶段后续）

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { sendText } from "./feishu-send.js";
import { dateYYYYMMDD } from "../utils/helper.js";

interface BriefingItem {
  title: string;
  due?: string;
  reason?: string;
  link?: string;
}

export const sendBriefingCardTool: Tool = {
  name: "send_briefing_card",
  description:
    "推每日关注事项给指定 chat。items 是 daily-briefing-agent 筛出来的任务列表（含 title/due/reason/link）。空数组静默跳过。",
  inputSchema: {
    type: "object",
    properties: {
      chat_id: { type: "string", description: "目标 chat_id" },
      items: { type: "array", description: "任务列表", items: { type: "object" } },
    },
    required: ["chat_id", "items"],
  },
};

export async function handleSendBriefingCard(args: { chat_id: string; items: BriefingItem[] }) {
  const { chat_id, items } = args;
  if (!items || items.length === 0) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ skipped: true, reason: "今日无需提醒，静默跳过" }) }],
    };
  }
  const today = dateYYYYMMDD();
  const lines = [`📋 ${today} 关注事项 (${items.length} 项)`, ""];
  for (const it of items) {
    lines.push(`▸ ${it.title}`);
    if (it.due) lines.push(`  📅 ${it.due}`);
    if (it.reason) lines.push(`  💡 ${it.reason}`);
    if (it.link) lines.push(`  🔗 ${it.link}`);
    lines.push("");
  }
  const text = lines.join("\n");
  try {
    await sendText(chat_id, text);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ delivered: true, count: items.length }) }],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `推关注事项失败：${msg}` }] };
  }
}
