// 统一 cron 注册器（MCP 版）
// 阶段 4 批次 1 步骤 1.1：优雅清单 1（统一注册器，替代 SDK 10 个独立 .ts 文件）+
//                              优雅清单 2（精确 setTimeout 链式调度，替代 SDK 30s tick）
//
// 设计要点：
//   1. registerCron 在 startAllCrons 之前调用注册 → MCP server 启动序列：
//      cron/<name>.ts 各自 registerCron → server.ts 调 startAllCrons → 内部 setTimeout 链
//   2. catch-up：startAllCrons 检查 scheduled_tasks 表 last_run_at，若上一周期到期点 > 上次运行
//      = 漏跑 → 立即触发一次（startup catch-up，与 SDK 行为等价）
//   3. handler 失败 ≠ 终止链：upsertScheduledTaskRun('failed') + 继续 scheduleNext
//   4. 时间精度：setTimeout 最小 100ms（防止 0 delay 死循环）

import {
  getScheduledTask,
  upsertScheduledTaskRun,
} from "../db/database.js";
import { logBackground } from "../utils/background-log.js";

export type CronSchedule =
  | { kind: "daily"; h: number; m: number } // 每日 HH:MM
  | { kind: "weekday"; dow: number; h: number; m: number } // 每周 dow 的 HH:MM（0=Sun）
  | { kind: "hourly"; m: number } // 每小时 m 分
  | { kind: "interval"; ms: number }; // 每隔 ms 毫秒

interface CronJob {
  name: string;
  schedule: CronSchedule;
  handler: () => Promise<void> | void;
  timer?: NodeJS.Timeout;
  nextRunAt?: number;
}

const jobs = new Map<string, CronJob>();
let started = false;

export function registerCron(
  name: string,
  schedule: CronSchedule,
  handler: () => Promise<void> | void
): void {
  if (jobs.has(name)) {
    console.warn(`[cron] duplicate registerCron(${name}) ignored`);
    return;
  }
  jobs.set(name, { name, schedule, handler });
}

export function startAllCrons(): void {
  if (started) return;
  started = true;

  for (const job of jobs.values()) {
    // catch-up：上一周期到期点 > 上次实际运行 = 漏跑
    if (isMissed(job)) {
      logBackground("cron", `${job.name} catch-up triggered (missed previous cycle)`);
      void runOnce(job);
    } else {
      scheduleNext(job);
    }
  }
  // F3：列具体 job 名 + 本 CLI 身份（多 CLI 各注册不同 cron，名字才看得出谁跑什么）
  const cli = (process.env.PINPIN_CHAT_ID ?? "?").slice(-6);
  const names = Array.from(jobs.keys()).join("/") || "(无)";
  logBackground("cron", `本CLI[…${cli}] startAllCrons：注册 ${jobs.size} 个 → ${names}`);
}

export function stopAllCrons(): void {
  for (const job of jobs.values()) {
    if (job.timer) clearTimeout(job.timer);
    job.timer = undefined;
    job.nextRunAt = undefined;
  }
  started = false;
  logBackground("cron", "stopAllCrons fired");
}

// ── 内部调度链 ────────────────────────────────────────────

async function runOnce(job: CronJob): Promise<void> {
  upsertScheduledTaskRun(job.name, "running"); // 预写 status，不动 last_run_at
  try {
    await job.handler();
    upsertScheduledTaskRun(job.name, "idle", true); // 成功完成才刷 last_run_at
    logBackground("cron", `${job.name} ran ok`);
  } catch (e) {
    upsertScheduledTaskRun(job.name, "failed"); // 失败不刷 last_run_at → 重启 catch-up 能补跑
    const msg = e instanceof Error ? e.message : String(e);
    logBackground("cron", `${job.name} ran FAILED: ${msg}`);
    console.error(`[cron] ${job.name} handler error:`, e);
  }
  // 不管成功失败都续下一次（失败不停链）
  scheduleNext(job);
}

function scheduleNext(job: CronJob): void {
  const now = Date.now();
  const next = nextRunFor(job, now);
  job.nextRunAt = next;
  const delay = Math.max(100, next - now);
  job.timer = setTimeout(() => void runOnce(job), delay);
}

/**
 * 算下次触发点。
 * - daily/weekday/hourly：按墙钟算（与重启无关，本就对齐到固定时刻）。
 * - interval：**锚定 DB last_run_at + ms**，而非 now + ms——否则频繁重启会把"每 4h"
 *   倒计时反复清零，永远攒不满（free-activity 长期不触发的根因）。
 *   若 last_run_at + ms 已过期（停机 > ms），startAllCrons 的 isMissed 已先走 catch-up
 *   runOnce（不经本函数）；本函数只在"未漏跑"时被调，故 last_run_at + ms 必在未来或贴近 now，
 *   配合 scheduleNext 的 Math.max(100, …) floor 不会 0 delay 死循环、也不会重复触发。
 *   无 last_run_at（从未跑过）→ 退回 now + ms。
 */
function nextRunFor(job: CronJob, now: number): number {
  if (job.schedule.kind === "interval") {
    const lastRun = getLastRunMs(job.name);
    return lastRun != null ? lastRun + job.schedule.ms : now + job.schedule.ms;
  }
  return computeNextRunAt(job.schedule, now);
}

function getLastRunMs(name: string): number | null {
  const rec = getScheduledTask(name);
  if (!rec || !rec.last_run_at) return null;
  // SQLite datetime('now') 是 UTC "YYYY-MM-DD HH:MM:SS"
  const ms = Date.parse(rec.last_run_at.replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? null : ms;
}

// ── 时间计算（导出供调用方算下次触发用） ────────────────

export function computeNextRunAt(schedule: CronSchedule, fromMs: number): number {
  switch (schedule.kind) {
    case "daily":
      return nextDailyAt(schedule.h, schedule.m, fromMs);
    case "weekday":
      return nextWeekdayAt(schedule.dow, schedule.h, schedule.m, fromMs);
    case "hourly":
      return nextHourlyAt(schedule.m, fromMs);
    case "interval":
      return fromMs + schedule.ms;
  }
}

/** 算上一周期到期点（用于 catch-up：判断是否漏跑） */
function computePreviousRunAt(schedule: CronSchedule, fromMs: number): number {
  const d = new Date(fromMs);
  switch (schedule.kind) {
    case "daily": {
      const target = new Date(d);
      target.setHours(schedule.h, schedule.m, 0, 0);
      if (target.getTime() > fromMs) target.setDate(target.getDate() - 1);
      return target.getTime();
    }
    case "weekday": {
      const target = new Date(d);
      target.setHours(schedule.h, schedule.m, 0, 0);
      const diff = (target.getDay() - schedule.dow + 7) % 7;
      target.setDate(target.getDate() - diff);
      if (target.getTime() > fromMs) target.setDate(target.getDate() - 7);
      return target.getTime();
    }
    case "hourly": {
      const target = new Date(d);
      target.setMinutes(schedule.m, 0, 0);
      if (target.getTime() > fromMs) target.setHours(target.getHours() - 1);
      return target.getTime();
    }
    case "interval":
      // interval 类型无"周期对齐"概念，看作距 fromMs 不超过 ms 的最近一次
      return fromMs - schedule.ms;
  }
}

function isMissed(job: CronJob): boolean {
  const rec = getScheduledTask(job.name);
  if (!rec || !rec.last_run_at) return false;
  // SQLite datetime('now') 是 UTC 格式 "YYYY-MM-DD HH:MM:SS"
  const lastRun = Date.parse(rec.last_run_at.replace(" ", "T") + "Z");
  if (Number.isNaN(lastRun)) return false;
  const prevExpected = computePreviousRunAt(job.schedule, Date.now());
  return prevExpected > lastRun;
}

export function nextDailyAt(h: number, m: number, fromMs: number = Date.now()): number {
  const t = new Date(fromMs);
  t.setHours(h, m, 0, 0);
  if (t.getTime() <= fromMs) t.setDate(t.getDate() + 1);
  return t.getTime();
}

export function nextWeekdayAt(
  dow: number,
  h: number,
  m: number,
  fromMs: number = Date.now()
): number {
  const t = new Date(fromMs);
  t.setHours(h, m, 0, 0);
  const diff = (dow - t.getDay() + 7) % 7;
  t.setDate(t.getDate() + diff);
  if (t.getTime() <= fromMs) t.setDate(t.getDate() + 7);
  return t.getTime();
}

export function nextHourlyAt(m: number, fromMs: number = Date.now()): number {
  const t = new Date(fromMs);
  t.setMinutes(m, 0, 0);
  if (t.getTime() <= fromMs) t.setHours(t.getHours() + 1);
  return t.getTime();
}
