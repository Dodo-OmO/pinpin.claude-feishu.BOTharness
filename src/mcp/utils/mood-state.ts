// 心境层（MCP 版 v2 · 2026-05-29 数据模型回炉到 早期版本人话模型）
//
// 数据模型完全照搬 早期版本 src/utils/mood-state.ts：
//   - 当前.md：人话 markdown（主导情绪 / 能量 0-100 / 对他人关系 name(val) / 活跃 moodlet / 一行独白）
//   - 流变 append-only：appraise 走三段式 ## HH:MM / 触发: / 感受: / moodlet 变化:；decay 走简短一行
//
// 跟 v1 PAD 版本的区别（Owner 2026-05-29 拍板）：
//   - 丢 PAD 三维度（p/a/d 浮点数 → 不直观）
//   - 用 primary 主导情绪文字 + energy 0-100 + monologue 独白 + bonds(name→val) —— 人类可读
//
// CLI 优雅化保留：tool handler 不调 LLM，只做写盘 + 衰减 + bonds 累加（确定性逻辑）

import fs from "node:fs";
import path from "node:path";
import { dateYYYYMMDD, dateYYYYMM, timeHHMM, getVaultRoot, ensureDir } from "./helper.js";

const MOOD_ROOT = path.join(getVaultRoot(), "记忆系统", "心境");
const CURRENT_FILE = path.join(MOOD_ROOT, "当前.md");
const TRANSITION_DIR = path.join(MOOD_ROOT, "流变");

export interface Moodlet {
  tag: string;         // 情绪标签（如 "happy" / "annoyed" / "被夸到了"）
  delta: number;       // 强度，可正可负（+5 = 偏正向 / -3 = 偏负向）
  reason: string;      // 为什么有这个 moodlet（一句话）
  ttlHours: number;    // 几小时后衰完（过期硬删）
  expiresAt: string;   // ISO datetime
}

export interface MoodState {
  primary: string;                   // 主导情绪（"平静" / "愉悦" / "烦躁" / "兴奋" / "低落" 等口语词）
  energy: number;                    // 能量 0-100
  monologue: string;                 // 一行独白（品品对自己当前状态的口语自述）
  moodlets: Moodlet[];               // 活跃 moodlet 列表（过期自动衰减）
  bonds: Record<string, number>;     // 人际关系：name → bond 强度（-100~100）
  updatedAt: string;                 // "YYYY-MM-DD HH:MM"
}

const DEFAULT_STATE: MoodState = {
  primary: "平静",
  energy: 70,
  monologue: "",
  moodlets: [],
  bonds: {},
  updatedAt: "",
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// ============== 当前.md：序列化 / 反序列化（人话 markdown） ==============

/** 序列化 MoodState → 写入文件的 markdown 字符串 */
function serializeMoodCurrent(state: MoodState): string {
  const moodletLines = state.moodlets.length === 0
    ? "  - （无）"
    : state.moodlets.map((m) =>
        `  - ${m.delta >= 0 ? "+" : ""}${m.delta} ${m.tag}: ${m.reason}, TTL ${m.ttlHours}h, expires ${m.expiresAt}`,
      ).join("\n");
  const bondsLine = Object.entries(state.bonds).length === 0
    ? "（无）"
    : Object.entries(state.bonds)
        .map(([name, val]) => `${name}(${val})`)
        .join(" | ");
  return `## 当前心境

主导情绪: ${state.primary}
能量: ${state.energy}/100
对他人的关系: ${bondsLine} （慢变量，周自检调整）
活跃 moodlet:
${moodletLines}
一行独白: ${state.monologue}
最后更新: ${state.updatedAt}
`;
}

/** 反解 markdown → MoodState（容错：缺字段用 DEFAULT_STATE 兜底） */
function parseMoodCurrent(text: string): MoodState {
  const state: MoodState = { ...DEFAULT_STATE, moodlets: [], bonds: {} };

  // 单行字段用 [ \t] 避免 \s 跨行抓到下一行（空 monologue 情况）
  const primaryMatch = text.match(/主导情绪:[ \t]*(.+)/);
  if (primaryMatch) state.primary = primaryMatch[1].trim();

  const energyMatch = text.match(/能量:[ \t]*(-?\d+)[ \t]*\/[ \t]*100/);
  if (energyMatch) state.energy = clamp(parseInt(energyMatch[1], 10), 0, 100);

  const monologueMatch = text.match(/一行独白:[ \t]*(.*)/);
  if (monologueMatch) state.monologue = monologueMatch[1].trim();

  const updatedMatch = text.match(/最后更新:[ \t]*(.+)/);
  if (updatedMatch) state.updatedAt = updatedMatch[1].trim();

  // bonds 行：name(val) | name(val) | ...
  const bondsMatch = text.match(/对他人的关系:\s*(.+?)(?:\s*（|\n)/);
  if (bondsMatch && bondsMatch[1].trim() !== "（无）") {
    const tokens = bondsMatch[1].split("|");
    for (const tok of tokens) {
      const m = tok.trim().match(/^(.+?)\((-?\d+)\)$/);
      if (m) state.bonds[m[1].trim()] = parseInt(m[2], 10);
    }
  }

  // moodlet 行：  - {+/-}{delta} {tag}: {reason}, TTL {N}h, expires {iso}
  const moodletBlockMatch = text.match(/活跃 moodlet:\s*\n([\s\S]*?)\n一行独白:/);
  if (moodletBlockMatch) {
    const lines = moodletBlockMatch[1].split("\n");
    for (const line of lines) {
      const m = line.match(/^\s*-\s*([+-]?\d+)\s+(.+?):\s*(.+?),\s*TTL\s+(\d+)h,\s*expires\s+(.+)$/);
      if (m) {
        state.moodlets.push({
          delta: parseInt(m[1], 10),
          tag: m[2].trim(),
          reason: m[3].trim(),
          ttlHours: parseInt(m[4], 10),
          expiresAt: m[5].trim(),
        });
      }
    }
  }

  return state;
}

function readMoodCurrent(): MoodState {
  if (!fs.existsSync(CURRENT_FILE)) return { ...DEFAULT_STATE };
  try {
    return parseMoodCurrent(fs.readFileSync(CURRENT_FILE, "utf-8"));
  } catch (e) {
    process.stderr.write(`[mood-state] 读 当前.md 失败: ${e instanceof Error ? e.message : e}\n`);
    return { ...DEFAULT_STATE };
  }
}

function writeMoodCurrent(state: MoodState): void {
  try {
    ensureDir(MOOD_ROOT);
    const stamped: MoodState = { ...state, updatedAt: `${dateYYYYMMDD()} ${timeHHMM()}` };
    fs.writeFileSync(CURRENT_FILE, serializeMoodCurrent(stamped), "utf-8");
  } catch (e) {
    process.stderr.write(`[mood-state] 写 当前.md 失败: ${e instanceof Error ? e.message : e}\n`);
  }
}

// ============== 流变 append-only ==============

interface MoodTransition {
  time: string;          // HH:MM
  trigger: string;       // 一行场景描述
  feeling: string;       // 一行内心独白
  moodletChange: string; // "+N happy, TTL 4h" 或 "（无变化）"
}

/** appraise 走三段式 markdown */
function appendAppraisalTransition(t: MoodTransition): void {
  const monthSub = dateYYYYMM();
  const dayFile = `${dateYYYYMMDD()}.md`;
  const dir = path.join(TRANSITION_DIR, monthSub);
  const file = path.join(dir, dayFile);
  const block = `\n## ${t.time}\n触发: ${t.trigger}\n感受: ${t.feeling}\nmoodlet 变化: ${t.moodletChange}\n`;
  try {
    ensureDir(dir);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `# 心境流变 · ${dateYYYYMMDD()}\n${block}`, "utf-8");
    } else {
      fs.appendFileSync(file, block, "utf-8");
    }
  } catch (e) {
    process.stderr.write(`[mood-state] 写流变失败: ${e instanceof Error ? e.message : e}\n`);
  }
}

/** decay 走简短一行（不三段式 — 早期版本 console.log 风格） */
function appendDecayLine(remaining: number): void {
  const monthSub = dateYYYYMM();
  const dayFile = `${dateYYYYMMDD()}.md`;
  const dir = path.join(TRANSITION_DIR, monthSub);
  const file = path.join(dir, dayFile);
  const line = `${timeHHMM()} [decay] 活跃 moodlet ${remaining} 条\n`;
  try {
    ensureDir(dir);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `# 心境流变 · ${dateYYYYMMDD()}\n\n${line}`, "utf-8");
    } else {
      fs.appendFileSync(file, line, "utf-8");
    }
  } catch (e) {
    process.stderr.write(`[mood-state] 写 decay 流变失败: ${e instanceof Error ? e.message : e}\n`);
  }
}

// ============== 衰减 / 评估 / 读取 ==============

/** 衰减所有 moodlets：过期硬删（expiresAt < now）。返回更新后的 state */
export function decayMoodlets(): MoodState {
  const state = readMoodCurrent();
  if (state.moodlets.length === 0) return state;
  const now = Date.now();
  const before = state.moodlets.length;
  state.moodlets = state.moodlets.filter((m) => {
    const exp = new Date(m.expiresAt).getTime();
    return !isNaN(exp) && exp > now;
  });
  const removed = before - state.moodlets.length;
  if (removed > 0) {
    writeMoodCurrent(state);
    appendDecayLine(state.moodlets.length);
  }
  return state;
}

export interface AppraiseInput {
  chat_id: string;
  primary?: string;                  // 新主导情绪（覆盖）
  energy_delta?: number;             // 能量变化 -100~100（累加 clamp 0-100）
  monologue?: string;                // 新独白（覆盖）
  trigger?: string;                  // 流变记录：一行场景描述
  feeling?: string;                  // 流变记录：一行内心独白
  new_moodlets?: Array<{ tag: string; delta: number; reason: string; ttlHours: number }>;
  bonds_delta?: { name: string; delta: number };
}

/** 主 session 收到 mood-appraise trigger 后调本函数 */
export function appraiseMood(input: AppraiseInput): MoodState {
  const state = readMoodCurrent();
  const now = Date.now();

  if (input.primary !== undefined) state.primary = input.primary;
  if (input.energy_delta !== undefined) {
    state.energy = clamp(state.energy + input.energy_delta, 0, 100);
  }
  if (input.monologue !== undefined) state.monologue = input.monologue;

  if (input.new_moodlets) {
    for (const m of input.new_moodlets) {
      const ttl = Math.max(0.1, m.ttlHours);
      const expiresAt = new Date(now + ttl * 3600000).toISOString();
      state.moodlets.push({
        tag: m.tag,
        delta: m.delta,
        reason: m.reason,
        ttlHours: ttl,
        expiresAt,
      });
    }
  }

  if (input.bonds_delta) {
    const cur = state.bonds[input.bonds_delta.name] ?? 0;
    state.bonds[input.bonds_delta.name] = clamp(cur + input.bonds_delta.delta, -100, 100);
  }

  writeMoodCurrent(state);

  const moodletChange = input.new_moodlets && input.new_moodlets.length > 0
    ? input.new_moodlets
        .map((m) => `${m.delta >= 0 ? "+" : ""}${m.delta} ${m.tag}, TTL ${m.ttlHours}h`)
        .join("; ")
    : "（无变化）";
  appendAppraisalTransition({
    time: timeHHMM(),
    trigger: input.trigger ?? `chat=${input.chat_id}`,
    feeling: input.feeling ?? state.monologue ?? "（未填）",
    moodletChange,
  });

  return state;
}

export function getCurrentMood(): MoodState {
  return readMoodCurrent();
}
