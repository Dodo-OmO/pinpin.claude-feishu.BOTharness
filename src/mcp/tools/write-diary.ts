// write_diary tool（MCP 版）
// 阶段 4 批次 2 步骤 2.5：日记 sub-agent 调，写到 vault\记忆系统\日记\YYYY-MM\YYYY-MM-DD.md

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { getVaultRoot } from "../utils/helper.js";

const DIARY_ROOT = path.join(getVaultRoot(), "记忆系统", "日记");

export const writeDiaryTool: Tool = {
  name: "write_diary",
  description:
    "写当日日记到 vault\\记忆系统\\日记\\YYYY-MM\\YYYY-MM-DD.md。" +
    "调用约定：yyyy_mm_dd 是日记目标日期（不是写盘当天）；content 是 markdown 全文。" +
    "已存在文件 → 用 ## [追加 HH:MM] 标题块追加（不覆盖原内容）。",
  inputSchema: {
    type: "object",
    properties: {
      yyyy_mm_dd: { type: "string", description: "日记目标日期 YYYY-MM-DD" },
      content: { type: "string", description: "日记 markdown 全文" },
    },
    required: ["yyyy_mm_dd", "content"],
  },
};

export async function handleWriteDiary(args: { yyyy_mm_dd: string; content: string }) {
  const { yyyy_mm_dd, content } = args;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyy_mm_dd)) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `yyyy_mm_dd 格式错（应 YYYY-MM-DD）：${yyyy_mm_dd}` }],
    };
  }
  const month = yyyy_mm_dd.slice(0, 7);
  const monthDir = path.join(DIARY_ROOT, month);
  if (!fs.existsSync(monthDir)) fs.mkdirSync(monthDir, { recursive: true });
  const filePath = path.join(monthDir, `${yyyy_mm_dd}.md`);
  try {
    if (fs.existsSync(filePath)) {
      const hhmm = new Date().toTimeString().slice(0, 5);
      fs.appendFileSync(filePath, `\n\n## [追加 ${hhmm}]\n${content.trim()}\n`, "utf-8");
    } else {
      fs.writeFileSync(filePath, content, "utf-8");
    }
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ written: true, path: filePath }) },
      ],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `写日记失败：${msg}` }],
    };
  }
}
