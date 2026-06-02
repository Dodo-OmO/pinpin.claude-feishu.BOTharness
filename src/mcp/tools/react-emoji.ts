// 阶段 2-B：react 模式 emoji reaction 发送
// 三级兜底（搬早期版本 chat.ts:55-89 同款三级链）：
//   1. resolveEmojiType（大小写规范化 + 去标点 + 别名表）→ 命中 → addReaction
//   2. 兜底：unicode emoji → mapEmojiToFeishu → addReaction
//   3. 终极：都不认识 → reply 短文本（用户必看到反应——bot 错误自动引导硬规则）
//
// 任一环节 addReaction 失败 → 自动降下一级，保证 react 永远有出口

import { resolveEmojiType, mapEmojiToFeishu } from "../utils/feishu-emoji-map.js";
import { addReaction, replyText, sendText } from "./feishu-send.js";

export interface ReactEmojiResult {
  delivered: boolean;
  mode: "reaction" | "fallback-text";
  emoji_type?: string;     // mode=reaction 时填规范名
  message_id?: string;     // mode=fallback-text 时填回复消息 id
  reason?: string;
}

/**
 * 发 emoji reaction（带三级兜底）
 * - chatId：群 id（fallback 短文本时用）
 * - rawReactInput：品品 [reactpin] 段后面写的字符串（emoji_type 名 / unicode emoji / 不认识的字）
 * - replyToMessageId：要 react 的目标消息 id（必须，react 是针对某条消息）
 */
export async function sendReactEmoji(
  chatId: string,
  rawReactInput: string,
  replyToMessageId: string,
): Promise<ReactEmojiResult> {
  const input = rawReactInput.trim();
  if (!input) {
    return { delivered: false, mode: "fallback-text", reason: "react 内容为空" };
  }
  if (!replyToMessageId) {
    // react 必须有目标消息——没有就走文字回复（飞书 react API 要 message_id）
    process.stderr.write(
      `[react-emoji] 缺 replyToMessageId，降级发短文本: ${input}\n`,
    );
    try {
      const id = await sendText(chatId, input);
      return { delivered: true, mode: "fallback-text", message_id: id, reason: "无 message_id 走短文本" };
    } catch (e) {
      return { delivered: false, mode: "fallback-text", reason: `短文本兜底也失败: ${e instanceof Error ? e.message : e}` };
    }
  }

  // 1 级：emoji_type 规范名
  const canonical = resolveEmojiType(input);
  if (canonical) {
    try {
      await addReaction(replyToMessageId, canonical);
      process.stderr.write(`[react-emoji] 1 级 OK: addReaction(${canonical})\n`);
      return { delivered: true, mode: "reaction", emoji_type: canonical };
    } catch (e) {
      process.stderr.write(
        `[react-emoji] 1 级失败降级: addReaction(${canonical}) ${e instanceof Error ? e.message : e}\n`,
      );
    }
  }

  // 2 级：unicode emoji → 飞书 emoji_type
  const mapped = mapEmojiToFeishu(input);
  if (mapped) {
    try {
      await addReaction(replyToMessageId, mapped);
      process.stderr.write(`[react-emoji] 2 级 OK: addReaction(${mapped})（unicode 兜底）\n`);
      return { delivered: true, mode: "reaction", emoji_type: mapped };
    } catch (e) {
      process.stderr.write(
        `[react-emoji] 2 级失败降级短文本: addReaction(${mapped}) ${e instanceof Error ? e.message : e}\n`,
      );
    }
  }

  // 3 级：终极兜底——发短文本（用户必看到反应）
  process.stderr.write(`[react-emoji] 3 级兜底: 短文本回复 "${input}"\n`);
  try {
    const id = await replyText(replyToMessageId, input);
    return { delivered: true, mode: "fallback-text", message_id: id, reason: "都不认识，短文本兜底" };
  } catch (e) {
    return { delivered: false, mode: "fallback-text", reason: `短文本兜底也失败: ${e instanceof Error ? e.message : e}` };
  }
}
