// OWNER 鉴权共享函数——restart_self / sleep_self / compact_chat / disband_group 等
// 危险操作复用。逻辑：本 chat 最近 inbound sender 必须是Owner（fail-closed）。
//
// 注意时间窗口：取 chat-activity 缓存的"自家 chat 近 5min 最后一条 inbound sender"。
// 群聊场景下 5min 内若别人发过言会"误拒"Owner（最近 inbound sender 是别人），
// 此时该引导Owner改在Owner单聊触发——只放正确 sender，不放错误 sender（fail-closed 安全）。

import { getLastInboundSenderOpenId } from "./chat-activity.js";

export function checkOwner(): { ok: boolean; reason?: string } {
  const ownChatId = process.env.PINPIN_CHAT_ID;
  const ownerOpenId = process.env.FEISHU_OWNER_OPEN_ID;
  if (!ownChatId || !ownerOpenId) {
    return { ok: false, reason: "未配置 PINPIN_CHAT_ID 或 FEISHU_OWNER_OPEN_ID，OWNER 鉴权失败" };
  }
  const lastSender = getLastInboundSenderOpenId(ownChatId);
  if (!lastSender) {
    return { ok: false, reason: "本频道近 5 分钟无 inbound，无法识别调用者——OWNER 命令请在Owner单聊里直接触发" };
  }
  if (lastSender !== ownerOpenId) {
    return {
      ok: false,
      reason: "八好意思～OWNER命令只能Owner触发耶～（若你就是Owner却被拒：多半是群里近5分钟有别人发过言、鉴权比对到了错误发送者——换到Owner单聊里说一次就行）",
    };
  }
  return { ok: true };
}
