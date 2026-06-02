// reply tool handler——仅 handleReply 兜底用，不暴露 MCP tool
// ListTools 不注册 reply；若 base 因缓存误调，server.ts 的 case 'reply' 走原 handler 静默执行不破回话。
// 正常出口：pinpin_reply_text / pinpin_reply_voice / pinpin_react

import { sendText, replyText, splitMessage } from "./feishu-send.js";

interface ReplyArgs {
  chat_id: string;
  text: string;
  reply_to_message_id?: string;
}

export async function handleReply(
  args: ReplyArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { chat_id, text, reply_to_message_id } = args;

  if (!chat_id || !text) {
    return {
      isError: true,
      content: [{ type: "text", text: "缺少必填参数 chat_id 或 text" }],
    };
  }

  const chunks = splitMessage(text);
  const sentIds: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const id =
        i === 0 && reply_to_message_id
          ? await replyText(reply_to_message_id, chunks[i])
          : await sendText(chat_id, chunks[i]);
      sentIds.push(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[reply] sendText 失败 chunk ${i}: ${msg}\n`);
      return {
        isError: true,
        content: [{ type: "text", text: `飞书发送失败(chunk ${i}): ${msg}` }],
      };
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ delivered: true, message_ids: sentIds }),
      },
    ],
  };
}
