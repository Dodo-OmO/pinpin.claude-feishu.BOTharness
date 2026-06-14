/**
 * supervisor 主进程内 cron runner（2026-05-28 多 CLI 架构落地）
 *
 * 这里跑的 3 个 cron 共同点：**不依赖任何 CLI 在线**：
 *   1. mood-decay      每小时整点  → 直接调 decayMoodlets() 写 mood-state 文件
 *   2. feishu-token-keepalive 04:00 → 直接调 getUserToken({keepalive}) 续期
 *   3. daily-restart   编排  → 03:55 stop 所有 CLI + 04:10 start 所有 CLI
 *
 * 跟 src/mcp/cron/registry.ts 的关系：
 *   - 复用 computeNextRunAt / nextDailyAt / nextHourlyAt 的时间计算
 *   - 但 supervisor 这边**不读 SQLite scheduled_tasks 表做 catch-up**——supervisor 启动时刻
 *     直接 scheduleNext，漏跑就漏跑（这 3 个 cron 漏一次影响极小：mood 多衰减一格 / token
 *     等下次 refresh 临期再补 / restart 第二天再来）
 *   - daily-restart 不在每天准点 06:00（旧版语义）—— 改成Owner指定的 03:55 stop + 04:10 start
 */

import {
  nextDailyAt,
  nextHourlyAt,
  computeNextRunAt,
  type CronSchedule,
} from '../src/mcp/cron/registry.js';
import { decayMoodlets } from '../src/mcp/utils/mood-state.js';
import { getUserToken } from '../src/mcp/feishu/feishu-token.js';
import type { Supervisor } from './index.js';

interface SupervisorCronJob {
  name: string;
  schedule: CronSchedule;
  handler: () => Promise<void> | void;
  timer?: NodeJS.Timeout;
}

const SHUTDOWN_HOUR = 3;
const SHUTDOWN_MIN = 55;
const STARTUP_HOUR = 4;
const STARTUP_MIN = 10;

export class SupervisorCronRunner {
  private jobs = new Map<string, SupervisorCronJob>();
  private supervisor: Supervisor;
  private started = false;
  private startupKeepaliveTimer?: NodeJS.Timeout;

  constructor(supervisor: Supervisor) {
    this.supervisor = supervisor;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.registerAll();
    for (const job of this.jobs.values()) this.scheduleNext(job);
    process.stderr.write(
      `[supervisor-cron] started (${this.jobs.size} jobs: ${[...this.jobs.keys()].join(', ')})\n`,
    );

    // 启动后 60s 补跑一次 feishu-token-keepalive。
    // 防电脑凌晨 4 点关机连续踏空、7 天 refresh 链断。
    this.startupKeepaliveTimer = setTimeout(() => {
      this.startupKeepaliveTimer = undefined;
      const job = this.jobs.get('feishu-token-keepalive');
      if (job) {
        process.stderr.write('[supervisor-cron] 启动补跑 feishu-token-keepalive\n');
        Promise.resolve(job.handler()).catch((e) => {
          process.stderr.write(
            `[supervisor-cron] startup-keepalive failed: ${e instanceof Error ? e.message : e}\n`,
          );
        });
      }
    }, 60_000);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.startupKeepaliveTimer) {
      clearTimeout(this.startupKeepaliveTimer);
      this.startupKeepaliveTimer = undefined;
    }
    for (const job of this.jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
      job.timer = undefined;
    }
    process.stderr.write('[supervisor-cron] stopped\n');
  }

  private registerAll(): void {
    // 1. mood-decay：每小时整点 → decayMoodlets()
    this.jobs.set('mood-decay', {
      name: 'mood-decay',
      schedule: { kind: 'hourly', m: 0 },
      handler: () => {
        try {
          decayMoodlets();
        } catch (e) {
          process.stderr.write(
            `[supervisor-cron] mood-decay failed: ${e instanceof Error ? e.message : e}\n`,
          );
        }
      },
    });

    // 2. feishu-token-keepalive：每天 04:00 → getUserToken({keepalive})
    this.jobs.set('feishu-token-keepalive', {
      name: 'feishu-token-keepalive',
      schedule: { kind: 'daily', h: 4, m: 0 },
      handler: async () => {
        try {
          const token = await getUserToken({ keepalive: true });
          process.stderr.write(
            `[supervisor-cron] feishu-token-keepalive ${token ? '续期检查完成' : '未授权/过期，静默跳过'}\n`,
          );
        } catch (e) {
          process.stderr.write(
            `[supervisor-cron] feishu-token-keepalive failed: ${e instanceof Error ? e.message : e}\n`,
          );
        }
      },
    });

    // 3. daily-restart-shutdown：03:55 stop 所有 CLI
    this.jobs.set('daily-restart-shutdown', {
      name: 'daily-restart-shutdown',
      schedule: { kind: 'daily', h: SHUTDOWN_HOUR, m: SHUTDOWN_MIN },
      handler: () => {
        const chats = this.supervisor.getChannelCliStats();
        process.stderr.write(
          `[supervisor-cron] daily-restart-shutdown 03:55 触发，stop ${chats.length} 个 CLI\n`,
        );
        for (const c of chats) {
          this.supervisor.getChannel(c.chat_id)?.stop();
        }
      },
    });

    // 4. daily-restart-startup：04:10 start 所有持久化频道（含被 03:55 stop 的）
    this.jobs.set('daily-restart-startup', {
      name: 'daily-restart-startup',
      schedule: { kind: 'daily', h: STARTUP_HOUR, m: STARTUP_MIN },
      handler: () => {
        process.stderr.write('[supervisor-cron] daily-restart-startup 04:10 触发，重启所有已识别频道\n');
        // supervisor 自带 channel-config-store 持久化 + start 时遍历——这里手动遍历调 spawnChannelCli
        // 注意：spawnChannelCli 会自动 skip 已 running 的频道（channels.has 检查），但 03:55 stop 后
        // ChannelCli 实例仍在 channels Map 但 status=stopped，需要走 start() 路径而不是 spawn
        for (const c of this.supervisor.getChannelCliStats()) {
          if (c.status === 'stopped') {
            this.supervisor.getChannel(c.chat_id)?.start();
          }
        }
      },
    });

    // （方案A：supervisor 卸 DB 后不再写 channel_message_ids 去重表，原 prune-message-ids
    //  job 一并删除——supervisor 入口去重已改纯 in-memory Set，无持久表可清。）
  }

  private scheduleNext(job: SupervisorCronJob): void {
    const now = Date.now();
    const next =
      job.schedule.kind === 'hourly'
        ? nextHourlyAt(job.schedule.m, now)
        : job.schedule.kind === 'daily'
          ? nextDailyAt(job.schedule.h, job.schedule.m, now)
          : computeNextRunAt(job.schedule, now);
    const delay = Math.max(100, next - now);
    job.timer = setTimeout(async () => {
      try {
        await job.handler();
      } catch (e) {
        process.stderr.write(
          `[supervisor-cron] ${job.name} handler error: ${e instanceof Error ? e.message : e}\n`,
        );
      }
      if (this.started) this.scheduleNext(job);
    }, delay);
  }
}
