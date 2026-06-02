/**
 * 卡片家族 4 tool —— send_card / send_poll_card / create_bitable / confirm_dangerous_action
 *
 * - send_card：DIY 纯展示卡（标题+段落+落款）
 * - create_bitable：建飞书多维表格（仅基础新建，复杂字段配置后续补）
 * - send_poll_card：投票卡（DB diy_polls/diy_poll_votes + 卡片回调实时刷票）
 * - confirm_dangerous_action：危险操作确认卡降级版（发提示卡 + 等用户文字回复）
 */

import { randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";
import {
  buildDiyCard,
  buildPollCard,
  buildConfirmCard,
  type DiyCardSection,
} from "../feishu/cards/diy-card.js";
import { createBitable, makeBitableShareable } from "../feishu/bitable.js";
import { appendBotReply } from "../utils/chat-log.js";
import {
  insertDiyPoll,
  updateDiyPollMessageId,
} from "../db/database.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const textErr = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });
const textOk = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

async function sendInteractiveCard(chatId: string, card: object): Promise<string> {
  const client = getFeishuClient();
  const res = await client.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) },
  });
  return res.data?.message_id ?? "";
}

// ───────────────────────────────────────────────────────────
// send_card
// ───────────────────────────────────────────────────────────

export const SEND_CARD_TOOL: Tool = {
  name: "send_card",
  description:
    "把内容做成飞书展示卡片发当前 chat（标题+分段，段间分割线，[文字](url)/**加粗** ，利用emoji进行格式美化）。" +
    "何时用：① 用户明说『做个卡片』② 清单/通知/几个选项带解释/结构化小结时。纯展示无按钮。闲聊别用。",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "卡片标题（显示在卡片顶部色条）" },
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            heading: { type: "string", description: "可选小标题（自动加粗成段首）" },
            body: { type: "string", description: "段落正文（支持 lark_md）" },
          },
          required: ["body"],
        },
        description: "段落数组（≥1）；段之间自动加分割线",
        minItems: 1,
      },
      footer: { type: "string", description: "可选落款小字（卡片末尾 note）" },
    },
    required: ["title", "sections"],
  },
};

export async function handleSendCard(args: {
  title: string;
  sections: DiyCardSection[];
  footer?: string;
}): Promise<ToolResult> {
  const chatId = process.env.PINPIN_CHAT_ID;
  if (!chatId) return textErr("缺 PINPIN_CHAT_ID env");
  try {
    await sendInteractiveCard(chatId, buildDiyCard(args.title, args.sections, args.footer));
    appendBotReply(chatId, `[发了卡片：${args.title}]`);
    return textOk(`已发卡片「${args.title}」到当前 chat。本次无需文字复述卡片内容。`);
  } catch (e) {
    return textErr(`发卡片失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ───────────────────────────────────────────────────────────
// create_bitable
// ───────────────────────────────────────────────────────────

export const CREATE_BITABLE_TOOL: Tool = {
  name: "create_bitable",
  description:
    "建飞书多维表格（轻量数据库 / 表格）。人类要新建表格管理某类数据时用。" +
    "返回 URL 给Owner点开。当前只建空白表，复杂字段配置后续 batch 补。",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "多维表格名称" },
      folder_token: { type: "string", description: "（可选）目标文件夹 token，不传则放云盘根目录" },
    },
    required: ["name"],
  },
};

export async function handleCreateBitable(args: {
  name: string;
  folder_token?: string;
}): Promise<ToolResult> {
  try {
    const result = await createBitable(args.name, args.folder_token);
    await makeBitableShareable(result.appToken);
    const chatId = process.env.PINPIN_CHAT_ID ?? "unknown";
    appendBotReply(chatId, `[建多维表格「${args.name}」: ${result.url}]`);
    return textOk(
      `多维表格「${args.name}」建好了：${result.url}\n` +
        `app_token=${result.appToken}, default_table_id=${result.defaultTableId}。组织内有链接可阅读。`,
    );
  } catch (e) {
    return textErr(`建多维表格失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ───────────────────────────────────────────────────────────
// send_poll_card（真实投票卡——DB 记票 + 卡片回调实时刷票）
// ───────────────────────────────────────────────────────────

export const SEND_POLL_CARD_TOOL: Tool = {
  name: "send_poll_card",
  description:
    "发一张真实投票卡到当前 chat。群成员点按钮投票，票数实时更新显示在卡片上。" +
    "一人一票，可改票（重复点切换）。重启不丢票（DB 持久化）。" +
    "选项 2~10 个，问题一句话说清楚。",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "投票问题（一句话，如『这周五活动去哪？』）",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "选项文字数组，2~10 个",
        minItems: 2,
        maxItems: 10,
      },
    },
    required: ["question", "options"],
  },
};

export async function handleSendPollCard(args: {
  question: string;
  options: string[];
}): Promise<ToolResult> {
  const chatId = process.env.PINPIN_CHAT_ID;
  if (!chatId) return textErr("缺 PINPIN_CHAT_ID env——无法发投票卡");
  if (!args.options || args.options.length < 2) {
    return textErr("投票选项至少 2 个，请重新调用并提供至少 2 个选项。");
  }
  if (args.options.length > 10) {
    return textErr("投票选项最多 10 个，请精简后重新调用。");
  }

  const pollId = randomUUID();

  try {
    // 1. 先落 DB（message_id 后填）
    insertDiyPoll(pollId, args.question, args.options, undefined, chatId);

    // 2. 构建初始投票卡（0 票）
    const card = buildPollCard(pollId, args.question, args.options, {});

    // 3. 发卡
    const client = getFeishuClient();
    const res = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    const messageId = res.data?.message_id;
    if (!messageId) {
      return textErr("投票卡发送成功但未拿到 message_id，无法绑定回调刷票。请检查飞书 API 权限。");
    }

    // 4. 回写 message_id 到 diy_polls
    updateDiyPollMessageId(pollId, messageId);

    appendBotReply(chatId, `[发了投票卡：${args.question}，poll_id=${pollId}]`);
    return textOk(
      `投票卡「${args.question}」已发出（${args.options.length} 个选项）。` +
        `群成员点按钮投票，票数实时刷新。poll_id=${pollId}。`,
    );
  } catch (e) {
    return textErr(
      `发投票卡失败：${e instanceof Error ? e.message : String(e)}。` +
        `请确认飞书应用已开通「发送消息」和「im:message:send_as_bot」权限。`,
    );
  }
}

// ───────────────────────────────────────────────────────────
// confirm_dangerous_action（降级版——发卡 + 等文字回复）
// ───────────────────────────────────────────────────────────

export const CONFIRM_DANGEROUS_ACTION_TOOL: Tool = {
  name: "confirm_dangerous_action",
  description:
    "群里非Owner的人触发『需要Owner拍板』的危险操作时调：发确认卡到当前 chat 等Owner回复。" +
    "降级版：卡片回调监听 channel 版未接入，Owner需手动文字回复『同意』/『拒绝』。" +
    "⚠️ 这是提示、不是强制闸——执行侧无任何代码层硬拦截，全靠模型自觉：拿到本 tool 返回后**不要直接执行**，等下一条Owner消息识别同意/拒绝。" +
    "用法：action_summary 一句话说要做什么。",
  inputSchema: {
    type: "object",
    properties: {
      action_summary: {
        type: "string",
        description: "操作摘要（如『重启品品』『删除某文件』），让Owner能看懂决定是否同意",
      },
    },
    required: ["action_summary"],
  },
};

export async function handleConfirmDangerousAction(args: {
  action_summary: string;
}): Promise<ToolResult> {
  const chatId = process.env.PINPIN_CHAT_ID;
  if (!chatId) return textErr("缺 PINPIN_CHAT_ID env");
  try {
    await sendInteractiveCard(chatId, buildConfirmCard(args.action_summary));
    appendBotReply(chatId, `[发确认卡：${args.action_summary}]`);
    return textOk(
      `已发确认卡问Owner是否同意「${args.action_summary}」。**先别执行**，等下一条Owner消息识别她说的『同意/可以』或『拒绝/算了』再决定。`,
    );
  } catch (e) {
    return textErr(`发确认卡失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
