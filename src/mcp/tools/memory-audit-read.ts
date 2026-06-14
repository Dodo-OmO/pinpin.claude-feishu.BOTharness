// memory_audit_read tool（MCP 版）
// 阶段 4 批次 2 步骤 2.4：memory-audit-agent 调，拿 50 条永存记忆 + 最近 7 天对话节选

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import { readChatLog } from "../utils/chat-log.js";
import { MEMORY_FILE } from "../utils/memory.js";

export const memoryAuditReadTool: Tool = {
  name: "memory_audit_read",
  description:
    "拿当前 50 条永存记忆全文 + 最近 7 天对话日志节选（按 chat 聚合）。" +
    "sub-agent 拿到后推理判定哪些条目要 update / merge / delete，再调 memory_rewrite tool 写盘。",
  inputSchema: { type: "object", properties: {} },
};

export async function handleMemoryAuditRead() {
  let memoryContent = "";
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      memoryContent = fs.readFileSync(MEMORY_FILE, "utf-8");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `读永存记忆失败：${msg}` }] };
  }
  // 最近 7 天对话（所有 chat）
  const chatLogs = readChatLog({ days: 7 });
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            memory_content: memoryContent,
            memory_lines: memoryContent.split("\n").length,
            chat_logs_recent_7d: chatLogs,
            chat_count: Object.keys(chatLogs).length,
          },
          null,
          2
        ),
      },
    ],
  };
}
