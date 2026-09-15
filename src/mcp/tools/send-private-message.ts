// send_private_message tool（MCP 版）
// 协议 #47——主动单聊 / 传话 / cron 告警等场景给某 open_id 发文字
// 实现：飞书 im.v1.message.create(receive_id_type=open_id, msg_type=text)，走共用 dm-send.ts

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveTargetOpenId, sendDirectMessage } from "../utils/dm-send.js";
import { logBackground } from "../utils/background-log.js";

export const sendPrivateMessageTool: Tool = {
  name: "send_private_message",
  description:
    "私聊某个认识的人。person_name 经 known_users 反查 open_id；或直接传 open_id。" +
    "只能私聊当前频道所属飞书应用/租户里的人；别的租户的人不在名单里。" +
    "用于：传话 / 告警 / 主动联系。content 是纯文本（飞书 text 消息）。",
  inputSchema: {
    type: "object",
    properties: {
      person_name: {
        type: "string",
        description: "对方姓名/昵称（known_users 反查；与 open_id 二选一）",
      },
      open_id: {
        type: "string",
        description: "对方 open_id（如 ou_xxx；与 person_name 二选一）",
      },
      content: { type: "string", description: "私聊内容（飞书 text 消息）" },
    },
    required: ["content"],
  },
};

export async function handleSendPrivateMessage(args: {
  person_name?: string;
  open_id?: string;
  content: string;
}) {
  const { person_name, open_id, content } = args;
  const targetOpenId = resolveTargetOpenId({ person_name, open_id });
  if (!targetOpenId) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `找不到目标——单聊询问Owner。`,
        },
      ],
    };
  }
  try {
    // 主动单聊后即时挂该单聊频道监听 + 写日志——飞书不回推 bot 自己发的消息，
    // 不主动挂的话该单聊要等对方先回才会被监听到。p2p chat_id 对同一对(bot,user)固定。
    const { messageId, dmChatId } = await sendDirectMessage(targetOpenId, "text", content, content);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ delivered: true, message_id: messageId, chat_id: dmChatId }) },
      ],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logBackground("send-private", `to=${targetOpenId} FAILED: ${msg}`);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `私聊失败：${msg}` }],
    };
  }
}
