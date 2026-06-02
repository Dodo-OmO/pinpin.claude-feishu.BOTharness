// ElevenLabs 共用 client 工厂
// TTS 和 STT 统一从这里取 client。

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

let _client: ElevenLabsClient | null = null;

export function getElevenLabsClient(): ElevenLabsClient {
  if (_client) return _client;
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error(
      "ELEVENLABS_API_KEY 未配置——品品 .env 缺这个 key，ElevenLabs 功能不可用",
    );
  }
  _client = new ElevenLabsClient({ apiKey: key });
  return _client;
}