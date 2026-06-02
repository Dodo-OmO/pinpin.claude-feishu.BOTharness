/**
 * OWNER 命令 3 tool（仅Owner有权调）—— restart_self / sleep_self / compact_chat
 *
 * 多 CLI 架构语义：
 *   - restart_self：本 CLI process.exit(0) → supervisor R14 自动重启路径（5s 退避，5min 内 ≤3 次）
 *     = 清空当前 CLI 上下文 = fresh session。
 *   - compact_chat：不退进程——经 IPC 让 supervisor 往本频道 CLI 的 PTY 写 `/compact\n`，
 *     触发 CLI 原生就地压缩（留摘要、人格 / CLAUDE.md 从磁盘重注入、同 session 继续，不失忆）。
 *   - sleep_self：写 `.bot.sleep.<chatId>` 标记文件后 process.exit(0)。supervisor 'crashed'
 *     handler 检查到此文件存在则**不自动重启**（Owner得手动从启动器恢复）。
 *
 * 鉴权（消化方案 A §17.2 OWNER_ONLY_TOOLS 设计）：
 *   - 不走 sender-context.ts AsyncLocalStorage（未落地）
 *   - 走简化方案：tool handler 调 owner-auth checkOwner()（内部查 getLastInboundSenderOpenId
 *     比对 process.env.FEISHU_OWNER_OPEN_ID；不等于 → reject）
 *   - 单 CLI 隔离下"最近 inbound sender"就是当前 tool 调用触发者
 */

import fs from "node:fs";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { sendText } from "./feishu-send.js";
import { checkOwner } from "../owner-auth.js";
import { getSupervisorClient } from "../../ipc/client-singleton.js";
import { IPC_METHODS, type WorkOkResult } from "../../ipc/protocol.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const textErr = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });
const textOk = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

// ───────────────────────────────────────────────────────────
// restart_self
// ───────────────────────────────────────────────────────────

export const RESTART_SELF_TOOL: Tool = {
  name: "restart_self",
  description:
    "【仅Owner】重启**本频道 CLI**进程（supervisor 自动 5s 退避重启路径）。Owner说『重启品品』『/重启』时调。" +
    "不影响其它频道 CLI 或 supervisor 本身。",
  inputSchema: { type: "object", properties: {} },
};

export async function handleRestartSelf(): Promise<ToolResult> {
  const auth = checkOwner();
  if (!auth.ok) return textErr(auth.reason ?? "OWNER 鉴权失败");
  const chatId = process.env.PINPIN_CHAT_ID;
  if (!chatId) return textErr("缺 PINPIN_CHAT_ID env");
  try {
    await sendText(chatId, "重启去咯～等我 🌸");
  } catch (e) {
    process.stderr.write(`[restart_self] sendText 失败: ${e instanceof Error ? e.message : e}\n`);
  }
  setTimeout(() => process.exit(0), 1000);
  return textOk("已通知Owner，1 秒后退出进程，supervisor 会自动重启本频道 CLI。");
}

// ───────────────────────────────────────────────────────────
// sleep_self
// ───────────────────────────────────────────────────────────

/** sleep marker 文件路径：跟 supervisor appRoot 对齐（= data.db 所在目录）。
 *  supervisor/index.ts:420 用 this.opts.appRoot 检查，本函数用 dirname(PINPIN_DB_PATH)
 *  两者天然一致（supervisor dbPath = path.join(appRoot, 'data.db')） */
function getSleepMarkerPath(chatId: string): string {
  const dbPath = process.env.PINPIN_DB_PATH;
  const appRoot = dbPath ? path.dirname(dbPath) : process.cwd();
  return path.join(appRoot, `.bot.sleep.${chatId.slice(-8)}`);
}

export const SLEEP_SELF_TOOL: Tool = {
  name: "sleep_self",
  description:
    "【仅Owner】让品品**本频道 CLI**下线休息（supervisor 不自动重启，需Owner手动从启动器恢复）。Owner说『下线品品』『/下线』『睡一觉』时调。",
  inputSchema: { type: "object", properties: {} },
};

export async function handleSleepSelf(): Promise<ToolResult> {
  const auth = checkOwner();
  if (!auth.ok) return textErr(auth.reason ?? "OWNER 鉴权失败");
  const chatId = process.env.PINPIN_CHAT_ID;
  if (!chatId) return textErr("缺 PINPIN_CHAT_ID env");
  try {
    fs.writeFileSync(getSleepMarkerPath(chatId), "1");
  } catch (e) {
    process.stderr.write(`[sleep_self] 写 .bot.sleep 失败: ${e instanceof Error ? e.message : e}\n`);
    return textErr(`没法写 sleep marker：${e instanceof Error ? e.message : e}`);
  }
  try {
    await sendText(chatId, "下班咯 😴 ～");
  } catch (e) {
    process.stderr.write(`[sleep_self] sendText 失败: ${e instanceof Error ? e.message : e}\n`);
  }
  setTimeout(() => process.exit(0), 1000);
  return textOk("已通知Owner，1 秒后退出，sleep marker 已写，supervisor 不会自动重启。");
}

// ───────────────────────────────────────────────────────────
// compact_chat
// ───────────────────────────────────────────────────────────

export const COMPACT_CHAT_TOOL: Tool = {
  name: "compact_chat",
  description:
    "【仅Owner】压缩本频道 CLI 的上下文——触发**就地原生压缩**（CLI 原生 /compact）。调本 tool 前先发飞书告知Owner即可，无需派 agent / 写摘要。\n" +
    "⚠️ **严防误触发**：只在Owner**明确要你压缩自己的上下文/脑子**时调——明确信号是 " +
    "『/压缩』『压缩你的上下文』『整理一下你的脑子』『清下你的上下文』这类指向「你品品的记忆/上下文」的话。" +
    "Owner只是顺口提到『压缩』别的东西（压缩文件/压缩包/压缩图片/把内容压缩一下篇幅 等）时**绝不调本 tool**。拿不准就先问Owner「是要我整理自己脑子吗」，别擅自压缩。",
  inputSchema: { type: "object", properties: {} },
};

export async function handleCompactChat(): Promise<ToolResult> {
  const auth = checkOwner();
  if (!auth.ok) return textErr(auth.reason ?? "OWNER 鉴权失败");
  const chatId = process.env.PINPIN_CHAT_ID;
  if (!chatId) return textErr("缺 PINPIN_CHAT_ID env");
  try {
    await sendText(chatId, "脑袋爆炸了，我去洗把脸，等我～ 🧹");
  } catch (e) {
    process.stderr.write(`[compact_chat] sendText 失败: ${e instanceof Error ? e.message : e}\n`);
  }
  // 经 IPC 让 supervisor 往本频道 CLI 的 PTY 写 `/compact\n`，触发 CLI 原生就地压缩。
  // ⚠️ 时序注意：本 tool handler 是被当前 CLI session 调用的；写 PTY 的 `/compact` 会进入
  //    同一个 CLI 的输入流，CLI 处理完本轮 tool 调用 / 输出后才会解析这行 slash 命令。
  //    实测如有时序问题（命令被当前 turn 吞掉 / 顺序错乱）在此复查。
  try {
    const client = getSupervisorClient();
    const result = await client.request<WorkOkResult>(IPC_METHODS.COMPACT_VIA_PTY, {
      chat_id: chatId,
    });
    if (!result.ok) {
      return textErr(`触发原生压缩失败：${result.error ?? "unknown"}`);
    }
    return textOk("已通知Owner并触发本频道 CLI 原生 /compact 就地压缩（留摘要、人格不丢、不重启）。");
  } catch (e) {
    return textErr(`触发原生压缩失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
