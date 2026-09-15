// 固定任务登记表的跨进程共享存储（纯 fs/json，零 DB 依赖——supervisor 唯一写者，MCP 子进程的
// recurring_task 工具也直接读写同一份文件，走原子写不用 IPC）。
//
// 路径：`{dirname(dbPath)}/recurring-tasks.json`（跟 data.db 同目录，随 robocopy 备份一起走，
// 但内容会频繁变，不入 git——见 .gitignore）。
//
// 设计仿 name-map-store.ts（惰性/无 cache，这里每次显式传 filePath 由调用方决定何时读）+
// channel-config-store.ts 的原子写（write tmp + rename，防半写崩溃）。

import fs from "node:fs";
import path from "node:path";

/** 每天 / 每周几 / 每月几号 到点触发，HH:MM 24 小时制。 */
export type RecurringRule =
  | { kind: "daily"; at: string }
  | { kind: "weekly"; at: string; days: number[] } // days: 0-6，0=周日
  | { kind: "monthly"; at: string; day: number }; // day: 1-31（月份天数不够自动落到当月最后一天）

export interface RecurringTask {
  id: string;
  name: string;
  /** 触发时推给哪个频道（飞书 chat_id） */
  chat_id: string;
  rule: RecurringRule;
  /** SOP 文档路径（vault 内相对路径，或绝对路径） */
  sop_path: string;
  enabled: boolean;
  /** 上次成功触发时刻（ISO 字符串），runner 触发成功后写回 */
  last_fired_at?: string;
  /** 离线补跑窗口（小时）。缺省 3——超过这个窗口的漏跑不补，等下一周期。 */
  catch_up_hours?: number;
}

/** dbPath = supervisor 的 data.db 绝对路径（`appRoot/data.db`）；同目录下放登记表。 */
export function recurringTasksPath(dbPath: string): string {
  return path.join(path.dirname(dbPath), "recurring-tasks.json");
}

/** 读取整份登记表。文件不存在 → 空数组；损坏/root 非数组 → 备份 `.corrupt.<ts>` 后回空数组；
 *  单条形状不对（缺字段/ rule 不合法）→ 该条被丢弃、不影响其它条（防一条脏数据拖垮整个调度）。 */
export function readRecurringTasks(filePath: string): RecurringTask[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("recurring-tasks.json root 不是数组");
    return parsed.filter(isValidTaskShape);
  } catch (e) {
    const corruptBackup = `${filePath}.corrupt.${Date.now()}`;
    try {
      fs.copyFileSync(filePath, corruptBackup);
      process.stderr.write(
        `[recurring-tasks-store] 损坏的 recurring-tasks.json 已 fallback 空数组，原文件备份至 ${corruptBackup}: ${e instanceof Error ? e.message : e}\n`,
      );
    } catch {
      process.stderr.write(
        `[recurring-tasks-store] 损坏的 recurring-tasks.json 已 fallback 空数组，备份失败: ${e instanceof Error ? e.message : e}\n`,
      );
    }
    return [];
  }
}

/** 整份原子落盘（write tmp + rename）。写失败会抛错（调用方——tool handler / runner 的
 *  markFired——必须知道没落盘成功，不能装作"已登记/已更新"返回给品品或用户）。 */
export function writeRecurringTasksAtomic(filePath: string, tasks: RecurringTask[]): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    process.stderr.write(
      `[recurring-tasks-store] ❌ flush 失败，固定任务未落盘：${filePath} err=${e instanceof Error ? e.message : e}\n`,
    );
    throw e;
  }
}

/** 校验一条 rule（tool 收到的 args.rule 是 unknown，这里转成强类型或给出人话错误原因）。 */
export function validateRule(
  rule: unknown,
): { ok: true; rule: RecurringRule } | { ok: false; error: string } {
  if (!rule || typeof rule !== "object") return { ok: false, error: "rule 缺失或不是对象" };
  const r = rule as Record<string, unknown>;
  const at = r.at;
  if (typeof at !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
    return { ok: false, error: 'rule.at 必须是 "HH:MM" 格式（00:00-23:59）' };
  }
  switch (r.kind) {
    case "daily":
      return { ok: true, rule: { kind: "daily", at } };
    case "weekly": {
      const days = r.days;
      if (
        !Array.isArray(days) ||
        days.length === 0 ||
        !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      ) {
        return { ok: false, error: "weekly rule.days 必须是 0-6 的整数数组（0=周日），至少 1 个" };
      }
      return { ok: true, rule: { kind: "weekly", at, days: [...new Set(days as number[])] } };
    }
    case "monthly": {
      const day = r.day;
      if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > 31) {
        return { ok: false, error: "monthly rule.day 必须是 1-31 的整数" };
      }
      return { ok: true, rule: { kind: "monthly", at, day: day as number } };
    }
    default:
      return { ok: false, error: "rule.kind 必须是 daily/weekly/monthly" };
  }
}

function isValidTaskShape(t: unknown): t is RecurringTask {
  if (!t || typeof t !== "object") return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.name === "string" &&
    typeof o.chat_id === "string" &&
    typeof o.sop_path === "string" &&
    typeof o.enabled === "boolean" &&
    validateRule(o.rule).ok
  );
}
