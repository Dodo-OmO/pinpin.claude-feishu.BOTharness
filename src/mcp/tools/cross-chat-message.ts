// cross_chat_message tool handler——跨 chat 主动发言专用入口（2026-05-28 多 CLI 落地）
//
// 跟 pinpin_reply_text 的本质区别：
//   - reply_text 走 chat_id 错位检查（5min TTL）—— 防止误把 A 频道内容回到 B 频道
//   - cross_chat_message **跳过该检查**——这是品品**有意识跨频道发言**的唯一合法入口
//
// 使用语义（写进 description 引导品品）：
//   - 仅在确实需要跨频道发言的场景调用（如 free-activity 在茶水间触发后想去其它白名单群分享，
//     或主对话在Owner单聊里得到指示后去其它群转达）
//   - 目标 chat_id 必须是品品**确知**的频道，不能随便编造
//   - 默认情况下，普通的"回复刚才那条消息"用 pinpin_reply_text，不是本 tool
//
// 实现：直接 sendText 到目标 chat；调用方负责确认 chat_id 合法。

import { sendText, splitMessage } from "./feishu-send.js";
import { appendBotReply } from "../utils/chat-log.js";

export const CROSS_CHAT_MESSAGE_TOOL = {
  name: "cross_chat_message",
  description:
    "**跨频道主动发言**专用入口（跳过 chat_id 错位检查）。仅在你有意识跨频道发言时调用——如自由活动在茶水间触发后想去别处分享、" +
    "或Owner指示你去某群转告事情。普通回复消息一律用 pinpin_reply_text。" +
    "目标 chat_id 必须是你**确知**的频道；调本 tool 前请确认。",
  inputSchema: {
    type: "object" as const,
    properties: {
      chat_id: {
        type: "string" as const,
        description: "目标频道 chat_id（开头 oc_）。可从历史对话日志 / 永存记忆 / instructions 列出的频道获取，禁止编造",
      },
      text: {
        type: "string" as const,
        description: "纯文本内容。支持飞书富文本：<at user_id=\"ou_xxx\"></at> 圈人 / <b></b> 加粗 / 换行 / emoji",
      },
      reason: {
        type: "string" as const,
        description: "（可选）简述为什么需要跨频道发言——日志用，帮Owner事后审查滥用",
      },
    },
    required: ["chat_id", "text"],
  },
};

interface CrossChatMessageArgs {
  chat_id: string;
  text: string;
  reason?: string;
}

export async function handleCrossChatMessage(
  args: CrossChatMessageArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { chat_id, text, reason } = args;

  if (!chat_id || !text) {
    return {
      isError: true,
      content: [{ type: "text", text: "缺少必填参数 chat_id 或 text" }],
    };
  }

  // 与自家 chat_id 相同 → 用 pinpin_reply_text，不该走 cross_chat_message
  const ownChatId = process.env.PINPIN_CHAT_ID;
  if (ownChatId && chat_id === ownChatId) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `cross_chat_message 用错了：目标 chat_id 等于你自己的 chat_id。回当前频道请用 pinpin_reply_text。`,
      }],
    };
  }

  const chunks = splitMessage(text);
  const sentIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const id = await sendText(chat_id, chunks[i]);
      sentIds.push(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `[cross_chat_message] 发送失败 chat=${chat_id.slice(-8)} chunk ${i}: ${msg}\n`,
      );
      return {
        isError: true,
        content: [{
          type: "text",
          text: JSON.stringify({ delivered: false, error: `飞书发送失败(chunk ${i}): ${msg}` }),
        }],
      };
    }
  }

  process.stderr.write(
    `[cross_chat_message] 发送 OK from=${ownChatId?.slice(-8) ?? "?"} to=${chat_id.slice(-8)} chunks=${chunks.length}${reason ? ` reason="${reason}"` : ""}\n`,
  );

  // 写对话日志（目标 chat）方便事后追溯
  appendBotReply(chat_id, text);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ delivered: true, message_ids: sentIds, target_chat_id: chat_id }),
    }],
  };
}
