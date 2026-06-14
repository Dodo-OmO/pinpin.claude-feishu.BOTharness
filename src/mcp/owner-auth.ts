// OWNER 鉴权共享函数——restart_self / sleep_self / compact_chat / disband_group 等
// 危险操作复用。
//
// 鉴权逻辑：
//   1. 单聊直通：当前频道 = PINPIN_OWNER_CHAT_ID（Owner单聊），直接放行。
//      Owner单聊里只有Owner能发言，无需 inbound-sender 比对。
//   2. 群聊维持最后-inbound 启发式：取 chat-activity 缓存"自家 chat 近 5min 最后一条 inbound sender"。
//      已知局限：群友插话竞态可能误拒Owner——安全>便利，有意保留（fail-closed）。

import { getLastInboundSenderOpenId } from "./chat-activity.js";

export function checkOwner(): { ok: boolean; reason?: string } {
  const ownChatId = process.env.PINPIN_CHAT_ID;
  const ownerOpenId = process.env.FEISHU_OWNER_OPEN_ID;
  if (!ownChatId || !ownerOpenId) {
    return { ok: false, reason: "未配置 PINPIN_CHAT_ID 或 FEISHU_OWNER_OPEN_ID，OWNER 鉴权失败" };
  }

  // 单聊直通：Owner单聊频道里只有Owner能发言，无需 sender 比对
  if (ownChatId === process.env.PINPIN_OWNER_CHAT_ID) {
    return { ok: true };
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
