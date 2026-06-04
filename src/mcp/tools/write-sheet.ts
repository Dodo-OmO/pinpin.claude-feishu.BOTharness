// write_sheet tool——往电子表格写数据。飞书电子表格数据读写是老 v2 接口、SDK 未封装，
// 走 client.request 通用口调（自动带 token）。先用 create_cloud_doc format=sheet 建表拿 token。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";

export const writeSheetTool: Tool = {
  name: "write_sheet",
  description:
    "往电子表格写入数据（先用 create_cloud_doc format=sheet 建表拿 token）。values=二维数组（每行一个数组）。" +
    "默认从首个工作表 A1 开始；可传 sheet_id / start_cell 指定位置。",
  inputSchema: {
    type: "object",
    properties: {
      spreadsheet_token: { type: "string", description: "电子表格 token" },
      values: {
        type: "array",
        description: '二维数组，如 [["姓名","年龄"],["小明",18]]',
        items: { type: "array" },
      },
      sheet_id: { type: "string", description: "可选，工作表 id（不传=首个工作表）" },
      start_cell: { type: "string", description: "可选，起始单元格，默认 A1" },
    },
    required: ["spreadsheet_token", "values"],
  },
};

/** 列号(1-based) → 字母列名（1→A, 27→AA） */
function colToLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export async function handleWriteSheet(args: {
  spreadsheet_token: string;
  values: unknown[][];
  sheet_id?: string;
  start_cell?: string;
}) {
  try {
    const client = getFeishuClient();
    const token = args.spreadsheet_token;
    const values = args.values ?? [];
    const rows = values.length;
    const cols = rows > 0 ? Math.max(...values.map((r) => (Array.isArray(r) ? r.length : 0))) : 0;
    if (rows === 0 || cols === 0) {
      return { isError: true, content: [{ type: "text" as const, text: "values 为空（需二维数组）" }] };
    }

    // 拿 sheet_id：不传则用 v2 metainfo 取首个工作表
    let sheetId = args.sheet_id;
    if (!sheetId) {
      const meta = await client.request<{ data?: { sheets?: { sheetId?: string }[] } }>({
        method: "GET",
        url: `/open-apis/sheets/v2/spreadsheets/${token}/metainfo`,
      });
      sheetId = meta?.data?.sheets?.[0]?.sheetId;
      if (!sheetId) return { isError: true, content: [{ type: "text" as const, text: "拿不到工作表 id（确认 token 对、有权限）" }] };
    }

    // 算完整 range（飞书要求 range >= 数据范围）
    const start = (args.start_cell || "A1").toUpperCase();
    const m = start.match(/^([A-Z]+)(\d+)$/);
    const startCol = m ? m[1] : "A";
    const startRow = m ? parseInt(m[2], 10) : 1;
    const startColNum = startCol.split("").reduce((a, c) => a * 26 + (c.charCodeAt(0) - 64), 0);
    const range = `${sheetId}!${startCol}${startRow}:${colToLetter(startColNum + cols - 1)}${startRow + rows - 1}`;

    const res = await client.request<{ code?: number; msg?: string }>({
      method: "PUT",
      url: `/open-apis/sheets/v2/spreadsheets/${token}/values`,
      data: { valueRange: { range, values } },
    });
    if (res?.code !== undefined && res.code !== 0) {
      return { isError: true, content: [{ type: "text" as const, text: `写表格失败：code=${res.code} msg=${res.msg}` }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, range, rows, cols }) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `写表格失败：${msg}` }] };
  }
}
