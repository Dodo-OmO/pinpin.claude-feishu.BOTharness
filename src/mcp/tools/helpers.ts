/**
 * 辅助 2 tool —— resolve_open_id / archive_search
 *
 * - resolve_open_id：从人名/别名反查飞书 open_id（known_users 表）
 * - archive_search：翻 vault 对话记录档案（基于 grep 简单封装）
 */

import fs from "node:fs";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveOpenId, listKnownUsers } from "../db/database.js";
import { getVaultRoot } from "../utils/helper.js";

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

// ───────────────────────────────────────────────────────────
// archive_search
// ───────────────────────────────────────────────────────────

export const ARCHIVE_SEARCH_TOOL: Tool = {
  name: "archive_search",
  description:
    "翻 vault 对话记录档案找历史聊天内容。chat_name 限定到某 chat 目录（不传搜所有 chat）；" +
    "days_back 限定时间范围（默认 7 天）；keyword 必填。返回命中的日期文件清单 + 部分匹配片段。",
  inputSchema: {
    type: "object",
    properties: {
      keyword: { type: "string", description: "搜索关键词" },
      chat_name: { type: "string", description: "（可选）chat 友好名（如『废话茶水间』），限定搜索范围" },
      days_back: { type: "number", description: "（可选）搜近 N 天（默认 30）" },
    },
    required: ["keyword"],
  },
};

const LOG_ROOT = path.join(getVaultRoot(), "对话记录");

export async function handleArchiveSearch(args: {
  keyword: string;
  chat_name?: string;
  days_back?: number;
}): Promise<ToolResult> {
  const keyword = args.keyword.trim();
  if (!keyword) return textErr("keyword 不能为空");
  const daysBack = args.days_back ?? 30;
  const cutoff = Date.now() - daysBack * 86400_000;

  try {
    const chatDirs = args.chat_name
      ? [path.join(LOG_ROOT, args.chat_name)]
      : fs.existsSync(LOG_ROOT)
        ? fs
            .readdirSync(LOG_ROOT)
            .map((n) => path.join(LOG_ROOT, n))
            .filter((p) => fs.statSync(p).isDirectory())
        : [];

    const hits: { file: string; chat: string; lines: string[] }[] = [];
    for (const dir of chatDirs) {
      if (!fs.existsSync(dir)) continue;
      const chatName = path.basename(dir);
      // 月目录 YYYY-MM
      for (const monthDir of fs.readdirSync(dir).map((n) => path.join(dir, n))) {
        if (!fs.statSync(monthDir).isDirectory()) continue;
        for (const file of fs.readdirSync(monthDir)) {
          if (!file.endsWith(".md")) continue;
          const fp = path.join(monthDir, file);
          const st = fs.statSync(fp);
          if (st.mtimeMs < cutoff) continue;
          try {
            const content = fs.readFileSync(fp, "utf-8");
            const matched = content
              .split(/\r?\n/)
              .filter((l) => l.toLowerCase().includes(keyword.toLowerCase()));
            if (matched.length > 0) {
              hits.push({
                file: file.replace(/\.md$/, ""),
                chat: chatName,
                lines: matched.slice(0, 5), // 每文件最多 5 行片段
              });
            }
          } catch {
            /* 跳过读失败 */
          }
        }
      }
    }
    if (hits.length === 0) {
      return textOk(`没找到含「${keyword}」的对话记录（搜了近 ${daysBack} 天${args.chat_name ? `的「${args.chat_name}」` : "所有 chat"}）。`);
    }
    const summary = hits
      .slice(0, 20) // 最多 20 个文件
      .map((h) => `📅 ${h.chat}/${h.file}\n  ${h.lines.map((l) => l.trim().slice(0, 100)).join("\n  ")}`)
      .join("\n\n");
    const more = hits.length > 20 ? `\n\n…还有 ${hits.length - 20} 个文件命中（缩窄 chat_name 或日期范围再搜）` : "";
    return textOk(`找到 ${hits.length} 个含「${keyword}」的对话记录文件：\n\n${summary}${more}`);
  } catch (e) {
    return textErr(`翻档案失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
