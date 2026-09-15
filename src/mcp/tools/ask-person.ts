// ask_person tool（B5）
// 私聊问一个人一句话，只认他私聊里的回复；超时算放弃；回复自动送回发起频道。
// 命中处理在 notifications/chat-message.ts（findPendingAskJobByWatcher + 转发 + markJobFired）；
// 超时处理在 cron/scheduled-jobs-tick.ts（fireAskJob → trigger=ask-timeout）。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveTargetOpenId, sendDirectMessage } from "../utils/dm-send.js";
import { addAskJob, getKnownUserName } from "../db/database.js";
import { scheduleJob } from "../cron/scheduled-jobs-tick.js";
import { logBackground } from "../utils/background-log.js";

export const askPersonTool: Tool = {
  name: "ask_person",
  description:
    "私聊问某个人一句话，只认他在私聊里的回复（群里答了不算，需你手动收）。" +
    "对方回复会自动转发回你（发起频道）；超时（默认 15 分钟）没回则收到 ask-timeout 提醒，再催/告知/放弃自判。" +
    "person_name（known_users 反查）或 open_id 二选一。",
  inputSchema: {
    type: "object",
    properties: {
      person_name: { type: "string", description: "被问者姓名（known_users 反查；与 open_id 二选一）" },
      open_id: { type: "string", description: "被问者 open_id" },
      question: { type: "string", description: "要问的原话" },
      timeout_min: { type: "number", description: "超时分钟数，默认 15" },
      tag: { type: "string", description: "可选标注（场景/事由），超时提醒和回复转发时带出" },
    },
    required: ["question"],
  },
};

export async function handleAskPerson(args: {
  person_name?: string;
  open_id?: string;
  question: string;
  timeout_min?: number;
  tag?: string;
}) {
  const { question, person_name, open_id, tag } = args;
  const timeoutMin = args.timeout_min ?? 15;
  if (!question) {
    return { isError: true, content: [{ type: "text" as const, text: "缺少必填参数 question" }] };
  }
  const targetOpenId = resolveTargetOpenId({ person_name, open_id });
  if (!targetOpenId) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `找不到目标 ${person_name ?? open_id ?? "（未指定）"}——单聊询问Owner。` }],
    };
  }
  // 多 CLI 架构：ask 任务归发起频道自己的 CLI 调度（跟 timer/relay 同款隔离）
  const chatId = process.env.PINPIN_CHAT_ID;
  if (!chatId) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: "本进程无 PINPIN_CHAT_ID，无法注册 ask 任务" }],
    };
  }
  const targetName = person_name ?? getKnownUserName(targetOpenId) ?? targetOpenId;

  let dmChatId: string | undefined;
  try {
    const res = await sendDirectMessage(targetOpenId, "text", question, question);
    dmChatId = res.dmChatId;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `问话发送失败: ${msg}` }],
    };
  }

  const fireAt = new Date(Date.now() + timeoutMin * 60 * 1000).toISOString();
  const askJobId = addAskJob({
    chatId,
    targetOpenId,
    targetName,
    question,
    tag,
    fireAtIso: fireAt,
  });
  scheduleJob(askJobId);
  logBackground("ask-person", `job=${askJobId} → ${targetName} timeout=${timeoutMin}min`);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ask_job_id: askJobId,
          dm_chat_id: dmChatId,
          fire_at: fireAt,
          note: `已私聊问 ${targetName}。ta 在私聊里回复会自动转给你（trigger=ask-reply）；${timeoutMin} 分钟没回会收到 ask-timeout 提醒。`,
        }),
      },
    ],
  };
}
