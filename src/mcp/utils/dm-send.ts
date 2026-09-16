// 私聊发送共用工具（4.pre 抽取，B4/B5 复用）
// resolveTargetOpenId：person_name/open_id 二选一 → 反查 open_id
// sendDirectMessage：message.create(open_id) → IPC SPAWN_CHANNEL 即时挂频道监听（失败不阻断）→ appendBotReply 留痕

import { getFeishuClient } from "../tools/feishu-send.js";
import { resolveOpenId } from "../db/database.js";
import { logBackground } from "./background-log.js";
import { appendBotReply, setChatNameCache } from "./chat-log.js";
import { getSupervisorClient } from "../../ipc/client-singleton.js";
import { IPC_METHODS, type SpawnChannelResult } from "../../ipc/protocol.js";

/** person_name 经 known_users 反查 open_id；或直接传 open_id。都没给 / 反查不到 → undefined。 */
export function resolveTargetOpenId(args: { person_name?: string; open_id?: string }): string | undefined {
  const { person_name, open_id } = args;
  if (open_id) return open_id;
  if (person_name) return resolveOpenId(person_name);
  return undefined;
}

export interface SendDirectMessageResult {
  messageId: string;
  dmChatId?: string;
}

/**
 * 给某 open_id 发私聊消息（文字或卡片）。
 * - msgType='text'：content 是纯文本字符串
 * - msgType='interactive'：content 是卡片对象（buildXxxCard 的返回值）
 * - logText：appendBotReply 落对话记录用的可读摘要（文字消息传原文，卡片传形如 "[发了xx卡：标题]"）
 * message.create 本身失败 / 未收到 message_id → 抛错，由调用方按自己的错误文案 catch。
 * IPC 即时挂频道监听失败不阻断发送——私聊已经送达，只是没能立刻挂监听，落 stderr 便于排查。
 */
export async function sendDirectMessage(
  openId: string,
  msgType: "text" | "interactive",
  content: string | object,
  logText: string,
): Promise<SendDirectMessageResult> {
  const client = getFeishuClient();
  const res = await client.im.v1.message.create({
    params: { receive_id_type: "open_id" },
    data: {
      receive_id: openId,
      msg_type: msgType,
      content: msgType === "text" ? JSON.stringify({ text: content }) : JSON.stringify(content),
    },
  });
  const messageId = res.data?.message_id;
  if (!messageId) {
    throw new Error("私聊发出但未收到 message_id（飞书响应异常），无法确认送达");
  }
  const dmChatId = res.data?.chat_id;
  logBackground("dm-send", `to=${openId} msg=${messageId} chat=${dmChatId ?? "?"}`);
  if (dmChatId) {
    try {
      const ipcClient = getSupervisorClient();
      const spawned = await ipcClient.request<SpawnChannelResult>(IPC_METHODS.SPAWN_CHANNEL, { chat_id: dmChatId, is_p2p: true, peer_open_id: openId });
      // 以 supervisor 定的频道名写记录，免得落进裸 chat_id 目录或和那边频道分成两个目录
      if (spawned.chat_name) setChatNameCache(dmChatId, spawned.chat_name);
    } catch (e) {
      process.stderr.write(
        `[dm-send] 挂频道 IPC 失败（不阻断发送）: ${e instanceof Error ? e.message : e}\n`,
      );
    }
    appendBotReply(dmChatId, logText);
  }
  return { messageId, dmChatId };
}
