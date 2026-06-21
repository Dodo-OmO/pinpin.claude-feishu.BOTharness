// disband_group tool（协议追加 2026-05-29）——【仅Owner】解散品品自己建的群
//
// 双闸 fail-closed：① OWNER 鉴权（checkOwner，本频道最近发言者必须是Owner）
//                  ② 仅能解散品品 create_group 建过的群（查 pinpin_created_groups 表）
// 飞书 im.v1.chat.delete：要求机器人是群主——品品建群时不传 owner_id 即自动成群主，满足。
// 解散后通知 supervisor stopChannel 停该群 CLI + 删配置。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";
import { isCreatedByPinpin, removeCreatedGroup } from "../db/database.js";
import { checkOwner } from "../owner-auth.js";
import { getSupervisorClient } from "../../ipc/client-singleton.js";
import { IPC_METHODS, type WorkOkResult } from "../../ipc/protocol.js";

export const disbandGroupTool: Tool = {
  name: "disband_group",
  description: "【仅Owner】解散你自己建的飞书群（细节见 group-management skill）。",
  inputSchema: {
    type: "object",
    properties: {
      chat_id: { type: "string", description: "要解散的群 chat_id（必须是你之前 create_group 建的）" },
    },
    required: ["chat_id"],
  },
};

interface DisbandGroupArgs {
  chat_id: string;
}

export async function handleDisbandGroup(
  args: DisbandGroupArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { chat_id } = args;
  if (!chat_id) {
    return { isError: true, content: [{ type: "text", text: "缺少必填参数 chat_id" }] };
  }
  // 闸 1：OWNER 鉴权
  const auth = checkOwner();
  if (!auth.ok) {
    return { isError: true, content: [{ type: "text", text: auth.reason ?? "OWNER 鉴权失败" }] };
  }
  // 闸 2：仅能解散品品自己建的群
  if (!isCreatedByPinpin(chat_id)) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `这个群不是你建的（${chat_id}）——只能解散你自己用 create_group 建的群，不能解散Owner的正式群。`,
      }],
    };
  }
  try {
    await getFeishuClient().im.v1.chat.delete({ path: { chat_id } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isPerm = /permission|99991672|forbidden|权限|access|owner/i.test(msg);
    if (isPerm) {
      return {
        isError: true,
        content: [{
          type: "text",
          text:
            "解散失败：飞书应用缺解散群权限。需在飞书开放平台后台开通 im:chat + " +
            "im:chat:operate_as_owner 并重新发布应用版本。原始错误：" + msg,
        }],
      };
    }
    return { isError: true, content: [{ type: "text", text: `解散失败：${msg}` }] };
  }
  removeCreatedGroup(chat_id);
  // 停该群 CLI
  try {
    const client = getSupervisorClient();
    await client.request<WorkOkResult>(IPC_METHODS.STOP_CHANNEL, { chat_id });
  } catch (e) {
    process.stderr.write(
      `[disband_group] 停频道 IPC 失败（群已解散）: ${e instanceof Error ? e.message : e}\n`,
    );
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ disbanded: true, chat_id }) }],
  };
}
