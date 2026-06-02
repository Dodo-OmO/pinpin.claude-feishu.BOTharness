// list_active_chats tool（MCP 版）
// 阶段 4 批次 2 步骤 2.3：周回顾 sub-agent 调，拿 bot 当前监听的所有 chat 列表

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";
import { getChatName } from "../utils/chat-log.js";

export const listActiveChatsTool: Tool = {
  name: "list_active_chats",
  description:
    "拿 bot 当前监听的所有 chat 列表（chat_id + 友好名）。" +
    "用于：周回顾 sub-agent 串行处理所有 chat / 跨 chat 概览。",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export async function handleListActiveChats() {
  try {
    const client = getFeishuClient();
    const res = await client.im.v1.chat.list({
      params: { page_size: 100, sort_type: "ByCreateTimeAsc" },
    });
    const items = res.data?.items ?? [];
    const chats = items
      .filter((c) => !!c.chat_id)
      .map((c) => ({
        chat_id: c.chat_id!,
        name: c.name ?? getChatName(c.chat_id!),
      }));
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ count: chats.length, chats }, null, 2) },
      ],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `拿 chat 列表失败：${msg}` }],
    };
  }
}
