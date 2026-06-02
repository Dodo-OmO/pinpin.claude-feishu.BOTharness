// relay_message tool（MCP 版）
// 传话主动催功能：品品替委托人 A 传话给 B，若 B 没回则按线性退避最多催 2 次，
// B 一回则自动把回音报给 A。
//
// 流程：
//   1. 品品先私聊 B 转达原话
//   2. 同时调本 tool 创建 relay 任务（+30min 首次催时间）
//   3. scheduled-jobs-tick.ts 到点检查 B 是否回 → 没回催 → 最多 2 次
//   4. chat-message.ts B 发消息时命中 relay job → 推 relay-callback trigger → 品品回报 A

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { addRelayJob, resolveOpenId } from "../db/database.js";
import { scheduleJob } from "../cron/scheduled-jobs-tick.js";
import { logBackground } from "../utils/background-log.js";

// 首次催等待时间（分钟）：A 转达后 30 分钟没收到 B 的回复才催第一次
const FIRST_NUDGE_DELAY_MIN = 30;

export const relayMessageTool: Tool = {
  name: "relay_message",
  description:
    "帮委托人 A 传话给 B，并开启自动催回音机制。" +
    "⚠️ 必须先调 send_private_message 把原话发给 B，再调本 tool 登记催办；漏了第一步 B 永远收不到原话、系统却已开始催。" +
    "用法：①品品先调 send_private_message 私聊 B 转达原话，②再调本 tool 记录 relay 任务。" +
    "系统会在 B 没回时自动催（最多 2 次，+30min/+60min 线性退避），B 一回就把回音报给 A。" +
    "to_open_id 与 to_name 二选一；from_open_id 与 from_name 二选一。",
  inputSchema: {
    type: "object",
    properties: {
      to_open_id: {
        type: "string",
        description: "被转达方 B 的 open_id（与 to_name 二选一）",
      },
      to_name: {
        type: "string",
        description: "被转达方 B 的姓名/昵称（known_users 反查；与 to_open_id 二选一）",
      },
      from_open_id: {
        type: "string",
        description: "委托人 A 的 open_id（与 from_name 二选一）",
      },
      from_name: {
        type: "string",
        description: "委托人 A 的姓名/昵称（展示用 + known_users 反查 open_id；与 from_open_id 二选一）",
      },
      body: {
        type: "string",
        description: "要转达的原话（记录用，催的时候会带上）",
      },
    },
    required: ["body"],
  },
};

export async function handleRelayMessage(args: {
  to_open_id?: string;
  to_name?: string;
  from_open_id?: string;
  from_name?: string;
  body: string;
}) {
  const { to_open_id, to_name, from_open_id, from_name, body } = args;

  // 解析被转达方 B 的 open_id
  let watcherOpenId = to_open_id;
  if (!watcherOpenId && to_name) {
    watcherOpenId = resolveOpenId(to_name);
  }
  if (!watcherOpenId) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `找不到被转达方——to_name="${to_name ?? ""}" 在 known_users 查不到，请传具体 to_open_id 或先让对方在群说句话。`,
        },
      ],
    };
  }

  // 解析委托人 A 的 open_id（可选，若没有就没法回报）
  let resolvedFromOpenId = from_open_id;
  if (!resolvedFromOpenId && from_name) {
    resolvedFromOpenId = resolveOpenId(from_name);
  }
  if (!resolvedFromOpenId) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `找不到委托人——from_name="${from_name ?? ""}" 在 known_users 查不到，请传 from_open_id 或先让委托人在群说句话。`,
        },
      ],
    };
  }

  const displayFromName = from_name ?? resolvedFromOpenId.slice(-8);
  const firstNudgeAtIso = new Date(
    Date.now() + FIRST_NUDGE_DELAY_MIN * 60 * 1000,
  ).toISOString();

  // 多 CLI 调度隔离：relay job 的 chat_id 存委托人 A 所在频道
  // （tool 被哪个 CLI 进程执行，process.env.PINPIN_CHAT_ID 就是那个频道）
  // 只有该频道的 CLI 才 fire 这条 relay，防多 CLI 双催 B
  const ownerChatId = process.env.PINPIN_CHAT_ID ?? "relay";

  const jobId = addRelayJob({
    chatId: ownerChatId,
    watcherOpenId,
    fromOpenId: resolvedFromOpenId,
    fromName: displayFromName,
    body,
    firstNudgeAtIso,
  });

  // 立刻注册 setTimeout（跨重启靠 schedulerStart 恢复）
  scheduleJob(jobId);

  logBackground(
    "relay",
    `created job=${jobId} from=${resolvedFromOpenId.slice(-6)} watcher=${watcherOpenId.slice(-6)} first_nudge=${firstNudgeAtIso}`,
  );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          relay_started: true,
          job_id: jobId,
          first_nudge_at: firstNudgeAtIso,
          max_nudges: 2,
          note: "已开启催回音机制，B 回了会自动报给 A；B 不回则 +30min/+60min 各催一次后告知 A 暂未回。",
        }),
      },
    ],
  };
}
