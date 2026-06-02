// read_briefing_tasks tool（MCP 版）
// 阶段 4 批次 2 步骤 2.2：daily-briefing-agent 调，读 vault\豆work\ 任务文件返回结构化任务列表

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { getVaultRoot } from "../utils/helper.js";

const TASKS_ROOT = path.join(getVaultRoot(), "豆work");

export const readBriefingTasksTool: Tool = {
  name: "read_briefing_tasks",
  description:
    "daily-briefing-agent 用：读 vault\\豆work\\ 目录下所有任务 .md 文件原文，返回 { 文件路径 → 内容 } 字典。" +
    "sub-agent 自己推理筛选今天值得提醒的任务。",
  inputSchema: { type: "object", properties: {} },
};

export async function handleReadBriefingTasks() {
  if (!fs.existsSync(TASKS_ROOT)) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ files: {}, hint: `${TASKS_ROOT} 不存在` }) }],
    };
  }
  const files: Record<string, string> = {};
  // 递归遍历 .md 文件
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith(".md")) {
        try {
          const rel = path.relative(TASKS_ROOT, full);
          files[rel] = fs.readFileSync(full, "utf-8");
        } catch {
          /* 忽略读不了的 */
        }
      }
    }
  };
  try {
    walk(TASKS_ROOT);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `读 豆work 失败：${msg}` }] };
  }
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ files, count: Object.keys(files).length }) },
    ],
  };
}
