// list_active_chats tool（MCP 版）
// 阶段 4 批次 2 步骤 2.3：周回顾 sub-agent 调，拿 bot 当前监听的所有 chat 列表
// 多飞书应用：走 IPC 问 supervisor（它持有全部应用的 client），子进程自己只看得到本 chat 所属应用的群。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getSupervisorClient } from "../../ipc/client-singleton.js";
import { IPC_METHODS, type ListChatsResult } from "../../ipc/protocol.js";

export const listActiveChatsTool: Tool = {
  name: "list_active_chats",
  description:
    "拿 bot 当前监听的所有 chat 列表（chat_id + 友好名 + 所属飞书应用标签）。" +
    "含品品所在的全部飞书应用，带 app 标签。用于：周回顾 sub-agent 串行处理所有 chat / 跨 chat 概览。",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export async function handleListActiveChats() {
  try {
    const client = getSupervisorClient();
    const r = await client.request<ListChatsResult>(IPC_METHODS.LIST_CHATS, {});
    const chats = r.chats.map((c) => ({
      chat_id: c.chat_id,
      name: c.name,
      app: c.app_label,
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
