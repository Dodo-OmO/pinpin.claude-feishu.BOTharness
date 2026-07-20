// read_attachment tool——读非图片附件的文本内容（xlsx/docx/csv/txt/md/json 等）。
// 起因：品品 Read 工具不解析 xlsx/docx 二进制，群里发来的表格/文档读不了。
// xlsx→exceljs 各表转文本；docx→mammoth 抽正文；纯文本直读；图片/pdf 引导用 Read。

import fs from "node:fs";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// 单次输出上限——防超大表/长文档把上下文撑爆（约 40k 字符≈1.3 万 token）。
const MAX_OUT = 40_000;

export const readAttachmentTool: Tool = {
  name: "read_attachment",
  description:
    "读附件文本内容。支持 .xlsx/.xlsm（各表转文本）、.docx（正文）、.csv/.tsv/.txt/.md/.json/.log（直读）。" +
    "图片/PDF 请改用 Read 工具。path = 本地文件绝对路径。",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "本地文件绝对路径" },
    },
    required: ["path"],
  },
};

function clip(text: string): string {
  if (text.length <= MAX_OUT) return text;
  return text.slice(0, MAX_OUT) + `\n\n…（内容超 ${MAX_OUT} 字符已截断，需要看后续可指明读某张表/某段）`;
}

async function readXlsx(filePath: string): Promise<string> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const out: string[] = [];
  wb.eachSheet((ws) => {
    const lines: string[] = [`# 表「${ws.name}」`];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = (row.values as unknown[]).slice(1).map((v) => {
        if (v == null) return "";
        if (typeof v === "object") {
          const o = v as { text?: string; result?: unknown; hyperlink?: string };
          return String(o.text ?? o.result ?? o.hyperlink ?? "");
        }
        return String(v);
      });
      lines.push(cells.join("\t"));
    });
    out.push(lines.join("\n"));
  });
  return out.join("\n\n") || "（空工作簿）";
}

async function readDocx(filePath: string): Promise<string> {
  const mammoth = await import("mammoth");
  const res = await mammoth.extractRawText({ path: filePath });
  return res.value || "（空文档）";
}

export async function handleReadAttachment(args: { path: string }) {
  const filePath = args.path;
  try {
    if (!fs.existsSync(filePath)) {
      return { isError: true, content: [{ type: "text" as const, text: `文件不存在：${filePath}` }] };
    }
    const ext = path.extname(filePath).toLowerCase();
    let text: string;
    if (ext === ".xlsx" || ext === ".xlsm") {
      text = await readXlsx(filePath);
    } else if (ext === ".docx") {
      text = await readDocx(filePath);
    } else if ([".csv", ".tsv", ".txt", ".md", ".json", ".log", ".xml", ".yaml", ".yml"].includes(ext)) {
      text = fs.readFileSync(filePath, "utf-8");
    } else if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf"].includes(ext)) {
      return { content: [{ type: "text" as const, text: `${ext} 是图片/PDF，请直接用 Read 工具看：${filePath}` }] };
    } else {
      return {
        content: [{ type: "text" as const, text: `不认识的格式 ${ext}，试试 Read 工具直接读：${filePath}` }],
      };
    }
    return { content: [{ type: "text" as const, text: clip(text) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `读附件失败：${msg}` }] };
  }
}
