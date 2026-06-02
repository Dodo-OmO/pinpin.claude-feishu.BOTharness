// 语音工具——纯函数集合（字符计数 + 语音去重）
// 原 zzzpin-parser.ts 拆分而来：zzzpin/mempin/emotion 解析随 pinpin-output tool 一起废弃删除，
// 仅保留 send-voice 仍在用的语音相关工具，改名 voice-utils.ts。
// 不依赖 SDK / MCP——纯字符串处理。

// ── 语言字符计数 ──
// 只数中文/英文字母/数字，标点和 emoji 不算——给语音 120 字硬卡用
export const VOICE_TEXT_LIMIT = 120;
export function countLanguageChars(s: string): number {
  return (s.match(/[一-鿿㐀-䶿a-zA-Z0-9]/g) ?? []).length;
}

// ── 语音去重（5 秒内同 chatId+text 哈希视为重复）──
const recentVoiceSent = new Map<string, number>();
const VOICE_DEDUP_WINDOW_MS = 5000;
function voiceKey(chatId: string, text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return `${chatId}:${hash}`;
}
export function markVoiceSent(chatId: string, text: string): void {
  const key = voiceKey(chatId, text);
  const now = Date.now();
  recentVoiceSent.set(key, now);
  // 顺便清理过期 key
  for (const [k, t] of recentVoiceSent) {
    if (now - t > VOICE_DEDUP_WINDOW_MS) recentVoiceSent.delete(k);
  }
}
export function isRecentVoiceSent(chatId: string, text: string): boolean {
  const key = voiceKey(chatId, text);
  const t = recentVoiceSent.get(key);
  if (!t) return false;
  return Date.now() - t < VOICE_DEDUP_WINDOW_MS;
}
