// write_weekly_recap tool（MCP 版）
// 阶段 4 批次 2 步骤 2.3：周回顾主 session 调（sub-agent 只收集各 chat 小结返回，主 session 写盘 + 云文档 + 私聊Owner），写到 vault\记忆系统\周回顾\YYYY-WW.md

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { getISOWeek, pad2, getVaultRoot } from "../utils/helper.js";

const RECAP_ROOT = path.join(getVaultRoot(), "记忆系统", "周回顾");

export const writeWeeklyRecapTool: Tool = {
  name: "write_weekly_recap",
  description:
    "写周回顾到 vault\\记忆系统\\周回顾\\YYYY-WW.md。" +
    "调用约定：yyyy_ww 可传（如 2026-21），不传 = 当前 ISO 周；markdown 是周回顾全文。" +
    "已存在文件 → 覆盖（周回顾每周一次，重写视为更新）。",
  inputSchema: {
    type: "object",
    properties: {
      yyyy_ww: { type: "string", description: "ISO 周如 2026-21（不传 = 本周）" },
      markdown: { type: "string", description: "周回顾 markdown 全文" },
    },
    required: ["markdown"],
  },
};

export async function handleWriteWeeklyRecap(args: { yyyy_ww?: string; markdown: string }) {
  const yww = args.yyyy_ww ?? (() => {
    const { year, week } = getISOWeek();
    return `${year}-${pad2(week)}`;
  })();
  if (!fs.existsSync(RECAP_ROOT)) fs.mkdirSync(RECAP_ROOT, { recursive: true });
  const filePath = path.join(RECAP_ROOT, `${yww}.md`);
  try {
    fs.writeFileSync(filePath, args.markdown, "utf-8");
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ written: true, path: filePath, yyyy_ww: yww }) },
      ],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `写周回顾失败：${msg}` }],
    };
  }
}
