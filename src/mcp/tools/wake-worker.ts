// wake_worker tool（协议追加 2026-09-17）——叫醒本机托管的常驻工人会话（医生/工程师/顺子等）
//
// 工人闲时不保活（空闲 30 分钟自动结束进程）；派活前先叫醒，再用 SendMessage 发活。
// 不需要 OWNER 鉴权：所有频道都能叫醒工人（只是唤醒，不能替工人发言）。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getSupervisorClient } from "../../ipc/client-singleton.js";
import { IPC_METHODS, type WakeWorkerParams, type WakeWorkerResult } from "../../ipc/protocol.js";

export const wakeWorkerTool: Tool = {
  name: "wake_worker",
  description:
    "叫醒本机托管的常驻工人会话（医生 / 工程师 / 顺子等，名字同 ListAgents 里的名字）。" +
    "醒了再用 SendMessage 发活；返回失败时如实告诉豆姐。",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "工人名字（同 ListAgents 里的名字）" },
    },
    required: ["name"],
  },
};

interface WakeWorkerArgs {
  name: string;
}

export async function handleWakeWorker(
  args: WakeWorkerArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { name } = args;
  if (!name) {
    return { isError: true, content: [{ type: "text", text: "缺少必填参数 name" }] };
  }
  try {
    const client = getSupervisorClient();
    const res = await client.request<WakeWorkerResult>(
      IPC_METHODS.WAKE_WORKER,
      { name } satisfies WakeWorkerParams,
    );
    if (!res.ok) {
      return { isError: true, content: [{ type: "text", text: `叫不醒「${name}」：${res.error ?? "未知错误"}` }] };
    }
    const stateText = res.state === "already" ? "已经醒着" : "已叫醒";
    return { content: [{ type: "text", text: `「${name}」${stateText}，可以 SendMessage 发活了。` }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text", text: `叫醒失败（IPC）：${msg}` }] };
  }
}
