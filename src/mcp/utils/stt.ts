// STT（ElevenLabs Scribe v2）—— 音频文件转文字
// client 统一从 elevenlabs-client.ts 取

import { getElevenLabsClient } from "./elevenlabs-client.js";

/**
 * 把音频 Buffer 转成文字。
 * @param audioBuffer 音频数据（飞书音频下载为 OGG Opus）
 * @param filename    文件名（含扩展名，帮助 API 推断格式），默认 "audio.ogg"
 * @returns 转写结果文字；失败抛异常
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename = "audio.ogg",
): Promise<string> {
  const client = getElevenLabsClient();
  const result = await client.speechToText.convert({
    modelId: "scribe_v2",
    file: { data: audioBuffer, filename, contentType: "audio/ogg" },
    languageCode: "zh",
  });
  return result.text ?? "";
}
