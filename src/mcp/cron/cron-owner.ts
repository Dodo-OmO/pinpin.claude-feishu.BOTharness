// 多 CLI 架构下 cron 归属判定 helper（2026-05-28 Owner决策落地）
//
// 每个 CLI spawn 时通过 env PINPIN_CHAT_ID 传入自己的 chat_id。
// 系统级周期 cron 注册到特定归属 CLI，让其它 CLI 不重复触发：
//   - "tea"     → 茶水间 CLI（PINPIN_TEA_CHAT_ID）
//                 daily-news / weekly-recap / daily-diary / free-activity
//   - "owner"  → Owner单聊 CLI（PINPIN_OWNER_CHAT_ID）
//                 daily-briefing / memory-audit
//   - "supervisor" → 不在 MCP 子进程跑（搬到 supervisor 主进程）
//                    daily-restart / feishu-token-keepalive / mood-decay
//
// 使用方式：
//   import { isOwnerOfCron } from "./cron-owner.js";
//   if (isOwnerOfCron("tea")) registerCron(...);
//
// 行为：
//   - env 未配置目标 chat_id → 静默 skip + log warn（防止Owner没填 env 时所有 CLI 都重复注册）
//   - PINPIN_CHAT_ID 等于目标 chat_id → return true → 注册 cron
//   - 否则 → return false → cron skip

import { logBackground } from "../utils/background-log.js";

export type CronOwnerKind = "tea" | "owner";

const OWNER_ENV_MAP: Record<CronOwnerKind, string> = {
  tea: "PINPIN_TEA_CHAT_ID",
  owner: "PINPIN_OWNER_CHAT_ID",
};

const warned = new Set<string>();
// F2：每个 kind 只记一次归属判定（isOwnerOfCron 每 cron 各调一次，去重防刷屏）
const loggedOwnership = new Set<CronOwnerKind>();

export function isOwnerOfCron(kind: CronOwnerKind): boolean {
  const envName = OWNER_ENV_MAP[kind];
  const ownerChatId = process.env[envName];
  const ownChatId = process.env.PINPIN_CHAT_ID;
  if (!ownerChatId) {
    if (!warned.has(envName)) {
      warned.add(envName);
      process.stderr.write(
        `[cron-owner] .env 缺 ${envName}（${kind} 归属 chat_id），相关 cron 不会注册。Owner请在 .env 补 ${envName}=oc_xxx\n`,
      );
    }
    return false;
  }
  if (!ownChatId) {
    // 非 channel CLI 子进程（如直接 node dist/mcp/server.js 调试）→ 默认不跑系统 cron
    return false;
  }
  const owns = ownChatId === ownerChatId;
  // F2：记录本 CLI 对该 kind 的归属判定（带身份，便于查"哪个 CLI 该跑哪些系统 cron"）
  if (!loggedOwnership.has(kind)) {
    loggedOwnership.add(kind);
    logBackground(
      "cron-owner",
      `本CLI[…${ownChatId.slice(-6)}] ${kind} 归属=${owns ? "是(注册其 cron)" : "否(跳过)"}`,
    );
  }
  return owns;
}
