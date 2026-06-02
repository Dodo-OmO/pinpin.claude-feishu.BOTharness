// read_pushed_news_urls tool（MCP 版）
// 阶段 4 批次 2 步骤 2.1：news-agent 调，拿 vault\品品work\早报\已推送.md 近 30 天的 URL 去重

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { getVaultRoot } from "../utils/helper.js";

const PUSHED_FILE = path.join(getVaultRoot(), "品品work", "早报", "已推送.md");

export const readPushedNewsUrlsTool: Tool = {
  name: "read_pushed_news_urls",
  description:
    "news-agent 用：读已推送过的 GitHub 项目 URL（近 N 天，默认 30 天），避免今天推重复项目。" +
    "返回 URL 字符串数组。",
  inputSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "近 N 天（默认 30）" },
    },
  },
};

export async function handleReadPushedNewsUrls(args: { days?: number }) {
  const days = args.days ?? 30;
  if (!fs.existsSync(PUSHED_FILE)) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ urls: [] }) }] };
  }
  try {
    const content = fs.readFileSync(PUSHED_FILE, "utf-8");
    const lines = content.split("\n");
    const cutoffMs = Date.now() - days * 24 * 3600 * 1000;
    const urls: string[] = [];
    // 简单格式：每行 "YYYY-MM-DD https://github.com/..."
    for (const line of lines) {
      const m = line.match(/^(\d{4}-\d{2}-\d{2})\s+(https?:\/\/\S+)/);
      if (!m) continue;
      const lineMs = Date.parse(m[1] + "T00:00:00");
      if (lineMs >= cutoffMs) urls.push(m[2]);
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ urls, count: urls.length }) }],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `读已推送 URL 失败：${msg}` }],
    };
  }
}
