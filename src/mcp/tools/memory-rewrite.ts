// memory_rewrite tool（MCP 版）
// 阶段 4 批次 2 步骤 2.4：memory-audit-agent 调写永存记忆
// **三重保护**（从 SDK runMemoryAudit 继承）：
//   ①备份：写前先 copy 当前文件到 备份/永存记忆-自动备份-YYYY-MM-DD.md
//   ②大小校验：新内容 byte 长度不能 < 旧内容 50%（防止 sub-agent 误输出空/极短内容）
//   ③行数校验：必须恰好 50 行（永存记忆协议固定 50 条）
// 任一校验失败 → 不写主文件 + 返 isError + send_private_message 私聊Owner告警

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { dateYYYYMMDD, getVaultRoot } from "../utils/helper.js";

const MEMORY_ROOT = path.join(getVaultRoot(), "记忆系统");
const MEMORY_FILE = path.join(MEMORY_ROOT, "永存记忆50条.md");
const BACKUP_DIR = path.join(MEMORY_ROOT, "备份");

// 大小阈值：新内容 byte 不得 < 旧 50%（极宽松，防完全失误，不挡正常增删）
const MIN_SIZE_RATIO = 0.5;
// 永存记忆固定 50 条（协议 #26）
const EXPECTED_LINES = 50;

export const memoryRewriteTool: Tool = {
  name: "memory_rewrite",
  description:
    "memory-audit-agent 用：用新内容（必须恰好 50 行）重写 永存记忆50条.md。" +
    "内部三重保护：先备份 → 大小校验（新内容 byte ≥ 旧 50%）→ 行数校验（必须 50 行）。" +
    "任一校验失败回滚 + 返 isError，主 session 收到 isError 应 send_private_message 私聊Owner告警。",
  inputSchema: {
    type: "object",
    properties: {
      new_content: { type: "string", description: "新的 50 条永存记忆全文（必须恰好 50 行）" },
      summary: { type: "string", description: "本周改动摘要（写到 vault\\记忆系统\\记忆自检\\YYYY-WW.md 的 sub-agent 用）" },
    },
    required: ["new_content"],
  },
};

export async function handleMemoryRewrite(args: { new_content: string; summary?: string }) {
  const { new_content } = args;

  // 行数校验①
  const newLines = new_content.split("\n").filter((l) => l.trim().length > 0).length;
  if (newLines !== EXPECTED_LINES) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `行数校验失败：期望 ${EXPECTED_LINES} 行非空内容，实际 ${newLines} 行。请补齐/精简到正好 ${EXPECTED_LINES} 条后重试。`,
        },
      ],
    };
  }

  // 大小校验②
  let oldContent = "";
  if (fs.existsSync(MEMORY_FILE)) {
    try {
      oldContent = fs.readFileSync(MEMORY_FILE, "utf-8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text" as const, text: `读原永存记忆失败：${msg}` }] };
    }
  }
  const oldSize = Buffer.byteLength(oldContent, "utf-8");
  const newSize = Buffer.byteLength(new_content, "utf-8");
  if (oldSize > 0 && newSize < oldSize * MIN_SIZE_RATIO) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `大小校验失败：新内容 ${newSize} byte < 旧内容 ${oldSize} byte 的 ${MIN_SIZE_RATIO * 100}%。怀疑误输出空内容，已拒绝写盘保护记忆。`,
        },
      ],
    };
  }

  // 备份③（写盘前先备份）
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    if (fs.existsSync(MEMORY_FILE)) {
      const backupPath = path.join(BACKUP_DIR, `永存记忆-自动备份-${dateYYYYMMDD()}.md`);
      fs.copyFileSync(MEMORY_FILE, backupPath);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `备份失败（已拒绝写主文件保护数据）：${msg}` }] };
  }

  // 三校验全过 → 写盘
  try {
    fs.writeFileSync(MEMORY_FILE, new_content, "utf-8");
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            written: true,
            old_size: oldSize,
            new_size: newSize,
            line_count: newLines,
            summary: args.summary ?? "",
          }),
        },
      ],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `写永存记忆失败：${msg}` }] };
  }
}
