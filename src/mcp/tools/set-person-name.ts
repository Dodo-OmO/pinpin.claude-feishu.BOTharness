// set_person_name tool（协议追加 2026-09-16）——记下某人的称呼（认人表）
//
// 私聊对象还没落显示名时（首次私聊常见），补上的同时把频道显示名一并定成 `VS 名（私聊）`。
// 鉴权：Owner可改任何人；其他人只能让品品记自己的称呼（open_id 必须是本频道最近发言者）。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getSupervisorClient } from "../../ipc/client-singleton.js";
import { checkOwner } from "../owner-auth.js";
import { getLastInboundSenderOpenId } from "../chat-activity.js";
import { IPC_METHODS, type SetPersonNameParams, type WorkOkResult } from "../../ipc/protocol.js";

export const setPersonNameTool: Tool = {
  name: "set_person_name",
  description: "记下某人的称呼（认人表），私聊对象没名字时同时补上频道名。",
  inputSchema: {
    type: "object",
    properties: {
      open_id: { type: "string", description: "对方 open_id（ou_ 开头）" },
      name: { type: "string", description: "怎么称呼对方" },
    },
    required: ["open_id", "name"],
  },
};

interface SetPersonNameArgs {
  open_id: string;
  name: string;
}

export async function handleSetPersonName(
  args: SetPersonNameArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { open_id, name } = args;
  if (!open_id || !name) {
    return { isError: true, content: [{ type: "text", text: "缺少必填参数 open_id 或 name" }] };
  }
  const chatId = process.env.PINPIN_CHAT_ID ?? "";
  if (!checkOwner().ok && getLastInboundSenderOpenId(chatId) !== open_id) {
    return { isError: true, content: [{ type: "text", text: "只能记下正在跟你说话的这个人的称呼；改别人的名字要Owner来说。" }] };
  }
  try {
    const client = getSupervisorClient();
    const res = await client.request<WorkOkResult>(IPC_METHODS.SET_PERSON_NAME, {
      open_id,
      name,
      chat_id: chatId || undefined,
    } satisfies SetPersonNameParams);
    if (!res.ok) {
      return { isError: true, content: [{ type: "text", text: `记名字失败：${res.error ?? "未知错误"}` }] };
    }
    return { content: [{ type: "text", text: `已记下：${open_id} → ${name}` }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text", text: `记名字失败（IPC）：${msg}` }] };
  }
}
