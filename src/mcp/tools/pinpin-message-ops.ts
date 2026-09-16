// 撤回 / 编辑 / 合并转发——三个「操作自己已发消息」的 MCP 工具
// 写法参照 pinpin-react.ts（导出 TOOL 常量 + handler，返回 {content, isError?}）
//
// SDK 签名核对（node_modules/@larksuiteoapi/node-sdk/types/index.d.ts）：
// - message.get({path:{message_id}}) → data.items[0]{msg_type, sender{id,sender_type}, chat_id, deleted}
// - message.delete({path:{message_id}})
// - message.update({path:{message_id}, data:{msg_type, content}})：编辑文本/富文本（patch 只管共享卡片，别用）
// - message.mergeForward({data:{receive_id, message_id_list}, params:{receive_id_type, uuid?}})
//   → data.message.message_id

import { getFeishuClient } from "./feishu-send.js";
import { logBackground } from "../utils/background-log.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const err = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });
/** SDK 遇 4xx 抛 axios 错，飞书真实原因在 response.data.msg */
const errMsg = (e: unknown): string => {
  const d = (e as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
  return d?.msg ? `${d.msg}（code=${d.code}）` : e instanceof Error ? e.message : String(e);
};
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

/** 核对目标消息是不是品品自己（本飞书应用）发的，顺带带出 msg_type / chat_id 给调用方复用 */
async function assertOwnMessage(
  message_id: string,
): Promise<{ ok: true; msg_type: string; chat_id: string } | { ok: false; error: string }> {
  try {
    const res = await getFeishuClient().im.v1.message.get({ path: { message_id } });
    if (res.code) return { ok: false, error: res.msg ?? `查消息失败（code=${res.code}）` };
    const item = res.data?.items?.[0];
    if (!item || item.deleted) return { ok: false, error: "消息不存在或已被撤回/删除" };
    const sender = item.sender;
    if (!sender || sender.sender_type !== "app" || sender.id !== process.env.FEISHU_APP_ID) {
      return { ok: false, error: "只能操作你自己发的消息" };
    }
    if (!item.msg_type || !item.chat_id) return { ok: false, error: "消息数据不完整，无法操作" };
    return { ok: true, msg_type: item.msg_type, chat_id: item.chat_id };
  } catch (e) {
    return { ok: false, error: `查消息失败：${errMsg(e)}` };
  }
}

// ── pinpin_recall_message ──

export const PINPIN_RECALL_MESSAGE_TOOL = {
  name: "pinpin_recall_message",
  description: "撤回你自己发的一条飞书消息（别人的消息会被拒绝）。",
  inputSchema: {
    type: "object" as const,
    properties: {
      message_id: { type: "string" as const, description: "要撤回的消息 ID（om_ 开头，必须是你自己发的）" },
    },
    required: ["message_id"],
  },
};

export async function handlePinpinRecallMessage(args: { message_id: string }): Promise<ToolResult> {
  const { message_id } = args;
  if (!message_id) return err("缺少必填参数 message_id");

  const check = await assertOwnMessage(message_id);
  if (!check.ok) {
    logBackground("message-ops", `recall 拒绝 id=${message_id} 原因=${check.error}`);
    return err(check.error);
  }

  try {
    const res = await getFeishuClient().im.v1.message.delete({ path: { message_id } });
    if (res.code) {
      logBackground("message-ops", `recall 失败 id=${message_id} 飞书报错=${res.msg}`);
      return err(res.msg ?? `撤回失败（code=${res.code}）`);
    }
    logBackground("message-ops", `recall 成功 id=${message_id}`);
    return ok(JSON.stringify({ recalled: true, message_id }));
  } catch (e) {
    const msg = errMsg(e);
    logBackground("message-ops", `recall 异常 id=${message_id} error=${msg}`);
    return err(`撤回失败：${msg}`);
  }
}

// ── pinpin_edit_message ──

export const PINPIN_EDIT_MESSAGE_TOOL = {
  name: "pinpin_edit_message",
  description: "把你自己发的一条文字消息改成 text（只限你发的纯文本消息，对方会看到\"已编辑\"）。",
  inputSchema: {
    type: "object" as const,
    properties: {
      message_id: { type: "string" as const, description: "要编辑的消息 ID（om_ 开头，必须是你自己发的纯文本消息）" },
      text: { type: "string" as const, description: "改成的新文本内容" },
    },
    required: ["message_id", "text"],
  },
};

export async function handlePinpinEditMessage(args: { message_id: string; text: string }): Promise<ToolResult> {
  const { message_id, text } = args;
  if (!message_id || !text) return err("缺少必填参数 message_id 或 text");

  const check = await assertOwnMessage(message_id);
  if (!check.ok) {
    logBackground("message-ops", `edit 拒绝 id=${message_id} 原因=${check.error}`);
    return err(check.error);
  }
  if (check.msg_type !== "text") {
    const reason = `只能编辑纯文本消息，这条是 ${check.msg_type}`;
    logBackground("message-ops", `edit 拒绝 id=${message_id} 原因=${reason}`);
    return err(reason);
  }

  try {
    const res = await getFeishuClient().im.v1.message.update({
      path: { message_id },
      data: { msg_type: "text", content: JSON.stringify({ text }) },
    });
    if (res.code) {
      logBackground("message-ops", `edit 失败 id=${message_id} 飞书报错=${res.msg}`);
      return err(res.msg ?? `编辑失败（code=${res.code}）`);
    }
    logBackground("message-ops", `edit 成功 id=${message_id}`);
    return ok(JSON.stringify({ edited: true, message_id }));
  } catch (e) {
    const msg = errMsg(e);
    logBackground("message-ops", `edit 异常 id=${message_id} error=${msg}`);
    return err(`编辑失败：${msg}`);
  }
}

// ── pinpin_merge_forward ──

export const PINPIN_MERGE_FORWARD_TOOL = {
  name: "pinpin_merge_forward",
  description: "把多条消息合并成一条\"聊天记录\"转发到 chat_id（效果同飞书原生合并转发）。",
  inputSchema: {
    type: "object" as const,
    properties: {
      chat_id: { type: "string" as const, description: "接收合并转发结果的会话 chat_id" },
      message_ids: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "同一会话里要合并转发的消息 id 列表，按时间顺序",
      },
    },
    required: ["chat_id", "message_ids"],
  },
};

export async function handlePinpinMergeForward(
  args: { chat_id: string; message_ids: string[] },
): Promise<ToolResult> {
  const { chat_id, message_ids } = args;
  if (!chat_id) return err("缺少必填参数 chat_id");
  if (!message_ids || message_ids.length === 0) return err("message_ids 不能为空");

  try {
    const res = await getFeishuClient().im.v1.message.mergeForward({
      data: { receive_id: chat_id, message_id_list: message_ids },
      params: { receive_id_type: "chat_id" },
    });
    if (res.code) {
      logBackground("message-ops", `merge_forward 失败 chat=${chat_id} 飞书报错=${res.msg}`);
      return err(res.msg ?? `合并转发失败（code=${res.code}）`);
    }
    const newId = res.data?.message?.message_id;
    logBackground(
      "message-ops",
      `merge_forward 成功 chat=${chat_id} 新id=${newId ?? "?"} 条数=${message_ids.length}`,
    );
    return ok(JSON.stringify({ merged: true, message_id: newId }));
  } catch (e) {
    const msg = errMsg(e);
    logBackground("message-ops", `merge_forward 异常 chat=${chat_id} error=${msg}`);
    return err(`合并转发失败：${msg}`);
  }
}
