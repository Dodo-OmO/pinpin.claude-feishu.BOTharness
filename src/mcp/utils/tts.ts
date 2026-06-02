// TTS（ElevenLabs Multilingual v3）—— 文本转 OGG Opus 文件
// 整体搬自 早期版本 src/utils/tts.ts（去掉 早期版本的 config 依赖，env 直读）
//
// - voice ID 由Owner通过 Voice Design 创建（元气少女声线，2026-04-27）
// - 输出 OGG Opus 直通飞书 audio 消息（飞书 SDK file_type=opus 实证接受，早期版本生产已验证）
// - 文件落到 BASE_PROJECT_DIR\主动生成物\语音\YYYY-MM\HHMMSS.ogg
// - duration 用 music-metadata 读 OGG 头；读失败估算

import { Readable } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFile } from "music-metadata";
import { pad2 } from "./helper.js";
import { getElevenLabsClient } from "./elevenlabs-client.js";

// Owner Voice Design 创建的元气少女声线。换声线改这里一行
const VOICE_ID = "g2XLoU7kwKhRwQfP10q5";
// Voice Design 创建的声音是用 v3 模型生成的——必须用 eleven_v3 调用，否则音色完全变形（外星人感）
const MODEL_ID = "eleven_v3";
// OGG-wrapped Opus，48kHz 128kbps——音质够好（接近 mp3 192kbps），文件仍小
const OUTPUT_FORMAT = "opus_48000_128";

// v3.2.1: 中文 TTS 符号预处理——v3 模型对部分中文+符号组合发音不准（"10%" → "颇"）
// 在送进 API 前把常见符号转中文，不依赖模型理解
// 同时：voice message 不能带 mention/content，把圈人语法 <at user_id="..."></at> 删掉避免被念
function preprocessChineseTts(text: string): string {
  return text
    .replace(/<at\s+user_id="[^"]*">[^<]*<\/at>\s*/g, "")  // 飞书圈人语法
    .replace(/<@!?\d+>\s*/g, "")                            // 旧版圈人语法兜底
    .replace(/(\d+(?:\.\d+)?)%/g, "百分之$1")
    .replace(/℃/g, "摄氏度")
    .replace(/℉/g, "华氏度")
    .replace(/¥/g, "人民币")
    .replace(/\$(\d)/g, "美元$1")
    .replace(/&/g, "和")
    .replace(/@/g, "艾特")
    .trim();
}

export interface TtsResult {
  filePath: string;
  durationSecs: number;
  buffer: Buffer; // 直接给飞书 uploadFile 用
}

/**
 * 文本 → OGG Opus 文件，返回路径 + duration + buffer
 * 失败抛异常由上层 fallback 到普通文字回复
 */
export async function synthesizeVoice(text: string): Promise<TtsResult> {
  const baseProjectDir = process.env.BASE_PROJECT_DIR ?? "/path/to/obsidian-vault";
  const client = getElevenLabsClient();
  const processedText = preprocessChineseTts(text);
  if (!processedText) {
    throw new Error("synthesizeVoice 输入文本预处理后为空");
  }
  const stream = await client.textToSpeech.convert(VOICE_ID, {
    text: processedText,
    modelId: MODEL_ID,
    outputFormat: OUTPUT_FORMAT,
    voiceSettings: { speed: 1.2 } as any,
    applyTextNormalization: "on" as any,
  });

  // ReadableStream<Uint8Array> → Buffer
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.fromWeb(stream as any)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  const buffer = Buffer.concat(chunks);

  // 写盘到 主动生成物\语音\YYYY-MM\HHMMSS.ogg
  const now = new Date();
  const yyyymm = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  const hhmmss = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const outputDir = path.join(baseProjectDir, "主动生成物", "语音", yyyymm);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const filePath = path.join(outputDir, `${hhmmss}.ogg`);
  fs.writeFileSync(filePath, buffer);

  // duration 用 music-metadata 读 OGG 头
  let durationSecs = 0;
  try {
    const meta = await parseFile(filePath);
    durationSecs = meta.format.duration ?? 0;
  } catch (e) {
    process.stderr.write(
      `[tts] 读取 duration 失败，按字符数估算: ${e instanceof Error ? e.message : e}\n`,
    );
    durationSecs = Math.max(1, text.length * 0.2);
  }

  return { filePath, durationSecs, buffer };
}
