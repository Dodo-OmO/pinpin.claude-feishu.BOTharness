// pinpin_reply_text tool handler——阶段 3 批 2 文字回复语义化 tool
// 取代 早期版本的 zzzpin 文字 + [huifula-pin] 字符串协议
//
// 入参：chat_id（必填）/ text（必填）/ reply_to_message_id（可选，引用单条消息）
// 行为：splitMessage（>1900 字切片）→ sendText / replyText
// 失败：tool 返回 isError + 详细 error 信息

import { sendText, replyText, splitMessage } from "./feishu-send.js";
import { appendBotReply } from "../utils/chat-log.js";
import { pushChannelTrigger, MOOD_APPRAISE_TRIGGER_BODY, MEMORY_REMIND_BODY } from "../utils/push-channel.js";

export const PINPIN_REPLY_TEXT_TOOL = {
  name: "pinpin_reply_text",
  description:
    "文字回复。**只回某一条消息** → 传 reply_to_message_id 引用它（飞书挂源消息下、体现回的是这条，不必再 @）；**一次回多条 / 多人** → 不引用，text 里分段、每段开头 <at> 对应的人、段间换行。",
  inputSchema: {
    type: "object" as const,
    properties: {
      chat_id: {
        type: "string" as const,
        description: "目标 chat_id（你所在的当前频道；从 channel 标签照抄）",
      },
      text: {
        type: "string" as const,
        description: "纯文本正文。圈人 <at user_id=\"ou_xxx\"></at>（人类 ou_ / bot cli_ 开头；圈 bot 时标签中间**必须写显示名**否则飞书显示空白）。富文本：<b></b> 加粗 / 换行 / emoji / [链](url)。**别用块级 markdown**（# 标题 / 列表 / > 引用 / 代码块 / 分隔线）和内联反引号 / **——飞书 reply 不渲染会露原始符号。",
      },
      reply_to_message_id: {
        type: "string" as const,
        description: "传它 = 引用这条消息回复。只在回复单独一条消息时传；一次回多条 / 多人时不传，改用 text 分段 @。",
      },
    },
    required: ["chat_id", "text"],
  },
};

interface PinpinReplyTextArgs {
  chat_id: string;
  text: string;
  reply_to_message_id?: string;
}

export async function handlePinpinReplyText(
  args: PinpinReplyTextArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { chat_id, text, reply_to_message_id } = args;

  if (!chat_id || !text) {
    return {
      isError: true,
      content: [{ type: "text", text: "缺少必填参数 chat_id 或 text" }],
    };
  }

  const chunks = splitMessage(text);
  const sentIds: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const id =
        i === 0 && reply_to_message_id
          ? await replyText(reply_to_message_id, chunks[i])
          : await sendText(chat_id, chunks[i]);
      sentIds.push(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[pinpin_reply_text] sendText 失败 chunk ${i}: ${msg}\n`);
      return {
        isError: true,
        content: [{
          type: "text",
          text: JSON.stringify({ delivered: false, error: `飞书发送失败(chunk ${i}): ${msg}` }),
        }],
      };
    }
  }

  process.stderr.write(`[pinpin_reply_text] 发送 OK chunks=${chunks.length} ids=${sentIds.join(",")}\n`);

  // 阶段 4 批次 3：写本地对话日志 + 推 mood-appraise trigger（PoC-3 假设通过；备选见任务 MD）
  appendBotReply(args.chat_id, args.text);
  void pushChannelTrigger({ trigger: "mood-appraise", chat_id: args.chat_id, body: MOOD_APPRAISE_TRIGGER_BODY });
  // 主动记忆提醒（恢复 SDK 状态机"每轮问一嘴要不要记永存"的体感）——品品自决、静默不汇报
  void pushChannelTrigger({ trigger: "memory-remind", chat_id: args.chat_id, body: MEMORY_REMIND_BODY });

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ delivered: true, message_ids: sentIds }),
    }],
  };
}
