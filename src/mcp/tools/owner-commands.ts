/**
 * OWNER 命令 3 tool（仅Owner有权调）—— restart_self / sleep_self / compact_chat
 *
 * 多 CLI 架构语义：
 *   - restart_self：本 CLI process.exit(0) → supervisor R14 自动重启路径（5s 退避，5min 内 ≤3 次）
 *     = 清空当前 CLI 上下文 = fresh session。
 *   - compact_chat：不退进程——经 IPC 让 supervisor 往本频道 CLI 的 PTY 写 `/compact\n`，
 *     触发 CLI 原生就地压缩（留摘要、人格 / CLAUDE.md 从磁盘重注入、同 session 继续，不失忆）。
 *   - sleep_self：经 IPC 让 supervisor 关闭本频道（pauseChannel：stop + evict 出 Map，归属 standby 不变）。
 *     evict 后频道 OFF，有人说话经入站热路径自动唤醒（supervisor 不自动重启）。
 *
 * 鉴权（消化方案 A §17.2 OWNER_ONLY_TOOLS 设计）：
 *   - 不走 sender-context.ts AsyncLocalStorage（未落地）
 *   - 走简化方案：tool handler 调 owner-auth checkOwner()（内部查 getLastInboundSenderOpenId
 *     比对 process.env.FEISHU_OWNER_OPEN_ID；不等于 → reject）
 *   - 单 CLI 隔离下"最近 inbound sender"就是当前 tool 调用触发者
 */

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

export const SLEEP_SELF_TOOL: Tool = {
  name: "sleep_self",
  description:
    "【仅Owner】让品品**本频道 CLI**下线休息（supervisor 不自动重启，有人说话会自动唤醒）。Owner说『下线品品』『/下线』『睡一觉』时调。",
  inputSchema: { type: "object", properties: {} },
};

export async function handleSleepSelf(): Promise<ToolResult> {
  const auth = checkOwner();
  if (!auth.ok) return textErr(auth.reason ?? "OWNER 鉴权失败");
  const chatId = process.env.PINPIN_CHAT_ID;
  if (!chatId) return textErr("缺 PINPIN_CHAT_ID env");
  // 先把"下班"话发出去（supervisor 收到 SLEEP_SELF 后约 200ms 树杀本 child）。
  try {
    await sendText(chatId, "下班咯 😴 ～");
  } catch (e) {
    process.stderr.write(`[sleep_self] sendText 失败: ${e instanceof Error ? e.message : e}\n`);
  }
  // 经 IPC 让 supervisor 关闭本频道（pauseChannel：stop + evict 出 Map，归属不变）。
  // evict 后有人说话经入站热路径自动唤醒，那条消息照常送达。IPC 失败（supervisor 失联）则报错不下线。
  try {
    const result = await getSupervisorClient().request<WorkOkResult>(IPC_METHODS.SLEEP_SELF, {
      chat_id: chatId,
    });
    if (!result.ok) return textErr(`下线失败：${result.error ?? "unknown"}`);
  } catch (e) {
    return textErr(`下线失败（supervisor 未连上？）：${e instanceof Error ? e.message : String(e)}`);
  }
  return textOk("已通知Owner并下线本频道：supervisor 不自动重启，有人说话会自动唤醒（归属不变）。");
}

// ───────────────────────────────────────────────────────────
// compact_chat
// ───────────────────────────────────────────────────────────

export const COMPACT_CHAT_TOOL: Tool = {
  name: "compact_chat",
  description:
    "【仅Owner】就地压缩本频道 CLI 上下文（执行 /compact）。Owner明确说『压缩/整理你的上下文/脑子』时才调；与文件/图片压缩无关。",
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
