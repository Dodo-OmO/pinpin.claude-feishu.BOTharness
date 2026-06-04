// list_chat_tabs tool——列出飞书群顶部「标签页」上挂的资料（云文档/文件/网页/会议纪要/群公告等）。
// 调飞书 chatTab.listTabs；默认当前群（PINPIN_CHAT_ID），可传 chat_id 查指定群。内外群通吃。
// 限制：doc_list（文档库）只能报"挂了个文档库"展不开内部清单；file/群公告/Pin 无直链字段，只给名称+类型。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";

export const listChatTabsTool: Tool = {
  name: "list_chat_tabs",
  description:
    "列出群顶部标签栏挂的资料（云文档/文件/网页/会议纪要/群公告等），返回 名称+类型+链接。" +
    "默认查当前群；要查别的群传 chat_id（配合 list_active_chats 拿 id 可逐群总览）。" +
    "云文档拿到链接后可接 read_cloud_doc 读内容。文档库标签展不开内部清单。",
  inputSchema: {
    type: "object",
    properties: {
      chat_id: { type: "string", description: "可选，目标群 chat_id；不传=当前群" },
    },
  },
};

// 飞书 tab_type → 中文友好名
const TAB_TYPE_CN: Record<string, string> = {
  doc: "云文档",
  doc_list: "文档库",
  file: "文件",
  url: "网页",
  meeting_minute: "会议纪要",
  chat_announcement: "群公告",
  pin: "Pin消息",
  task: "任务",
};

export async function handleListChatTabs(args?: { chat_id?: string }) {
  const chatId = args?.chat_id || process.env.PINPIN_CHAT_ID;
  if (!chatId) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: "拿不到 chat_id（当前群环境变量缺失，请显式传 chat_id）" }],
    };
  }
  try {
    const client = getFeishuClient();
    const res = await client.im.v1.chatTab.listTabs({ path: { chat_id: chatId } });
    const tabs = (res.data?.chat_tabs ?? [])
      .filter((t) => t.tab_type !== "message") // 内置消息页，无意义
      .map((t) => {
        const c = t.tab_content;
        const url = c?.doc ?? c?.url ?? c?.meeting_minute ?? undefined;
        return {
          name: t.tab_name ?? "",
          type: TAB_TYPE_CN[t.tab_type] ?? t.tab_type,
          ...(url ? { url } : {}),
        };
      });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ chat_id: chatId, count: tabs.length, tabs }, null, 2) },
      ],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = /permission|403|forbidden|denied|99991/i.test(msg)
      ? "（八成是飞书后台没开「读会话标签页」权限）"
      : "";
    return { isError: true, content: [{ type: "text" as const, text: `列群标签页失败：${msg}${hint}` }] };
  }
}
