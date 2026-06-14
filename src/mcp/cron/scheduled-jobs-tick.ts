// 一次性 timer 精确调度（MCP 版）
// 阶段 4 批次 3 步骤 3.3：优雅清单 2——每个 pending timer 一个独立 setTimeout
//                              （替代 早期版本 30s tick 扫表，CPU 更低 + 触发更准）
//
// 启动序列：
//   server.ts → schedulerStart() → listPendingTimerJobs(now+24h) → 给每个设 setTimeout
//   新 timer schedule 后调 scheduleJob(jobId) 即时安排
//   cancel 时调 unscheduleJob(jobId) clearTimeout
//   fire 时 markJobFired + 推 channel trigger，不续链（一次性任务）

import {
  listPendingTimerJobs,
  listPendingRelayJobs,
  getJobById,
  markJobFired,
  revertJobToPending,
  markJobFailed,
  bumpRelayNudge,
  getKnownUserName,
} from "../db/database.js";
import type { ScheduledJob, RelayPayload } from "../db/types.js";
import { pushChannelTrigger } from "../utils/push-channel.js";
import { logBackground } from "../utils/background-log.js";

const timers = new Map<number, NodeJS.Timeout>();
const MAX_RETRY = 3;
// Node.js setTimeout 上限 (2^31 - 1 ms ≈ 24.85 天)，超过会立刻 fire + TimeoutOverflowWarning
// 用中转 timer 分段：到上限后重 scheduleJob 算剩余 delay（递归直至 ≤ 上限）
const MAX_TIMEOUT_MS = 2_147_483_647;

export function scheduleJob(jobId: number): void {
  const job = getJobById(jobId);
  if (!job || job.status !== "pending" || !job.fire_at) return;
  // 已有 timer → 先清
  unscheduleJob(jobId);
  const fireMs = Date.parse(job.fire_at);
  if (Number.isNaN(fireMs)) {
    process.stderr.write(`[scheduled-jobs] job=${jobId} fire_at 解析失败：${job.fire_at}\n`);
    return;
  }
  const delay = Math.max(100, fireMs - Date.now());
  // 超 Node setTimeout 上限 → 中转 timer 等到上限后再重 scheduleJob 算剩余 delay
  if (delay > MAX_TIMEOUT_MS) {
    const trampoline = setTimeout(() => {
      timers.delete(jobId);
      scheduleJob(jobId);
    }, MAX_TIMEOUT_MS);
    timers.set(jobId, trampoline);
    return;
  }
  const timer = setTimeout(() => void fireJob(jobId), delay);
  timers.set(jobId, timer);
}

export function unscheduleJob(jobId: number): void {
  const t = timers.get(jobId);
  if (t) {
    clearTimeout(t);
    timers.delete(jobId);
  }
}

// relay 线性退避间隔（分钟）
const RELAY_NUDGE_DELAYS_MIN = [30, 60];
const RELAY_MAX_NUDGE = 2;

async function fireJob(jobId: number): Promise<void> {
  timers.delete(jobId);
  const job = getJobById(jobId);
  if (!job || job.status !== "pending") return; // 已 cancel 或已 fire 跳过

  // relay 类型：催 B 回复，或达到上限后回报 A
  if (job.type === "relay") {
    return fireRelayJob(jobId, job).catch((e) => {
      logBackground("scheduled-jobs", `relay job=${jobId} 未捕获异常: ${e instanceof Error ? e.message : e}`);
    });
  }

  // v8.4 ④A 时序修复：先推 channel 成功才 markJobFired，失败回 pending + retry_count++
  // throwOnError: true 让 push-channel 失败时抛异常进 catch 走 retry（intent=hard 不丢任务）
  try {
    await pushChannelTrigger(
      {
        trigger: "scheduled-timer",
        chat_id: job.chat_id,
        body:
          `⏰ 定时任务触发（job_id=${job.id}）。\n` +
          `原始 hint：${job.context_hint ?? "（无）"}\n` +
          `payload: ${job.payload ?? "（无）"}\n` +
          `请按品品风格说出原提醒内容。`,
        meta: { job_id: jobId, intent: job.intent },
      },
      { throwOnError: true }
    );
    markJobFired(jobId);
    logBackground("scheduled-jobs", `fired job=${jobId} chat=${job.chat_id}`);
  } catch (e) {
    const retry = revertJobToPending(jobId);
    const msg = e instanceof Error ? e.message : String(e);
    logBackground("scheduled-jobs", `fire FAILED job=${jobId} retry=${retry} err=${msg}`);
    if (retry >= MAX_RETRY) {
      markJobFailed(jobId);
      process.stderr.write(`[scheduled-jobs] job=${jobId} 重试 ${MAX_RETRY} 次仍失败，置 failed\n`);
    } else {
      // 5 分钟后重试
      setTimeout(() => scheduleJob(jobId), 5 * 60 * 1000);
    }
  }
}

/** relay 催循环：到点检查，没回就催 B；达到上限（2次）回报 A "B 暂未回" */
async function fireRelayJob(jobId: number, job: ScheduledJob): Promise<void> {
  if (!job || !job.payload) {
    markJobFailed(jobId);
    return;
  }
  let payload: RelayPayload;
  try {
    payload = JSON.parse(job.payload) as RelayPayload;
  } catch {
    markJobFailed(jobId);
    return;
  }

  const remindCount = payload.remindCount ?? 0;
  const watcherOpenId = job.watch_user_id ?? "";
  const fromOpenId = payload._fromOpenId ?? "";
  const watcherName = (watcherOpenId ? getKnownUserName(watcherOpenId) : undefined) ?? "对方";
  const fromName = payload.fromName;

  if (remindCount >= RELAY_MAX_NUDGE) {
    // 已催满 2 次仍未回——回报委托人 A（镜像 timer 模式：先推成功再 markFired，失败走 retry）
    if (!fromOpenId) { markJobFired(jobId); return; }
    try {
      await pushChannelTrigger(
        {
          trigger: "relay-callback",
          body:
            `📭 传话回报（job_id=${jobId}）：你替 ${fromName} 传给 ${watcherName} 的话，催了 2 次对方仍未回复。请用品品风格私聊或在群里告知 ${fromName}（open_id=${fromOpenId}）遇到的情况。 然后结束此传话任务。`,
          meta: {
            job_id: String(jobId),
            from_open_id: fromOpenId,
            watcher_open_id: watcherOpenId,
            relay_status: "timeout",
          },
        },
        { throwOnError: true },
      );
      markJobFired(jobId);
      logBackground("scheduled-jobs", `relay job=${jobId} max nudge reached, notified A=${fromOpenId.slice(-6)}`);
    } catch (e) {
      const retry = revertJobToPending(jobId);
      logBackground("scheduled-jobs", `relay job=${jobId} 终报推送失败 retry=${retry}: ${e instanceof Error ? e.message : e}`);
      if (retry >= MAX_RETRY) {
        markJobFailed(jobId);
        process.stderr.write(`[scheduled-jobs] relay job=${jobId} 终报重试 ${MAX_RETRY} 次仍失败，置 failed\n`);
      } else {
        setTimeout(() => scheduleJob(jobId), 5 * 60 * 1000);
      }
    }
    return;
  }

  // 还可以催：推 trigger 让品品私聊催 B
  const nudgeNo = remindCount + 1;
  const nextDelayMin = RELAY_NUDGE_DELAYS_MIN[remindCount] ?? 60;
  const nextFireAt = new Date(Date.now() + nextDelayMin * 60 * 1000).toISOString();

  // 有意 bump 在 push 前：宁可丢一次催也不重复催（at-most-once）
  const newCount = bumpRelayNudge(jobId, nextFireAt);
  // relay job 保持 pending 状态（bumpRelayNudge 已写 fire_at，无需 rescheduleJob 重复 UPDATE）
  // 重新 schedule 下一次 fire
  scheduleJob(jobId);

  logBackground(
    "scheduled-jobs",
    `relay job=${jobId} nudge #${nudgeNo} → watcher=${watcherOpenId.slice(-6)}, next in ${nextDelayMin}min`,
  );

  await pushChannelTrigger({
    trigger: "relay-nudge",
    body:
      `📩 传话催一催（job_id=${jobId}，第 ${nudgeNo} 次/共 ${RELAY_MAX_NUDGE} 次）：请私聊 ${watcherName}（open_id=${watcherOpenId}），用品品自然的口吻提醒 ta ${fromName} ：你还在等 ta 回复。然后继续等 ta 回。`,
    meta: {
      job_id: String(jobId),
      nudge_no: String(nudgeNo),
      watcher_open_id: watcherOpenId,
      from_open_id: fromOpenId,
      remind_count: String(newCount),
    },
  });
}

/** server.ts 启动时调一次：把 DB 里所有 pending timer 和 relay 都 schedule
 *
 *  多 CLI 架构（2026-05-28 Owner决策）：
 *  - timer：每个 CLI 只调度自己 chat_id 的 pending timer，防跨 CLI 抢 fire。
 *  - relay：relay job 的 chat_id 存委托人 A 所在频道（见 addRelayJob）；
 *    schedulerStart 同样按 ownChatId 过滤，只有委托人那个频道的 CLI 才 schedule + fire——
 *    消除多 CLI 同时 setTimeout 同一条 relay 导致的双催竞态。
 *  PINPIN_CHAT_ID env 由 supervisor spawn 时注入（channel-cli.ts L121）。
 */
export function schedulerStart(): void {
  const horizon = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  const ownChatId = process.env.PINPIN_CHAT_ID;
  const timerPending = listPendingTimerJobs(horizon, ownChatId);
  for (const job of timerPending) {
    scheduleJob(job.id);
  }
  const relayPending = listPendingRelayJobs(ownChatId);
  for (const job of relayPending) {
    scheduleJob(job.id);
  }
  logBackground(
    "scheduled-jobs",
    `schedulerStart fired (${timerPending.length} timers, ${relayPending.length} relays for chat=${ownChatId?.slice(-8) ?? "all"})`,
  );
}

/** 关停时调：清所有 setTimeout */
export function schedulerStop(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
