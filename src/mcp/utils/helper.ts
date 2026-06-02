// 通用小函数集合——日期 / 字符串 / 文件名安全化
// 从 早期版本 src/utils/helper.ts 整体搬迁，无改动

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

/** 文件名安全化：替换 Windows/Linux 不允许的字符 */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

/** vault 根目录——优先 env（PINPIN_VAULT_DIR / BASE_PROJECT_DIR，子进程加载 .env 后有值），
 *  最终回退硬编码默认。**绝不抛异常**：Electron 主进程不加载 .env，env 皆空时若 throw 会崩启动器
 *  （事故：批F 改 throw 后主进程 getVaultRoot 崩、启动器打不开）。硬编码兜底保证任何进程上下文都能起。 */
export function getVaultRoot(): string {
  return process.env.PINPIN_VAULT_DIR ?? process.env.BASE_PROJECT_DIR ?? "/path/to/obsidian-vault";
}

/** ISO 8601 周数 + 年份——给永存记忆自检 / 周回顾文件命名用 */
export function getISOWeek(d: Date = new Date()): { year: number; week: number } {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const diff = target.getTime() - firstThursday.getTime();
  const week = 1 + Math.round(diff / (7 * 24 * 60 * 60 * 1000));
  return { year: target.getFullYear(), week };
}
