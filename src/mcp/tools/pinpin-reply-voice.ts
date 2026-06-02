// pinpin_reply_voice tool handler——阶段 3 批 2 语音回复语义化 tool
// 取代 早期版本的 zzzpin 语音 + [huifula-pin] + {emotion:xxx} 字符串协议
//
// 入参：chat_id / text（≤120字短句口语）/ emotion（可选 enum 7 种）/ reply_to_message_id（可选）
// 行为：sendVoice（TTS → upload opus → sendAudio）
// 失败：自动降级文字（TTS/upload/超长/去重任一不过 → sendText 兜底）

import { sendVoice } from "./send-voice.js";
import { sendText, splitMessage } from "./feishu-send.js";
import { appendBotReply } from "../utils/chat-log.js";
import { pushChannelTrigger, MOOD_APPRAISE_TRIGGER_BODY, MEMORY_REMIND_BODY } from "../utils/push-channel.js";

// 回完一轮（语音成功 / 降级文字都算回完）后推心境+记忆两段 trigger，与文字回复一致
function pushPostReplyTriggers(chatId: string): void {
  void pushChannelTrigger({ trigger: "mood-appraise", chat_id: chatId, body: MOOD_APPRAISE_TRIGGER_BODY });
  void pushChannelTrigger({ trigger: "memory-remind", chat_id: chatId, body: MEMORY_REMIND_BODY });
}

export const VOICE_EMOTIONS = ["excited", "sad", "sarcastic", "whisper", "angry", "laughing", "concerned"] as const;
type VoiceEmotion = typeof VOICE_EMOTIONS[number];

export const PINPIN_REPLY_VOICE_TOOL = {
  name: "pinpin_reply_voice",
  description:
    "语音回复（ElevenLabs TTS）。≤120 字短句口语风格。emotion 选 7 种之一，作为情绪提示拼在文本前（裸前缀 [emotion] text，非 ElevenLabs v3 audio tag 映射）。超长 / TTS 失败 / upload 失败自动降级文字发送。",
  inputSchema: {
    type: "object" as const,
    properties: {
      chat_id: {
        type: "string" as const,
        description: "目标群 chat_id",
      },
      text: {
        type: "string" as const,
        description: "纯口语正文（≤120 字，超长自动降级文字）。别加 markdown 别加圈人标签——口语就这么说",
      },
      emotion: {
        type: "string" as const,
        enum: [...VOICE_EMOTIONS],
        description: "可选情绪：excited(兴奋) / sad(难过) / sarcastic(讽刺) / whisper(耳语) / angry(生气) / laughing(笑声) / concerned(担心)。明确情绪才标，平淡不标。",
      },
      reply_to_message_id: {
        type: "string" as const,
        description: "传它 = 引用这条消息（同 pinpin_reply_text：只回单独一条消息时传）",
      },
    },
    required: ["chat_id", "text"],
  },
};

interface PinpinReplyVoiceArgs {
  chat_id: string;
  text: string;
  emotion?: VoiceEmotion;
  reply_to_message_id?: string;
}

export async function handlePinpinReplyVoice(
  args: PinpinReplyVoiceArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { chat_id, text, emotion, reply_to_message_id } = args;

  if (!chat_id || !text) {
    return {
      isError: true,
      content: [{ type: "text", text: "缺少必填参数 chat_id 或 text" }],
    };
  }

  // 走 sendVoice（含长度卡、5 秒去重、TTS、upload、sendAudio 全链路）
  try {
    const result = await sendVoice(chat_id, text, emotion ?? null, reply_to_message_id);
    if (result.delivered) {
      appendBotReply(chat_id, `[语音] ${text}`);
      pushPostReplyTriggers(chat_id);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            delivered: true,
            mode: "voice",
            message_id: result.message_id,
            ...(emotion ? { emotion } : {}),
          }),
        }],
      };
    }
    // delivered=false：too-long / duplicate → 降级文字
    process.stderr.write(`[pinpin_reply_voice] 语音跳过 (${result.reason})，降级文字发送\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[pinpin_reply_voice] TTS/upload/send 失败降级文字: ${msg}\n`);
  }

  // 降级文字路径
  const chunks = splitMessage(text);
  const sentIds: string[] = [];
  for (const chunk of chunks) {
    try {
      const id = await sendText(chat_id, chunk);
      sentIds.push(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [{
          type: "text",
          text: JSON.stringify({
            delivered: false,
            mode: "voice_degraded_to_text",
            error: `语音降级文字也失败: ${msg}`,
          }),
        }],
      };
    }
  }
  appendBotReply(chat_id, text);
  pushPostReplyTriggers(chat_id);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        delivered: true,
        mode: "voice_degraded_to_text",
        message_ids: sentIds,
      }),
    }],
  };
}
