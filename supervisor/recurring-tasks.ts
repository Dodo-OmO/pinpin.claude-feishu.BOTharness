/**
 * 固定任务引擎（启动器级，2026-09-15）。
 *
 * 品品自己用 `recurring_task` 工具登记（写 recurring-tasks.json），本 runner 在 supervisor
 * 主进程里到点把 SOP 推给对应频道品品——不依赖任何频道 CLI 在线（离线先拉起）、也不用改代码
 * 加新固定任务（Owner一句话 → 品品写 SOP + 登记即生效）。
 *
 * 时间计算复用 src/mcp/cron/registry.ts 的 nextDailyAt（daily 一样是"墙钟对齐"）；
 * weekly/monthly 本文件自己算（registry 没有）。
 *
 * fs.watch 热重载：Owner/品品在别的进程改了 recurring-tasks.json（工具 upsert/disable/remove），
 * 本 runner 监听所在目录、500ms 防抖、内容哈希没变就跳过——避免同一次落盘触发多次 reload，
 * 也避免自己刚写完 last_fired_at 又把自己重新加载一遍（suppressWatchUntil 1.5s 双保险）。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { nextDailyAt } from "../src/mcp/cron/registry.js";
import {
  readRecurringTasks,
  writeRecurringTasksAtomic,
  type RecurringRule,
  type RecurringTask,
} from "../src/shared/recurring-tasks-store.js";

export interface RecurringTaskRunnerDeps {
  /** recurring-tasks.json 绝对路径（recurringTasksPath(dbPath) 算出来的那个） */
  filePath: string;
  /** 触发前确保目标频道 CLI 就绪（离线先拉起等 hello），供参考 supervisor 的 ensureChannelReadyForEvent */
  ensureReady: (chatId: string) => Promise<boolean>;
  /** 真正推送 trigger 给目标频道（ipcServer.pushChatTrigger） */
  pushTrigger: (chatId: string, body: string, meta: Record<string, string>) => boolean;
  /** 连续失败到上限后私聊豆姐告警（supervisor 侧 notifyOwnerDm：查该 chat 归属应用的 ownerOpenId） */
  notifyOwner: (chatId: string, text: string) => Promise<void>;
  /** 频道可读显示名（告警文案用） */
  displayName: (chatId: string) => string;
}

/** 略小于 Node setTimeout 上限 (2^31-1 ≈ 24.855 天)，留余量防溢出；超过要分段 setTimeout 中转。 */
const MAX_TIMEOUT_MS = 2_000_000_000;
/** 失败重试：5min 一次，最多 3 次重试（+ 首次尝试共 4 次），第 3 次重试仍失败（即 15min 后）才告警。 */
const RETRY_DELAY_MS = 5 * 60_000;
const MAX_RETRIES = 3;
const WATCH_DEBOUNCE_MS = 500;
const SELF_WRITE_SUPPRESS_MS = 1500;

interface ScheduledEntry {
  task: RecurringTask;
  timer?: NodeJS.Timeout;
}

export class RecurringTaskRunner {
  private deps: RecurringTaskRunnerDeps;
  private entries = new Map<string, ScheduledEntry>();
  private watcher: fs.FSWatcher | null = null;
  private watchDebounceTimer: NodeJS.Timeout | null = null;
  private lastContentHash = "";
  private suppressWatchUntil = 0;
  private started = false;

  constructor(deps: RecurringTaskRunnerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.reload(true);
    this.watchDir();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
    this.entries.clear();
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    process.stderr.write("[recurring-tasks] stopped\n");
  }

  private watchDir(): void {
    const dir = path.dirname(this.deps.filePath);
    const base = path.basename(this.deps.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (filename && filename !== base) return;
        if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
        this.watchDebounceTimer = setTimeout(() => {
          this.watchDebounceTimer = null;
          this.onFileChanged();
        }, WATCH_DEBOUNCE_MS);
      });
    } catch (e) {
      process.stderr.write(
        `[recurring-tasks] fs.watch 启动失败（改动需重启启动器才生效）: ${e instanceof Error ? e.message : e}\n`,
      );
    }
  }

  private onFileChanged(): void {
    if (Date.now() < this.suppressWatchUntil) return; // 自己刚写的 last_fired_at，跳过
    const raw = this.safeReadRaw();
    if (hashContent(raw) === this.lastContentHash) return; // 内容没变（重复事件/别的文件），跳过
    process.stderr.write("[recurring-tasks] 检测到 recurring-tasks.json 变化，重新加载\n");
    this.reload(false);
  }

  private safeReadRaw(): string {
    try {
      return fs.readFileSync(this.deps.filePath, "utf8");
    } catch {
      return "";
    }
  }

  /** (重)加载任务列表 + 重排所有调度。isStartup=true 时额外跑一遍 catch-up 检测（补跑离线期漏跑的）。 */
  private reload(isStartup: boolean): void {
    this.lastContentHash = hashContent(this.safeReadRaw());
    const tasks = readRecurringTasks(this.deps.filePath);
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
    this.entries.clear();
    const now = Date.now();
    for (const task of tasks) {
      this.entries.set(task.id, { task });
      if (!task.enabled) continue;
      if (isStartup && this.shouldCatchUp(task, now)) {
        process.stderr.write(`[recurring-tasks] catch-up 触发: ${task.name}(${task.id})\n`);
        void this.fire(task, MAX_RETRIES);
        continue; // fire() 成功/放弃后会自己 scheduleTask 排下一周期，这里不重复排
      }
      this.scheduleTask(task);
    }
    process.stderr.write(`[recurring-tasks] loaded ${tasks.length} tasks\n`);
  }

  /** 漏跑判定：上一次该发生的时间点是今天 + 今天还没成功触发过 + 现在距那个时间点没超过补跑窗口。 */
  private shouldCatchUp(task: RecurringTask, now: number): boolean {
    const prev = prevFireAt(task.rule, now);
    const catchUpMs = (task.catch_up_hours ?? 3) * 3_600_000;
    const prevIsToday = sameLocalDay(prev, now);
    const firedToday = task.last_fired_at ? sameLocalDay(Date.parse(task.last_fired_at), now) : false;
    return prevIsToday && !firedToday && now - prev < catchUpMs;
  }

  private scheduleTask(task: RecurringTask): void {
    const entry = this.entries.get(task.id);
    if (!entry) return;
    this.armTimer(entry, nextFireAt(task.rule, Date.now()));
  }

  /** setTimeout 单次上限 ~24.8 天，monthly rule 间隔可能逼近这个上限，超限先分段等到接近再排最后一段。 */
  private armTimer(entry: ScheduledEntry, targetMs: number): void {
    const delay = targetMs - Date.now();
    if (delay > MAX_TIMEOUT_MS) {
      entry.timer = setTimeout(() => this.armTimer(entry, targetMs), MAX_TIMEOUT_MS);
      return;
    }
    entry.timer = setTimeout(() => {
      void this.fire(entry.task, MAX_RETRIES);
    }, Math.max(0, delay));
  }

  private async fire(task: RecurringTask, retriesLeft: number): Promise<void> {
    const entry = this.entries.get(task.id);
    if (!entry || !task.enabled) return; // 期间被 disable/remove，链自然终止
    const ok = await this.tryPush(task);
    if (ok) {
      this.markFired(task);
      this.scheduleTask(task);
      return;
    }
    if (retriesLeft > 0) {
      entry.timer = setTimeout(() => {
        void this.fire(task, retriesLeft - 1);
      }, RETRY_DELAY_MS);
      return;
    }
    const chatName = this.deps.displayName(task.chat_id);
    process.stderr.write(
      `[recurring-tasks] ${task.name}(${task.id}) 连续 ${MAX_RETRIES + 1} 次触发失败（约 ${(MAX_RETRIES * RETRY_DELAY_MS) / 60_000}min），通知豆姐\n`,
    );
    try {
      await this.deps.notifyOwner(
        task.chat_id,
        `⚠️ 固定任务「${task.name}」未能触发——频道「${chatName}」连续 ${MAX_RETRIES + 1} 次都没能拉起来，先跳过这一轮，下次到点再试。`,
      );
    } catch (e) {
      process.stderr.write(`[recurring-tasks] notifyOwner 失败: ${e instanceof Error ? e.message : e}\n`);
    }
    this.scheduleTask(task); // 本轮放弃，排下一周期
  }

  private async tryPush(task: RecurringTask): Promise<boolean> {
    try {
      const ready = await this.deps.ensureReady(task.chat_id);
      if (!ready) return false;
      const body =
        `【固定任务·${task.name}】到点了（${describeRule(task.rule)}）。先 Read \`${task.sop_path}\` 照 SOP 一步步做；` +
        `做完在本频道 pinpin_reply_text 通报。休息日/节假日且 SOP 没说要做 → pinpin_no_reply 跳过。`;
      const meta: Record<string, string> = {
        user: "系统",
        sender_type: "system",
        message_id: `sys-recurring-task-${task.id}-${Date.now()}`,
        trigger: "recurring-task",
        task_id: task.id,
        task_name: task.name,
        sop_path: task.sop_path,
      };
      return this.deps.pushTrigger(task.chat_id, body, meta);
    } catch (e) {
      process.stderr.write(
        `[recurring-tasks] ${task.name}(${task.id}) 推送异常: ${e instanceof Error ? e.message : e}\n`,
      );
      return false;
    }
  }

  /** 触发成功 → 写回 last_fired_at（从磁盘最新版本改，防覆盖掉期间被工具改过的其它字段/别的任务）。 */
  private markFired(task: RecurringTask): void {
    const firedAt = new Date().toISOString();
    task.last_fired_at = firedAt;
    const onDisk = readRecurringTasks(this.deps.filePath);
    const idx = onDisk.findIndex((t) => t.id === task.id);
    const next: RecurringTask[] =
      idx >= 0
        ? onDisk.map((t, i) => (i === idx ? { ...t, last_fired_at: firedAt } : t))
        : [...onDisk, { ...task }]; // 磁盘上已被删/改到找不到 → 按内存态补写回，保调度不丢
    this.suppressWatchUntil = Date.now() + SELF_WRITE_SUPPRESS_MS;
    try {
      writeRecurringTasksAtomic(this.deps.filePath, next);
      this.lastContentHash = hashContent(JSON.stringify(next, null, 2));
    } catch (e) {
      process.stderr.write(
        `[recurring-tasks] 写回 last_fired_at 失败（下次重启可能重复 catch-up 一次）: ${e instanceof Error ? e.message : e}\n`,
      );
    }
  }
}

// ── 时间计算（导出供单测：nextFireAt/prevFireAt）────────────────

export function nextFireAt(rule: RecurringRule, fromMs: number): number {
  const [hh, mm] = rule.at.split(":").map(Number);
  switch (rule.kind) {
    case "daily":
      return nextDailyAt(hh, mm, fromMs);
    case "weekly": {
      let best: number | null = null;
      for (const dow of rule.days) {
        const t = new Date(fromMs);
        t.setHours(hh, mm, 0, 0);
        const diff = (dow - t.getDay() + 7) % 7;
        t.setDate(t.getDate() + diff);
        if (t.getTime() <= fromMs) t.setDate(t.getDate() + 7);
        if (best === null || t.getTime() < best) best = t.getTime();
      }
      return best as number; // rule.days 已在 store 校验为非空
    }
    case "monthly": {
      const t = new Date(fromMs);
      t.setDate(Math.min(rule.day, daysInMonth(t.getFullYear(), t.getMonth())));
      t.setHours(hh, mm, 0, 0);
      if (t.getTime() > fromMs) return t.getTime();
      const nt = new Date(t.getFullYear(), t.getMonth() + 1, 1);
      nt.setDate(Math.min(rule.day, daysInMonth(nt.getFullYear(), nt.getMonth())));
      nt.setHours(hh, mm, 0, 0);
      return nt.getTime();
    }
  }
}

/** 算上一个该发生的时间点（<= fromMs），用于 catch-up 判定漏跑。 */
export function prevFireAt(rule: RecurringRule, fromMs: number): number {
  const [hh, mm] = rule.at.split(":").map(Number);
  switch (rule.kind) {
    case "daily": {
      const t = new Date(fromMs);
      t.setHours(hh, mm, 0, 0);
      if (t.getTime() > fromMs) t.setDate(t.getDate() - 1);
      return t.getTime();
    }
    case "weekly": {
      let best: number | null = null;
      for (const dow of rule.days) {
        const t = new Date(fromMs);
        t.setHours(hh, mm, 0, 0);
        const diff = (t.getDay() - dow + 7) % 7;
        t.setDate(t.getDate() - diff);
        if (t.getTime() > fromMs) t.setDate(t.getDate() - 7);
        if (best === null || t.getTime() > best) best = t.getTime();
      }
      return best as number;
    }
    case "monthly": {
      const t = new Date(fromMs);
      t.setDate(Math.min(rule.day, daysInMonth(t.getFullYear(), t.getMonth())));
      t.setHours(hh, mm, 0, 0);
      if (t.getTime() <= fromMs) return t.getTime();
      const pt = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      pt.setDate(Math.min(rule.day, daysInMonth(pt.getFullYear(), pt.getMonth())));
      pt.setHours(hh, mm, 0, 0);
      return pt.getTime();
    }
  }
}

function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function describeRule(rule: RecurringRule): string {
  const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
  switch (rule.kind) {
    case "daily":
      return `每天 ${rule.at}`;
    case "weekly":
      return `每周${rule.days.map((d) => dayNames[d]).join("/")} ${rule.at}`;
    case "monthly":
      return `每月${rule.day}日 ${rule.at}`;
  }
}

function hashContent(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}
