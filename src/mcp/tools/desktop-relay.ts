// 传话口（本机 Claude 窗口 ⇄ 品品）的品品侧两工具。supervisor 侧见 supervisor/relay-bridge.ts。

import { getSupervisorClient } from "../../ipc/client-singleton.js";
import {
  IPC_METHODS,
  type RelayAckParams,
  type RelayLetterCreateResult,
  type WorkOkResult,
} from "../../ipc/protocol.js";
import { checkOwner } from "../owner-auth.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

export const DESKTOP_NOTE_ACK_TOOL = {
  name: "desktop_note_ack",
  description: "办完本机 Claude 窗口递的条子（trigger=desktop-note / desktop-reply）后回执；对方回话后可再调一次带 reply。",
  inputSchema: {
    type: "object" as const,
    properties: {
      note_id: { type: "string" as const, description: "条子编号（trigger 的 note_id）" },
      status: { type: "string" as const, enum: ["sent", "deferred", "skipped", "failed"] },
      sent_text: { type: "string" as const, description: "实际发出的原文（sent 时必填）" },
      reason: { type: "string" as const, description: "推迟 / 不发 / 失败的原因" },
      reply: { type: "string" as const, description: "对方回话要点（二次回执用）" },
    },
    required: ["note_id", "status"],
  },
};

export async function handleDesktopNoteAck(args: RelayAckParams): Promise<ToolResult> {
  if (args.status === "sent" && !args.sent_text) return text("status=sent 时要填 sent_text（实际发出的原文）", true);
  try {
    const r = await getSupervisorClient().request<WorkOkResult>(IPC_METHODS.RELAY_ACK, args);
    return r.ok ? text("回执已送达") : text(`回执失败: ${r.error}`, true);
  } catch (e) {
    return text(`回执失败: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

export const DESKTOP_SESSION_MESSAGE_TOOL = {
  name: "desktop_session_message",
  description: "仅Owner可用：替她给本机某个 Claude 窗口（Desktop session）带话，由那边常驻传话员按标题转交；回话会以 trigger=desktop-reply 回到本频道。",
  inputSchema: {
    type: "object" as const,
    properties: {
      target: { type: "string" as const, description: "窗口标题或关键词（如「Client工作站」）" },
      content: { type: "string" as const, description: "要带的话（Owner的原意 + 要它做什么）" },
      need_reply: { type: "boolean" as const, description: "要不要它回话" },
    },
    required: ["target", "content", "need_reply"],
  },
};

export async function handleDesktopSessionMessage(args: { target: string; content: string; need_reply: boolean }): Promise<ToolResult> {
  const auth = checkOwner();
  if (!auth.ok) return text(auth.reason ?? "只有Owner能让我去找本机 Claude 窗口", true);
  try {
    const r = await getSupervisorClient().request<RelayLetterCreateResult>(IPC_METHODS.RELAY_LETTER_CREATE, args);
    if (!r.ok) return text(`没带出去: ${r.error}`, true);
    return text(JSON.stringify({
      letter_id: r.id,
      relay_online: r.relay_online,
      note: r.relay_online ? "已交给传话员" : "传话员现在不在线，信已存着，上线就送；2 小时没人取会再告诉你",
    }));
  } catch (e) {
    return text(`没带出去: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}
