// delete_cloud_doc tool——删品品自己建的云文档（docx/sheet/bitable），并默认从当前群标签页移除。
// 飞书 drive.v1.file.delete 进回收站可恢复；只能删自己建的（删别人的飞书拒）。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";
import { detachDocFromChat } from "../feishu/cloud-doc-ops.js";

export const deleteCloudDocTool: Tool = {
  name: "delete_cloud_doc",
  description:
    "删品品自己建的云文档（docx/sheet/bitable）——只能删自己建的（删别人的飞书会拒）。" +
    "默认同时从当前群标签页移除该文档（detach_from_chat=false 不移除、chat_id 指定别的群）。删除进飞书回收站可恢复。",
  inputSchema: {
    type: "object",
    properties: {
      token: { type: "string", description: "文档 token（建文档时返回的 token）" },
      type: { type: "string", enum: ["docx", "sheet", "bitable"], description: "文档格式" },
      detach_from_chat: { type: "boolean", description: "是否同时从群标签移除，默认 true" },
      chat_id: { type: "string", description: "可选，从指定群移除标签（不传=当前群）" },
    },
    required: ["token", "type"],
  },
};

export async function handleDeleteCloudDoc(args: {
  token: string;
  type: "docx" | "sheet" | "bitable";
  detach_from_chat?: boolean;
  chat_id?: string;
}) {
  try {
    const client = getFeishuClient();
    // 先移除群标签（趁标签还指向该文档好匹配），再删文档本身
    let detached = 0;
    if (args.detach_from_chat !== false) {
      const chatId = args.chat_id || process.env.PINPIN_CHAT_ID;
      if (chatId) detached = await detachDocFromChat(chatId, args.token);
    }
    const res = await client.drive.v1.file.delete({ path: { file_token: args.token }, params: { type: args.type } });
    if (res.code !== 0) {
      const hint = /permission|forbidden|denied|1061|403/i.test(res.msg || "") ? "（只能删品品自己建的文档）" : "";
      return { isError: true, content: [{ type: "text" as const, text: `删文档失败：code=${res.code} msg=${res.msg}${hint}` }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ deleted: true, token: args.token, detached_tabs: detached }) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = /permission|forbidden|denied|403/i.test(msg) ? "（只能删品品自己建的文档）" : "";
    return { isError: true, content: [{ type: "text" as const, text: `删文档失败：${msg}${hint}` }] };
  }
}
