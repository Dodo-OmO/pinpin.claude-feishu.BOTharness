// chat inbound 追踪——为 OWNER 鉴权提供"某 chat 近 5 分钟最后一条 inbound 的发送者"。
//
// 设计：进程内 Map<chat_id, 最近 inbound 时间戳> + Map<chat_id, senderOpenId>，TTL 5 分钟。
// chat-message.ts 每次推 inbound notification 前调 markInboundChat()；时间戳 map 只用于
// 维持 5 分钟 TTL 清理（保证 getLastInboundSenderOpenId 返回的是近 5 分钟内的发送者）。
//
// 出站 tool 不再做 chat_id 活跃检查——品品可发任意确知频道（跨频道发言走 cross_chat_message）。

const RECENT_INBOUND_TTL_MS = 5 * 60 * 1000; // 5 分钟
const recentInbound = new Map<string, number>();
const recentInboundSender = new Map<string, string>(); // chat_id → senderOpenId（OWNER 鉴权用）

/** 飞书消息入站时记一次——供后续 chat_id 错位检查 + OWNER 鉴权参照 */
export function markInboundChat(chatId: string, senderOpenId?: string): void {
  recentInbound.set(chatId, Date.now());
  if (senderOpenId) recentInboundSender.set(chatId, senderOpenId);
  // 顺便清理过期项，防无界增长（30 群护栏 + 5 分钟 TTL，最多 30 条）
  const now = Date.now();
  for (const [id, ts] of recentInbound) {
    if (now - ts > RECENT_INBOUND_TTL_MS) {
      recentInbound.delete(id);
      recentInboundSender.delete(id);
    }
  }
}

/** 取某 chat 最近 inbound 发送者 open_id（OWNER 鉴权用，未记录返 undefined） */
export function getLastInboundSenderOpenId(chatId: string): string | undefined {
  return recentInboundSender.get(chatId);
}

