// delete_channel tool（协议追加 2026-09-16）——【仅Owner】彻底删除一个频道
//
// 双闸 fail-closed：① OWNER 鉴权（checkOwner，本频道最近发言者必须是Owner）
//                  ② confirm_name 必须原样复述频道显示名（供 IPC 端二次比对，防误删）
// 群 → 品品自建的解散（isCreatedByPinpin），否则退群（chatMembers.delete 移除自己）；
// 私聊 → 只清本地（配置/待办/简报归档/对话记录归档/画像映射），不动飞书那边。
// 实际动作全在 supervisor（有 DB 与 vault 访问权限的是它/子进程各半，归档在 supervisor 做）——
// 本 tool 只负责鉴权 + IPC 请求 + 本地收尾（取消待办、删自建群标记）。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { isCreatedByPinpin, removeCreatedGroup, cancelPendingJobsByChat } from "../db/database.js";
import { checkOwner } from "../owner-auth.js";
import { getSupervisorClient } from "../../ipc/client-singleton.js";
import { IPC_METHODS, type DeleteChannelParams, type DeleteChannelResult } from "../../ipc/protocol.js";

export const deleteChannelTool: Tool = {
  name: "delete_channel",
  description:
    "【仅Owner】彻底删除一个频道：群→你建的就解散、否则你退群；私聊→只清本地。" +
    "清配置/待办，简报与对话记录挪进归档。confirm_name 原样填频道名或飞书群名（list_active_chats 可查）。" +
    "删后对方再来消息会作为新频道（默认睡眠）出现。",
  inputSchema: {
    type: "object",
    properties: {
      chat_id: { type: "string", description: "要删除的频道 chat_id" },
      confirm_name: { type: "string", description: "该频道当前显示名，原样复述（防误删）" },
    },
    required: ["chat_id", "confirm_name"],
  },
};

interface DeleteChannelArgs {
  chat_id: string;
  confirm_name: string;
}

export async function handleDeleteChannel(
  args: DeleteChannelArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { chat_id, confirm_name } = args;
  if (!chat_id || !confirm_name) {
    return { isError: true, content: [{ type: "text", text: "缺少必填参数 chat_id 或 confirm_name" }] };
  }
  // 删自己所在频道会先杀掉本进程，结果回不到聊天里 → 必须从别的频道操作
  if (chat_id === process.env.PINPIN_CHAT_ID) {
    return { isError: true, content: [{ type: "text", text: "不能在要删的这个频道里删它自己，请到别的频道（比如豆姐私聊）里让我删。" }] };
  }
  // 闸 1：OWNER 鉴权
  const auth = checkOwner();
  if (!auth.ok) {
    return { isError: true, content: [{ type: "text", text: auth.reason ?? "OWNER 鉴权失败" }] };
  }
  const disband = isCreatedByPinpin(chat_id);
  let res: DeleteChannelResult;
  try {
    const client = getSupervisorClient();
    res = await client.request<DeleteChannelResult>(IPC_METHODS.DELETE_CHANNEL, {
      chat_id,
      confirm_name,
      disband,
    } satisfies DeleteChannelParams);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text", text: `删除失败（IPC）：${msg}` }] };
  }
  if (!res.ok) {
    const msg = res.error ?? "未知错误";
    const isPerm = /permission|99991672|forbidden|权限|access|owner/i.test(msg);
    if (isPerm) {
      return {
        isError: true,
        content: [{
          type: "text",
          text:
            "删除失败：飞书应用缺解散群/退群权限。需在飞书开放平台后台开通 im:chat + " +
            "im:chat:operate_as_owner 并重新发布应用版本。原始错误：" + msg,
        }],
      };
    }
    return { isError: true, content: [{ type: "text", text: `删除失败：${msg}` }] };
  }
  const cancelled = cancelPendingJobsByChat(chat_id);
  if (disband) removeCreatedGroup(chat_id);
  const kindLabel = res.kind === 'group' ? (disband ? '已解散群' : '已退群') : '私聊，仅清本地';
  return {
    content: [{
      type: "text",
      text:
        `已删除「${res.chat_name ?? chat_id}」（${kindLabel}）；取消待办 ${cancelled} 条；` +
        `归档：${res.archived?.length ? res.archived.join('、') : '无'}`,
    }],
  };
}
