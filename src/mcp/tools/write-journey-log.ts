// write_journey_log tool（MCP 版）
// 阶段 4 批次 2 步骤 2.5：自由活动游历/外出学习等结束时写台账
// 滚动 20 条（最多保留 20 行，超出删最旧）

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { dateYYYYMMDD, timeHHMM, getVaultRoot } from "../utils/helper.js";

const JOURNEY_FILE = path.join(getVaultRoot(), "品品work", "游历", "自由活动台账.md");
const MAX_ROWS = 20;

export const writeJourneyLogTool: Tool = {
  name: "write_journey_log",
  description:
    "自由活动 / 外出学习 / 网上冲浪 等活动结束时记一笔台账（滚动 20 条上限）。" +
    "格式：YYYY-MM-DD HH:MM [类型] 一句话内容。",
  inputSchema: {
    type: "object",
    properties: {
      activity_type: {
        type: "string",
        description: "活动类型（如 外出学习 / 网上冲浪 / 写作 / 发呆 等）",
      },
      content: { type: "string", description: "一句话内容（做了什么/学到什么/想到什么）" },
    },
    required: ["activity_type", "content"],
  },
};

export async function handleWriteJourneyLog(args: { activity_type: string; content: string }) {
  const { activity_type, content } = args;
  const newLine = `${dateYYYYMMDD()} ${timeHHMM()} [${activity_type}] ${content.trim()}`;
  try {
    const dir = path.dirname(JOURNEY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let existing = "";
    if (fs.existsSync(JOURNEY_FILE)) existing = fs.readFileSync(JOURNEY_FILE, "utf-8");
    const rows = existing
      .split("\n")
      .filter((l) => l.trim().length > 0);
    rows.unshift(newLine); // 新的在最上
    const kept = rows.slice(0, MAX_ROWS);
    fs.writeFileSync(JOURNEY_FILE, kept.join("\n") + "\n", "utf-8");
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ written: true, rows_total: kept.length }) },
      ],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `写游历台账失败：${msg}` }] };
  }
}
