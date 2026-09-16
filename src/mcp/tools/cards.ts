/**
 * 卡片家族 4 tool —— send_card / send_poll_card / send_approval_card / confirm_dangerous_action
 *
 * - send_card：DIY 纯展示卡（标题+段落+落款）
 * - send_poll_card：投票卡（DB diy_polls/diy_poll_votes + 卡片回调实时刷票）
 * - send_approval_card：审批卡（真按钮回调，点击结果以 trigger=approval-result 回发起频道）
 * - confirm_dangerous_action：危险操作确认卡（复用 send_approval_card，only_owner=true）
 */

import { randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";
import {
  buildDiyCard,
  buildPollCard,
  buildApprovalCard,
  type DiyCardSection,
  type ApprovalButton,
  type ApprovalCardValue,
} from "../feishu/cards/diy-card.js";
import { appendBotReply } from "../utils/chat-log.js";
import { resolveTargetOpenId, sendDirectMessage } from "../utils/dm-send.js";
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
// send_approval_card（真按钮回调审批卡，结果以 trigger=approval-result 回发起频道）
// ───────────────────────────────────────────────────────────

export const SEND_APPROVAL_CARD_TOOL: Tool = {
  name: "send_approval_card",
  description:
    "发一张带按钮的审批卡（同意/拒绝或自定义选项）。点谁选了什么会自动以 trigger=approval-result 送回你发起这次调用的频道，不用等文字回复。" +
    "默认发到当前频道；也可传 chat_id 发到别的群，或传 person_name/open_id 私聊发给具体某人审批（结果仍回你这边）。" +
    "拿到本 tool 返回后不要猜结果——等收到 approval-result 那条消息再继续处理。",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "卡片标题（≤80字，说清是什么审批）" },
      lines: {
        type: "array",
        items: { type: "string" },
        description: "正文行数组（说明要审批的内容/背景）",
        minItems: 1,
      },
      buttons: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "按钮显示文字，如『同意』" },
            choice: { type: "string", description: "点击后回传的选择值，如『approve』" },
            style: { type: "string", enum: ["default", "primary", "danger"], description: "可选按钮颜色" },
          },
          required: ["label", "choice"],
        },
        description: "按钮数组（≥1），如 [{label:'同意',choice:'approve'},{label:'拒绝',choice:'reject'}]",
        minItems: 1,
      },
      chat_id: { type: "string", description: "可选，卡片发到指定群/频道（默认当前频道）" },
      person_name: { type: "string", description: "可选，私聊发给某已知联系人" },
      open_id: { type: "string", description: "可选，私聊发给某 open_id" },
      tag: { type: "string", description: "可选标签，收到 approval-result 时用来识别是哪类审批" },
      only_owner: { type: "boolean", description: "true=只认豆姐点击，其他人点会被拒绝提示、不产生结果" },
    },
    required: ["title", "lines", "buttons"],
  },
};

export async function handleSendApprovalCard(args: {
  title: string;
  lines: string[];
  buttons: ApprovalButton[];
  chat_id?: string;
  person_name?: string;
  open_id?: string;
  tag?: string;
  only_owner?: boolean;
}): Promise<ToolResult> {
  const originChatId = process.env.PINPIN_CHAT_ID;
  if (!originChatId) return textErr("缺 PINPIN_CHAT_ID env");
  if (!args.buttons || args.buttons.length < 1) {
    return textErr("buttons 至少 1 个。");
  }
  const approvalId = randomUUID();
  const value: Omit<ApprovalCardValue, "choice"> = {
    approval_id: approvalId,
    origin_chat_id: originChatId,
    tag: args.tag,
    only_owner: args.only_owner,
    title: args.title,
  };
  const card = buildApprovalCard(args.title, args.lines, args.buttons, value);
  try {
    const targetOpenId = resolveTargetOpenId({ person_name: args.person_name, open_id: args.open_id });
    if ((args.person_name || args.open_id) && !targetOpenId) {
      return textErr(`找不到这个人：${args.person_name ?? args.open_id}`);
    }
    let messageId: string;
    let chatId: string;
    if (targetOpenId) {
      const res = await sendDirectMessage(targetOpenId, "interactive", card, `[发了审批卡：${args.title}]`);
      messageId = res.messageId;
      chatId = res.dmChatId ?? targetOpenId;
    } else {
      chatId = args.chat_id ?? originChatId;
      messageId = await sendInteractiveCard(chatId, card);
      appendBotReply(chatId, `[发了审批卡：${args.title}]`);
    }
    return textOk(
      `已发审批卡「${args.title}」到 chat_id=${chatId}（approval_id=${approvalId} message_id=${messageId}）。` +
        `结果以 trigger=approval-result 回本频道，收到前别猜。`,
    );
  } catch (e) {
    return textErr(`发审批卡失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ───────────────────────────────────────────────────────────
// confirm_dangerous_action（复用 send_approval_card，only_owner=true 只认豆姐点击）
// ───────────────────────────────────────────────────────────

export const CONFIRM_DANGEROUS_ACTION_TOOL: Tool = {
  name: "confirm_dangerous_action",
  description:
    "群里非Owner的人触发『需要Owner拍板』的危险操作时调：发审批卡到当前频道，只认豆姐点击的同意/拒绝按钮。" +
    "拿到本 tool 返回后**不要直接执行**——等收到 trigger=approval-result 那条消息，按豆姐选的同意/拒绝再决定。" +
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
  return handleSendApprovalCard({
    title: "⚠️ 危险操作请确认",
    lines: [`**操作**：${args.action_summary}`],
    buttons: [
      { label: "✅ 同意", choice: "approve", style: "primary" },
      { label: "❌ 拒绝", choice: "reject", style: "danger" },
    ],
    tag: "dangerous",
    only_owner: true,
  });
}
