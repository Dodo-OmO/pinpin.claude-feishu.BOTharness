// cross_chat_message tool——给另一个频道的品品捎话（不替那边发言）。
//
// 每个频道的品品各有各的上下文和分寸：A 频道要把话带到 B，不是用 B 的嘴直接说，而是把前因后果推给
// B 频道的 CLI（supervisor 推 trigger=peer-message），由 B 频道的品品自己判断怎么说、要不要说。
// 走 IPC PEER_MESSAGE：supervisor 按 chat_id 找目标频道（离线则先拉起），两个飞书应用的频道都可互捎。

import { getSupervisorClient } from "../../ipc/client-singleton.js";
import { IPC_METHODS, type PeerMessageResult } from "../../ipc/protocol.js";
import { logBackground } from "../utils/background-log.js";

export const CROSS_CHAT_MESSAGE_TOOL = {
  name: "cross_chat_message",
  description:
    "**给另一个频道的你捎话**——你不替那边发言，那边的你读到后按那边的关系和语气自己决定说不说、怎么说。" +
    "用于：有人叫你去 X 群说 Y、豆姐让你转告某群、或事情确实跟别的频道有关。普通回复一律用 pinpin_reply_text。" +
    "text 写前因后果 + 请那边做什么（谁让说的、说给谁、为什么、原话或要点）。" +
    "目标 chat_id 用 list_active_chats 查（两个飞书应用的群都列、带所属标签），禁止编造。" +
    "调完只说「已经跟那边的我说了」，别替她承诺已发。",
  inputSchema: {
    type: "object" as const,
    properties: {
      chat_id: {
        type: "string" as const,
        description: "目标频道 chat_id（开头 oc_），来自 list_active_chats / 对话记录 / 永存记忆，禁止编造",
      },
      text: {
        type: "string" as const,
        description: "捎的话：前因后果 + 请那边的你做什么。写给'另一个你'看的，不是最终要发到群里的原文",
      },
      reason: {
        type: "string" as const,
        description: "（可选）一句话为什么要捎——日志用",
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
    return { isError: true, content: [{ type: "text", text: "缺少必填参数 chat_id 或 text" }] };
  }
  const ownChatId = process.env.PINPIN_CHAT_ID;
  if (ownChatId && chat_id === ownChatId) {
    return {
      isError: true,
      content: [{ type: "text", text: "目标就是当前频道——回本频道请用 pinpin_reply_text。" }],
    };
  }
  let r: PeerMessageResult;
  try {
    r = await getSupervisorClient().request<PeerMessageResult>(IPC_METHODS.PEER_MESSAGE, { chat_id, text });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ delivered: false, error: `捎话失败: ${msg}` }) }] };
  }
  if (!r.ok) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ delivered: false, error: r.error ?? "unknown" }) }] };
  }
  logBackground("peer-message", `→ ${r.chat_name ?? chat_id.slice(-8)}${reason ? ` reason="${reason}"` : ""} len=${text.length}`);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ delivered: true, to: r.chat_name ?? chat_id, note: "已捎给那边的你，由她决定怎么说" }),
    }],
  };
}
