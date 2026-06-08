// 通用 channel notification 推送 helper（MCP 版）
// 阶段 4 批次 2：所有 cron / 入站 trigger 都通过这里推 channel notification 给主 session。
//
// 设计：server.ts 启动后调 setServerInstance(server) 注入，其它地方 import pushChannelTrigger 即可。
// 避免循环依赖（cron 文件 → push-channel ← server.ts）。

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { randomUUID } from "node:crypto";
import { logBackground } from "./background-log.js";
import { sanitizeChannelParams } from "./sanitize-surrogates.js";

// 方案 A §22 PoC-5 修复：trigger channel 让 LLM 必响应
// 文档明确 meta value 必须是 string（"Record<string, string>"）+ key 必须 identifier
// LLM 收到飞书 user 入站 channel 会响应是因为含 user/sender_type/message_id 等"消息标识"字段
// trigger channel 缺这些 → LLM 当系统广播忽略 → 改方案：trigger channel 也带这些字段
// 让 LLM 把每条 trigger 当成"系统这位发送者发的消息"必须响应

// 让所有 meta value 都转 string（飞书 meta 字段值文档要求 string）
function toStringMeta(meta: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

let serverRef: Server | null = null;

export function setServerInstance(server: Server): void {
  serverRef = server;
}

// 回复后两段共用 trigger body（精简——参数语义在对应 tool description 里，这里只提示去调哪个 tool）
export const MOOD_APPRAISE_TRIGGER_BODY =
  "🌸 回完这轮了，有显著情绪变化就自评下心境 → 调 mood_appraise tool（平淡轮跳过）。";
export const MEMORY_REMIND_BODY =
  "💭 这轮有值得长期记的吗（你不知道的个人信息 / 长期偏好 / 强烈情感 / 内梗）？有就调 pinpin_memorize 去记，没有跳过。";

export interface ChannelTriggerPayload {
  /** trigger 名称（早报/周回顾/记忆自检/心境衰减/重启失忆护理 等） */
  trigger: string;
  /** 内容正文（让主 session 看到该做什么） */
  body: string;
  /** 可选 chat_id（指明触发关联的 chat） */
  chat_id?: string;
  /** 其它 meta 字段 */
  meta?: Record<string, unknown>;
}

/**
 * 推一条 channel trigger notification 给主 session。
 * 默认失败仅 logBackground 不抛——cron 不应该因为推送失败而崩溃链条。
 * opts.throwOnError=true 时透传异常给调用方做 retry 决策（scheduled-jobs-tick 用，
 * 让 intent=hard 任务推失败能进 retry 链而非静默丢）
 */
export async function pushChannelTrigger(
  payload: ChannelTriggerPayload,
  opts?: { throwOnError?: boolean }
): Promise<void> {
  if (!serverRef) {
    const msg = `server 未初始化，trigger=${payload.trigger} 丢弃`;
    if (opts?.throwOnError) throw new Error(msg);
    process.stderr.write(`[push-channel] ${msg}\n`);
    return;
  }
  try {
    // 方案 X：trigger channel 加 user/sender_type/message_id 让 LLM 当成消息必响应
    // 这些字段跟飞书 user 入站 channel 字段集对齐，LLM instructions 已学会处理（看到 channel 就回应）
    const meta = toStringMeta({
      source: "feishu-channel",
      // 必备消息标识字段（让 LLM 把 trigger 当成"系统发送者发来的消息"必响应）
      user: "系统",
      sender_type: "system",
      message_id: `sys-${payload.trigger}-${randomUUID()}`,
      // trigger 类型（让 instructions trigger 处理协议识别该做什么）
      trigger: payload.trigger,
      ...(payload.chat_id ? { chat_id: payload.chat_id } : {}),
      ...(payload.meta ?? {}),
      ts: new Date().toISOString(),
    });

    await serverRef.notification({
      method: "notifications/claude/channel",
      params: sanitizeChannelParams(payload.body, meta),
    });
    logBackground("push-channel", `trigger=${payload.trigger}${payload.chat_id ? ` chat=${payload.chat_id}` : ""}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logBackground("push-channel", `trigger=${payload.trigger} FAILED: ${msg}`);
    if (opts?.throwOnError) throw e;
    process.stderr.write(`[push-channel] push trigger=${payload.trigger} failed: ${msg}\n`);
  }
}
