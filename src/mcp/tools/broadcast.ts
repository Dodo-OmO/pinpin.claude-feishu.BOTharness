// broadcast tool——一件事发生了，实时通知别的频道的品品（她们只更新认知、不在自己频道说话）。
//
// 跟 cross_chat_message 的分工：捎话是"请那边的你去说一句"，广播是"让那边的你知道这件事"。
// 接收端收到 trigger=broadcast 一律不外发（规矩在 jiuzhou-ops §13），所以广播不会造成任何多余消息。
// 路由由调用方给：指名某人的事只播给他私聊 + 部门群；全组的事 scope=all 播给全部Client频道。
// supervisor 侧同时把这条追加到 `Client\广播板.md` 当底账（重启后还能回看）。

import { getSupervisorClient } from "../../ipc/client-singleton.js";
import { IPC_METHODS, type BroadcastResult } from "../../ipc/protocol.js";
import { logBackground } from "../utils/background-log.js";

export const BROADCAST_TOOL = {
  name: "broadcast",
  description:
    "**把一件事实时通知给别的频道的你**（她们只记住、不在自己频道说话）。什么时候用：给组员派活/改期/催办/标完成、" +
    "建了台账任务、全组通知（放假调休、流程变更、汇星上新、群简报已发）。" +
    "**不广播**：豆姐的私事、她和领导/其他部门的事、还没定的事、组员私聊里的家常——这些留在原频道。" +
    "scope=person 时必须给 chat_ids（当事人私聊 + 部门群）；scope=all 只用于全组都该知道的事。" +
    "text 写清「谁、什么事、到哪一步、有没有截止」，一句话，别写成给群里发的原文。",
  inputSchema: {
    type: "object" as const,
    properties: {
      kind: {
        type: "string" as const,
        enum: ["派活", "改期", "催办", "完成", "通知", "其它"],
        description: "事件类型，接收端据此判断要不要更新自己的认知",
      },
      text: {
        type: "string" as const,
        description: "一句话摘要：谁、什么事、到哪一步、截止（给「另一个你」看的，不是发群里的原文）",
      },
      scope: {
        type: "string" as const,
        enum: ["person", "all"],
        description: "person=只播给 chat_ids 里的频道（当事人私聊 + 部门群）；all=播给全部Client频道",
      },
      chat_ids: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "scope=person 时必填：目标频道 chat_id 列表（组员私聊见 `环境\\Client.md` §四）",
      },
    },
    required: ["kind", "text", "scope"],
  },
};

interface BroadcastArgs {
  kind: string;
  text: string;
  scope: "person" | "all";
  chat_ids?: string[];
}

export async function handleBroadcast(
  args: BroadcastArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { kind, text, scope } = args;
  if (!text) return { isError: true, content: [{ type: "text", text: "缺少 text" }] };
  if (scope === "person" && !(args.chat_ids && args.chat_ids.length)) {
    return { isError: true, content: [{ type: "text", text: "scope=person 必须给 chat_ids（当事人私聊 + 部门群）" }] };
  }
  let r: BroadcastResult;
  try {
    r = await getSupervisorClient().request<BroadcastResult>(IPC_METHODS.BROADCAST, {
      kind,
      text,
      scope,
      chat_ids: args.chat_ids,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ delivered: [], error: `广播失败: ${msg}` }) }] };
  }
  logBackground("broadcast", `${kind} scope=${scope} → ${r.delivered.join("、") || "无"}${r.failed.length ? ` 失败:${r.failed.join("、")}` : ""}`);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ delivered: r.delivered, failed: r.failed, note: "已通知到的频道只是知道了，不会替你说话" }),
    }],
  };
}
