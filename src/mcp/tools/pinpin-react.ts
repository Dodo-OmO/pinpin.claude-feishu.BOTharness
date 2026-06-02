// pinpin_react tool handler——阶段 3 批 2 emoji 反应语义化 tool
// 取代 早期版本 zzzpin react + [reactpin] 字符串协议
//
// 入参：message_id（必填）/ emoji_type（必填，free string，schema 描述全 171 表）
// 行为：sendReactEmoji 三级兜底（emoji_type 规范名 → unicode emoji → 短文本）
// Bug 2 防护：拦 om_/msg_ 前缀输入（防 base 把 message_id 当 emoji_type 误填）
//
// 注：emoji_type 用 free string 而非严格 enum——常用精选作 description 常驻提示（省 token）、
//     冷门/精准表情品品查 react-emoji skill 全表；不强 enum 约束，server 三级兜底处理。

import { sendReactEmoji } from "./react-emoji.js";

// 常用精选 emoji_type（常驻 description；冷门/精准表情品品查 react-emoji skill 全表，全集单源在该 skill）
export const COMMON_EMOJI_HINT = "THUMBSUP / OK / THANKS / CLAP / MUSCLE / SHAKE / SMILE / LAUGH / LOL / LOVE / WINK / JOYFUL / WOW / SCOWL / SPEECHLESS / FACEPALM / DULL / ENOUGH / SOB / CRY / WRONGED / THINKING / SHOCKED / SWEAT / SICK / HUG / HEART / KISS / FIRE / PARTY / ROSE";

export const PINPIN_REACT_TOOL = {
  name: "pinpin_react",
  description:
    `emoji 反应。给某条消息加飞书 emoji 反应符号——比文字回复轻、比不回有存在感。emoji_type 见参数说明；server 三级兜底（emoji_type → unicode → 短文本）保证有出口。`,
  inputSchema: {
    type: "object" as const,
    properties: {
      message_id: {
        type: "string" as const,
        description: "要 react 的目标飞书消息 ID（必 om_ 开头的真消息 ID；绝不传 sys- 前缀的系统触发 ID）",
      },
      emoji_type: {
        type: "string" as const,
        description:
          `emoji_type 英文名（大小写不敏感，server 会规范化）。常用：${COMMON_EMOJI_HINT}。这些不够精准表达你的意图时，主动查 react-emoji skill 全表选更贴切的。`,
      },
      chat_id: {
        type: "string" as const,
        description:
          "目标 chat_id（兜底用：万一 emoji_type 全链路都不认识，server 会降级到 chat 发短文本，这时需要 chat_id）",
      },
    },
    required: ["message_id", "emoji_type", "chat_id"],
  },
};

interface PinpinReactArgs {
  message_id: string;
  emoji_type: string;
  chat_id: string;
}

export async function handlePinpinReact(
  args: PinpinReactArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { message_id, emoji_type, chat_id } = args;

  if (!message_id || !emoji_type || !chat_id) {
    return {
      isError: true,
      content: [{ type: "text", text: "缺少必填参数 message_id / emoji_type / chat_id" }],
    };
  }

  // Bug 2 防护：拦 base 把 message_id 当 emoji_type 误填（om_/msg_ 前缀绝不是 emoji_type）
  if (/^(om_|msg_)/i.test(emoji_type.trim())) {
    process.stderr.write(
      `[pinpin_react] emoji_type 填错：${emoji_type} 看起来是 message_id\n`,
    );
    return {
      isError: true,
      content: [{
        type: "text",
        text: `emoji_type 填错：${emoji_type} 看起来是 message_id 不是 emoji_type。emoji_type 应是英文名（如 LOL / FIRE / HEART / THUMBSUP）。请重试。`,
      }],
    };
  }

  // 走 sendReactEmoji 三级兜底
  const result = await sendReactEmoji(chat_id, emoji_type, message_id);

  if (!result.delivered) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          delivered: false,
          error: result.reason ?? "react 全链路失败",
        }),
      }],
    };
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        delivered: true,
        mode: result.mode === "reaction" ? "react" : "react_fallback_text",
        ...(result.emoji_type ? { emoji_type: result.emoji_type } : {}),
        ...(result.message_id ? { message_id: result.message_id } : {}),
      }),
    }],
  };
}
