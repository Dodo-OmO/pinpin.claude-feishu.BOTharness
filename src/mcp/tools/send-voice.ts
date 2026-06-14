// 语音发送
// 流程：text → emotion 拼前缀 → 长度检查 → 去重检查 → TTS 合成 → upload opus → sendAudio
// 任一环节失败 → 抛异常给 pinpin_reply_voice handler 自动降级文字

import {
  countLanguageChars,
  VOICE_TEXT_LIMIT,
  markVoiceSent,
  isRecentVoiceSent,
} from "./voice-utils.js";
import { synthesizeVoice } from "../utils/tts.js";
import { uploadOpus, sendAudio } from "./feishu-send.js";

export interface SendVoiceResult {
  delivered: boolean;
  message_id?: string;
  reason?: string; // 跳过/降级时填明原因
}

/**
 * 发语音消息
 * - cleanText：品品口语正文（pinpin_reply_voice 的 text 参数）
 * - emotion：pinpin_reply_voice 的 emotion 参数（7 种之一）；null = 不拼前缀
 * - chatId：目标群
 * - replyToMessageId：可选引用回复
 *
 * 返回：
 *   { delivered: true, message_id } 发送成功
 *   { delivered: false, reason: "duplicate" } 5 秒去重命中跳过
 *   { delivered: false, reason: "too-long" } 超 120 字 = 调用方自己 fallback 文字
 *   抛异常 = TTS / upload / send 任一环节失败，调用方自己 fallback 文字
 */
export async function sendVoice(
  chatId: string,
  cleanText: string,
  emotion: string | null,
  replyToMessageId?: string,
): Promise<SendVoiceResult> {
  // 1. 长度卡——超过 120 字的让上层走文字（vy 设计就是短句口语，超长是品品自己没遵守协议）
  const langChars = countLanguageChars(cleanText);
  if (langChars > VOICE_TEXT_LIMIT) {
    process.stderr.write(
      `[send-voice] 超长 ${langChars}>${VOICE_TEXT_LIMIT} 字，降级文字: ${cleanText.slice(0, 30)}...\n`,
    );
    return { delivered: false, reason: "too-long" };
  }

  // 2. 幂等去重——5 秒内同 chatId+text 哈希视为重复（防上层多次触发导致重发）
  if (isRecentVoiceSent(chatId, cleanText)) {
    process.stderr.write(`[send-voice] 5 秒内重复，跳过: ${cleanText.slice(0, 30)}...\n`);
    return { delivered: false, reason: "duplicate" };
  }

  // 3. emotion 作为情绪提示拼在文本前（裸前缀 [excited] 等，非 ElevenLabs v3 audio tag 映射）
  const ttsPrompt = emotion ? `[${emotion}] ${cleanText}` : cleanText;
  if (emotion) {
    process.stderr.write(`[send-voice] emotion=${emotion} 拼入 TTS 前缀\n`);
  }

  // 4. TTS 合成（OGG Opus）
  const { fileName, durationSecs, buffer } = await synthesizeVoice(ttsPrompt);
  process.stderr.write(
    `[send-voice] TTS 合成 OK: ${fileName} (${durationSecs.toFixed(1)}s)\n`,
  );

  // 5. 上传 opus 到飞书拿 file_key（飞书 duration 字段单位 ms）
  const durationMs = Math.max(1, Math.round(durationSecs * 1000));
  const fileKey = await uploadOpus(buffer, fileName, durationMs);

  // 6. 发 audio 消息
  const messageId = await sendAudio(chatId, fileKey, replyToMessageId);

  // 7. 标记已发送（去重表写入）—— 成功后才标，避免 TTS 失败导致同文本永远卡 5 秒不能重试
  markVoiceSent(chatId, cleanText);

  process.stderr.write(`[send-voice] 飞书 audio 发送 OK message_id=${messageId}\n`);
  return { delivered: true, message_id: messageId };
}
