// 永存记忆 50 条——单文件全局，不按 chat 分目录
// 从 早期版本 src/utils/memory.ts 整体搬迁，去掉 SDK 依赖（本来就没有）
//
// 单一文件 vault\记忆系统\永存记忆50条.md（v10.0 起从 vault 根迁入），固定 50 行，每行：
//   `NN. YYYY-MM-DD ｜ 内容（≤50字目标 / 80字硬上限）` 或 `NN. （空）`
//
// 注入机制：supervisor spawn 频道 CLI 前调 loadMemoryBlock(vaultRoot) 拼进 --append-system-prompt-file。
// 当日 mempin 写盘后不刷新——下次重启注入（已知退化点）。loadMemoryBlock 接 vaultRoot 参数
// （supervisor 进程调用，不依赖 MCP 进程的 MEMORY_FILE 顶层常量）；writeMemoryLine 仍用 MEMORY_FILE（MCP 进程侧）。
//
// 写入：MCP server pinpin_memorize tool handler 接收 decision/index/content 三参数后调
// writeMemoryLine 直接覆盖第 N 行。decision="skip" 跳过；decision="write" 必带 index+content。
// （早期版本"替换"和"并入"二分对 server 端无区别，阶段 3 批 2 统一简化为 write）

import fs from "node:fs";
import path from "node:path";
import { pad2, dateYYYYMMDD as todayDateStr, getVaultRoot } from "./helper.js";

export const MEMORY_FILE = path.join(getVaultRoot(), "记忆系统/永存记忆50条.md");

const DEFAULT_HEADER = `# 品品的永存记忆 50 条
> 50 条上限，写满替换/并入。每条 ≤80 字（软目标 50 字、碎片化只留关键点）。NN. YYYY-MM-DD ｜ 内容。Owner可在 OB 手改任意行。

`;

/**
 * 读现有文件的"头"部分（# 标题 + 引用注释段，直到第一个 NN. 行之前）。
 * 文件不存在/没有头时返回 DEFAULT_HEADER。
 * 用于 writeMemoryLine 时保留Owner在 OB 手改过的注释。
 */
function readHeaderOrDefault(): string {
  let raw = "";
  try {
    raw = fs.readFileSync(MEMORY_FILE, "utf-8");
  } catch {
    return DEFAULT_HEADER;
  }
  const firstEntryMatch = raw.match(/^\d{1,2}\.\s/m);
  if (!firstEntryMatch || firstEntryMatch.index === undefined) {
    return DEFAULT_HEADER;
  }
  const head = raw.slice(0, firstEntryMatch.index);
  return head.length > 0 ? head : DEFAULT_HEADER;
}

const MEMORY_CAPACITY = 50;
const MEMORY_CONTENT_MAX = 80; // 每条正文极端兜底上限（不含日期）。50 字是软目标，80 字硬兜底。
const EMPTY_MARK = "（空）";

interface MemoryLine {
  index: number;       // 1-based, 1..50
  date: string | null; // YYYY-MM-DD or null when empty
  content: string;     // 正文 or EMPTY_MARK
}

/**
 * 读 50 行记忆。文件不存在/缺行时按空位补齐。
 * 严格保证返回 50 条。
 */
function loadMemoryLines(vaultRoot?: string): MemoryLine[] {
  const memFile = vaultRoot ? path.join(vaultRoot, "记忆系统/永存记忆50条.md") : MEMORY_FILE;
  const lines: MemoryLine[] = [];
  let raw = "";
  try {
    raw = fs.readFileSync(memFile, "utf-8");
  } catch (e) {
    process.stderr.write(
      `[memory] 读取 ${memFile} 失败,按全空处理: ${e instanceof Error ? e.message : e}\n`,
    );
  }

  // 形如 "01. 2026-04-25 ｜ 内容"  或  "01. （空）"
  const lineRegex = /^(\d{1,2})\.\s*(?:(\d{4}-\d{2}-\d{2})\s*｜\s*(.*)|（空）)\s*$/;
  const found = new Map<number, MemoryLine>();
  for (const ln of raw.split(/\r?\n/)) {
    const m = ln.match(lineRegex);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    if (idx < 1 || idx > MEMORY_CAPACITY) continue;
    if (m[2]) {
      found.set(idx, { index: idx, date: m[2], content: m[3].trim() });
    } else {
      found.set(idx, { index: idx, date: null, content: EMPTY_MARK });
    }
  }
  for (let i = 1; i <= MEMORY_CAPACITY; i++) {
    lines.push(found.get(i) ?? { index: i, date: null, content: EMPTY_MARK });
  }
  return lines;
}

/**
 * 拼成注入 systemPrompt 的记忆块。
 * 空位收紧——非空条目列出，空位汇总成一行 `空位: 01, 06, ...`
 * 50 条全空时省 30+ 行 ≈ 90 tokens/轮。
 */
export function loadMemoryBlock(vaultRoot?: string): string {
  const lines = loadMemoryLines(vaultRoot);
  const filled = lines.filter((l) => l.date);
  const emptyIndices = lines.filter((l) => !l.date).map((l) => pad2(l.index));
  const listing = filled
    .map((l) => `${pad2(l.index)}. ${l.date} ｜ ${l.content}`)
    .join("\n");
  const emptySummary = emptyIndices.length > 0
    ? `\n空位: ${emptyIndices.join(", ")}（可新增于此）`
    : "";

  return `

---
【你的永存记忆 50 条】

${listing}${emptySummary}

平时说话命中清单内容自然带出来用,别说"我记忆里有"。
忘了某事就说想不起来,Owner会让你 grep 对话记录(协议 5)。
mempin 段判断标准 → vault\\CLAUDE.md〔你的永存记忆 50 条〕。
人物的稳定信息/偏好/内梗 → Edit 记忆系统\\人物\\<人>.md，别写这 50 条。`;
}

/**
 * 覆盖第 index 行（1-based, 1..50）。
 * - content 自动 trim + 截断到 MEMORY_CONTENT_MAX 字
 * - date 用今天
 * - 越界 / 空 content 直接拒，返回 false
 *
 * EBUSY 重试——OB 偶尔锁文件。
 */
export async function writeMemoryLine(index: number, content: string): Promise<boolean> {
  if (!Number.isInteger(index) || index < 1 || index > MEMORY_CAPACITY) {
    process.stderr.write(`[memory] writeMemoryLine 越界: index=${index}\n`);
    return false;
  }
  let trimmed = content.trim();
  // 防双时间码：品品偶尔在 [mempin-content] 段把已有日期前缀抄进来
  trimmed = trimmed.replace(/^\d{4}-\d{2}-\d{2}\s*[｜|]\s*/, "");
  if (!trimmed) {
    process.stderr.write(`[memory] writeMemoryLine 空内容,跳过\n`);
    return false;
  }
  if (trimmed.length > 50) {
    // 超 50 字仅警告（碎片化软规则违反）但仍写入完整内容——避免半截记忆丢表意
    process.stderr.write(
      `[memory] 第 ${index} 条超 50 字软目标(${trimmed.length}字),仍写入完整内容；建议下次精炼\n`,
    );
  }
  if (trimmed.length > MEMORY_CONTENT_MAX) {
    process.stderr.write(
      `[memory] 第 ${index} 条超 ${MEMORY_CONTENT_MAX} 字硬兜底(${trimmed.length}),截断\n`,
    );
    trimmed = Array.from(trimmed).slice(0, MEMORY_CONTENT_MAX).join(""); // 码点安全：按 Unicode 码点截断，emoji/码点对不被切半（参 reply-quote.ts）
  }
  const lines = loadMemoryLines();
  lines[index - 1] = { index, date: todayDateStr(), content: trimmed };

  // 保留Owner可能在 OB 手改过的文件头（# 标题 + 引用注释段）
  const header = readHeaderOrDefault();
  const body = lines
    .map((l) =>
      l.date
        ? `${pad2(l.index)}. ${l.date} ｜ ${l.content}`
        : `${pad2(l.index)}. （空）`,
    )
    .join("\n");
  const fileContent = header + body + "\n";

  // EBUSY 重试
  const delays = [50, 100, 150];
  for (let i = 0; i <= delays.length; i++) {
    try {
      const dir = path.dirname(MEMORY_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(MEMORY_FILE, fileContent, "utf-8");
      process.stderr.write(`[memory] 写入第 ${index} 条: ${trimmed}\n`);
      return true;
    } catch (e) {
      if (i === delays.length) {
        process.stderr.write(
          `[memory] writeMemoryLine 失败 (${delays.length + 1} 次): ${e instanceof Error ? e.message : e}\n`,
        );
        return false;
      }
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
  return false;
}
