/**
 * 辅助 tool —— resolve_open_id
 *
 * - resolve_open_id：从人名/别名反查飞书 open_id（known_users 表）
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveOpenId, listKnownUsers } from "../db/database.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const textErr = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });
const textOk = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

// ───────────────────────────────────────────────────────────
// resolve_open_id
// ───────────────────────────────────────────────────────────

export const RESOLVE_OPEN_ID_TOOL: Tool = {
  name: "resolve_open_id",
  description:
    "把人名或别名反查成飞书 open_id（圈人 / 调主动单聊 / 派任务时用）。" +
    "走 known_users 表精确+模糊匹配。匹配不到返认识的人列表。",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "人名或别名（如『Owner』『User B』『User A』）" },
    },
    required: ["name"],
  },
};

export async function handleResolveOpenId(args: { name: string }): Promise<ToolResult> {
  const id = resolveOpenId(args.name);
  if (id) {
    return textOk(`${args.name} → open_id = ${id}`);
  }
  const known = listKnownUsers().map((u) => u.name).join("、");
  return textOk(
    `没认识叫「${args.name}」的人。我目前认识：${known || "（还没记住任何人）"}。让 ta 在群里说句话我就记住了～`,
  );
}
