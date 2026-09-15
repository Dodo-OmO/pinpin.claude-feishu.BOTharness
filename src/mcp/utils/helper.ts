// 通用小函数集合——日期 / 字符串 / 文件名安全化
// 从 早期版本 src/utils/helper.ts 整体搬迁，无改动

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 确保目录存在（不存在则递归创建） */
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 数字补 2 位前导 0——普遍用于 月/日/时分秒 拼接 */
export const pad2 = (n: number): string => n.toString().padStart(2, "0");

/** YYYY-MM-DD（默认今天） */
export function dateYYYYMMDD(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** YYYY-MM（默认今月）—— vault 月份目录用 */
export function dateYYYYMM(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** HH:MM（默认现在）—— 对话日志行内时间戳 */
export function timeHHMM(d: Date = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 文件名安全化：替换路径/特殊字符 + 控制字符，码点安全截断 80 字，空值兜底 "unnamed" */
export function safeName(name: string): string {
  const cleaned = (name || "unnamed")
    .replace(/[\\/:*?"<>|\r\n\t\x00]/g, "_");
  return Array.from(cleaned).slice(0, 80).join("") || "unnamed";
}

let vaultFromEnvFile: string | undefined;

/** vault 根目录——优先 env（PINPIN_VAULT_DIR / BASE_PROJECT_DIR，子进程加载 .env 后有值）；
 *  env 皆空（Electron 主进程 import 期 dotenv 还没跑）→ 从本文件往上找代码包 .env 直读 BASE_PROJECT_DIR。
 *  不写死盘符（根目录会随 NAS 变）。**绝不抛异常**（事故：批F 改 throw 后主进程 getVaultRoot 崩、启动器打不开）。 */
export function getVaultRoot(): string {
  const v = process.env.PINPIN_VAULT_DIR ?? process.env.BASE_PROJECT_DIR;
  if (v) return v;
  if (vaultFromEnvFile === undefined) {
    vaultFromEnvFile = "";
    for (let d = path.dirname(fileURLToPath(import.meta.url)); ; d = path.dirname(d)) {
      try {
        const m = fs.readFileSync(path.join(d, ".env"), "utf8").match(/^BASE_PROJECT_DIR=(.+)$/m);
        if (m) {
          vaultFromEnvFile = m[1].trim().replace(/^(["'])(.*)\1$/, "$2");
          break;
        }
      } catch {
        /* 本层没有 .env，继续往上 */
      }
      if (path.dirname(d) === d) break;
    }
  }
  return vaultFromEnvFile || process.cwd();
}

/** ISO 8601 周数 + 年份——给永存记忆自检文件命名用。
 *  要该周归哪个月目录 → 用 isoWeekToMonth(year, week)（两者同一套算法）。 */
export function getISOWeek(d: Date = new Date()): { year: number; week: number } {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const diff = target.getTime() - firstThursday.getTime();
  const week = 1 + Math.round(diff / (7 * 24 * 60 * 60 * 1000));
  return { year: target.getFullYear(), week };
}

/** 从任意 ISO (year, week) 反推该周周四所在月（YYYY-MM）——复用 getISOWeek 同一套算法：
 *  取该年 Jan4 所在周的周一，加 (week-1)*7+3 天 = 目标周周四。 */
export function isoWeekToMonth(year: number, week: number): string {
  const jan4 = new Date(year, 0, 4);
  const jan4DayNr = (jan4.getDay() + 6) % 7;
  const week1Monday = new Date(jan4.valueOf());
  week1Monday.setDate(jan4.getDate() - jan4DayNr);
  const thursday = new Date(week1Monday.valueOf());
  thursday.setDate(week1Monday.getDate() + (week - 1) * 7 + 3);
  return dateYYYYMM(thursday);
}
