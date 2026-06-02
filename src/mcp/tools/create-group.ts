// create_group tool（协议追加 2026-05-29）——品品按Owner语义新建群 + 自动命名 + 即时挂监听
//
// 飞书 im.v1.chat.create：**不传 owner_id** → 建群机器人（品品）自动成群主，
// 才能日后 disband_group 解散自己建的群。建企业内部群；目标人若是企业外部联系人，
// 外部群品品当不了群主、解散受限（本次不专门处理）。
// 建群后通过 IPC 通知 supervisor 即时挂该群频道监听（不等群里有人先发消息）。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";
import { markCreatedGroup } from "../db/database.js";
import { getSupervisorClient } from "../../ipc/client-singleton.js";
import { IPC_METHODS, type WorkOkResult } from "../../ipc/protocol.js";

const MAX_GROUP_NAME = 60; // 飞书群名建议上限

export const createGroupTool: Tool = {
  name: "create_group",
  description: "新建飞书群、拉人/bot 进群（建群细节与注意事项见 group-management skill）。",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "群名称（按Owner语义起；超 60 字自动截断）" },
      member_open_ids: {
        type: "array",
        items: { type: "string" },
        description: "拉进群的人的 open_id 列表（ou_ 开头），至少一个",
      },
      bot_app_ids: {
        type: "array",
        items: { type: "string" },
        description: "可选。拉进群的其它机器人 app_id 列表",
      },
    },
    required: ["name", "member_open_ids"],
  },
};

interface CreateGroupArgs {
  name: string;
  member_open_ids: string[];
  bot_app_ids?: string[];
}

export async function handleCreateGroup(
  args: CreateGroupArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { name, member_open_ids, bot_app_ids } = args;
  if (!name || !member_open_ids?.length) {
    return {
      isError: true,
      content: [{ type: "text", text: "缺少必填参数 name 或 member_open_ids（至少拉一个人）" }],
    };
  }
  const groupName = name.length > MAX_GROUP_NAME ? name.slice(0, MAX_GROUP_NAME) : name;
  try {
    const res = await getFeishuClient().im.v1.chat.create({
      params: { user_id_type: "open_id" },
      data: {
        name: groupName,
        user_id_list: member_open_ids,
        ...(bot_app_ids?.length ? { bot_id_list: bot_app_ids } : {}),
      },
    });
    const chatId = res.data?.chat_id;
    if (!chatId) {
      return { isError: true, content: [{ type: "text", text: "建群失败：飞书没返回 chat_id" }] };
    }
    // 标记自建群（解散鉴权用）；DB 故障不应让"群已建好"误报为失败，独立兜底
    try {
      markCreatedGroup(chatId, groupName);
    } catch (e) {
      process.stderr.write(
        `[create_group] 标记自建群失败（群已建好，日后解散功能可能受影响）: ${e instanceof Error ? e.message : e}\n`,
      );
    }
    // 即时挂监听（不等群里有人发消息）
    try {
      const client = getSupervisorClient();
      await client.request<WorkOkResult>(IPC_METHODS.SPAWN_CHANNEL, {
        chat_id: chatId,
        chat_name: groupName,
      });
    } catch (e) {
      process.stderr.write(
        `[create_group] 挂频道 IPC 失败（群已建好）: ${e instanceof Error ? e.message : e}\n`,
      );
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ created: true, chat_id: chatId, name: groupName }) }],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isPerm = /permission|99991672|forbidden|权限|no\s*permission|access/i.test(msg);
    if (isPerm) {
      return {
        isError: true,
        content: [{
          type: "text",
          text:
            "建群失败：飞书应用还没开通建群权限。需要在飞书开放平台后台给应用申请 " +
            "im:chat（建群/解散群）权限并重新发布应用版本，开通后才能建群。原始错误：" + msg,
        }],
      };
    }
    return { isError: true, content: [{ type: "text", text: `建群失败：${msg}` }] };
  }
}
