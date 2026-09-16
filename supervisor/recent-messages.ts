/**
 * 最近消息内存缓存（启动器进程内）——供"别人撤回"事件兜底找原文用。
 * im.message.recalled_v1 只带 message_id，飞书不再给原文；靠这份缓存回填 chat/发送者/预览。
 * 上限 500 条，超出淘汰最早的一条；进程重启即清空（不落盘，纯内存兜底）。
 */

export interface RecentMessageInfo {
  chat_id: string;
  sender: string;
  preview: string;
}

const MAX_ENTRIES = 500;
const PREVIEW_MAX = 80;

const cache = new Map<string, RecentMessageInfo>();

export function rememberMessage(id: string, info: RecentMessageInfo): void {
  if (!id) return;
  if (cache.has(id)) cache.delete(id); // 重新插入刷到最新位，Map 迭代顺序即淘汰顺位
  cache.set(id, { ...info, preview: info.preview.slice(0, PREVIEW_MAX) });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function lookupMessage(id: string): RecentMessageInfo | undefined {
  return cache.get(id);
}
