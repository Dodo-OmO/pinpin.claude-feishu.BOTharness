// notify_when_speaks tool（MCP 版）
// 阶段 4 批次 3 步骤 3.3：协议 #41 v8.4 ④B speak_watch
// 注册"等某人在群里发言后提醒"——非时间驱动，靠 chat-message.ts 入站时命中
// 命中处理已在 chat-message.ts 实现（listPendingSpeakWatchByOpenId + 推 speak-watch trigger + markJobFired）

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { addSpeakWatchJob, resolveOpenId } from "../db/database.js";

export const notifyWhenSpeaksTool: Tool = {
  name: "notify_when_speaks",
  description:
    "等某人在**本频道**下次发言时提醒你。target_name（known_users 反查 open_id）或 target_open_id 二选一。" +
    "message = fire 时要传达的内容（品品按风格说出）。",
  inputSchema: {
    type: "object",
    properties: {
      target_name: { type: "string", description: "目标姓名（known_users 反查；与 target_open_id 二选一）" },
      target_open_id: { type: "string", description: "目标 open_id" },
      message: { type: "string", description: "fire 时要带的提醒内容" },
    },
    required: ["message"],
  },
};

export async function handleNotifyWhenSpeaks(args: {
  target_name?: string;
  target_open_id?: string;
  message: string;
}) {
  const { target_name, target_open_id, message } = args;
  // 固定监听本频道（多 CLI 架构：一聊一进程，chat 身份来自 supervisor 注入）
  const chat_id = process.env.PINPIN_CHAT_ID;
  if (!chat_id) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: "本进程无 PINPIN_CHAT_ID，无法注册 speak-watch" }) }],
    };
  }
  let openId = target_open_id;
  if (!openId && target_name) openId = resolveOpenId(target_name);
  if (!openId) {
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
  const jobId = addSpeakWatchJob({
    chatId: chat_id,
    targetOpenId: openId,
    targetName: target_name ?? openId,
    message,
  });
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ scheduled: true, job_id: jobId, target_open_id: openId }) },
    ],
  };
}
