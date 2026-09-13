/**
 * supervisor 主进程内 cron runner（2026-05-28 多 CLI 架构落地）
 *
 * 这里跑的 4 个 job 共同点：**不依赖任何 CLI 在线**：
 *   1. mood-decay               每小时整点 → 直接调 decayMoodlets() 写 mood-state 文件
 *   2. feishu-token-keepalive   04:00      → 以Owner本人身份跑一次 lark-cli 用户接口：触发 token 续期 + 校验，失效即私聊Owner
 *   3. daily-restart-shutdown   03:55      → stop 所有 CLI
 *   4. daily-restart-startup    04:10      → start 所有常驻 CLI
 *
 * 跟 src/mcp/cron/registry.ts 的关系：
 *   - 复用 computeNextRunAt / nextDailyAt / nextHourlyAt 的时间计算
 *   - 但 supervisor 这边**不读 SQLite scheduled_tasks 表做 catch-up**——supervisor 启动时刻
 *     直接 scheduleNext，漏跑就漏跑（漏一次影响极小：mood 多衰减一格 / token 等下次 refresh 临期再补 / restart 第二天再来）
 */

import {
  nextDailyAt,
  nextHourlyAt,
  computeNextRunAt,
  type CronSchedule,
} from '../src/mcp/cron/registry.js';
import { decayMoodlets } from '../src/mcp/utils/mood-state.js';
import { exec } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getFeishuClient } from './feishu-client.js';
import type { FeishuAppConfig } from './feishu-apps.js';
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

  /** 跑一条 lark-cli（Owner用户身份），解析 JSON；非 JSON/失败 → null。
   *  configDir 有值 → 用该目录（该应用租户的Owner用户身份）；无值 → 回落 lark-cli 默认 ~/.lark-cli。 */
  private larkCliJson(args: string[], timeoutMs: number, configDir?: string): Promise<Record<string, unknown> | null> {
    const env = { ...process.env };
    if (configDir) env.LARKSUITE_CLI_CONFIG_DIR = configDir;
    else delete env.LARKSUITE_CLI_CONFIG_DIR;
    return new Promise((resolve) => {
      exec(['lark-cli', ...args].join(' '), { env, windowsHide: true, timeout: timeoutMs }, (_err, stdout) => {
        try {
          resolve(JSON.parse(String(stdout)) as Record<string, unknown>);
        } catch {
          resolve(null);
        }
      });
    });
  }

  /** 每日去重标记文件（随 data.db 同目录 logs/），launcher 重启不重置 */
  private reauthMarkPath(): string | null {
    const db = process.env.PINPIN_DB_PATH;
    return db ? join(dirname(db), 'logs', '.reauth-alert-day') : null;
  }

  /** Owner用户身份失效 → 品品自己发起设备码授权，把链接私聊给Owner（她只需点一下「授权」），
   *  后台轮询到她点完即登录完成。每天最多提醒一次（标记文件去重）。
   *  app = Owner DM 所属的飞书应用（多应用：文案带 label、设备码轮询用该应用的用户目录、发送用该应用 client）。 */
  private async alertOwnerReauth(app: FeishuAppConfig): Promise<void> {
    const chatId = process.env.PINPIN_OWNER_CHAT_ID;
    if (!chatId) return;
    const today = new Date().toISOString().slice(0, 10);
    const mark = this.reauthMarkPath();
    try {
      if (mark && existsSync(mark) && readFileSync(mark, 'utf8').trim() === today) return;
    } catch {
      /* 标记读失败不影响提醒 */
    }
    const start = await this.larkCliJson(['auth', 'login', '--no-wait', '--json', '--recommend'], 60_000, app.larkUserDir);
    const url = start?.verification_url;
    const code = start?.device_code;
    let text: string;
    if (typeof url === 'string' && typeof code === 'string' && /^[A-Za-z0-9._-]+$/.test(code)) {
      text =
        `🔑 我的飞书「${app.label}·你本人身份」授权失效了（日历 / 邮件 / 任务这类要用你身份的功能会不好使）。` +
        '点下面的链接、选你自己的账号、按一下「授权」就好，10 分钟内有效：\n' + url;
      // 后台轮询直到她点完授权（设备码 10 分钟有效，超时静默；明天 keepalive 会再提醒）
      const env = { ...process.env };
      if (app.larkUserDir) env.LARKSUITE_CLI_CONFIG_DIR = app.larkUserDir;
      else delete env.LARKSUITE_CLI_CONFIG_DIR;
      exec(
        `lark-cli auth login --device-code ${code} --json`,
        { env, windowsHide: true, timeout: 11 * 60_000 },
        (_err, stdout) => {
          const done = /authorization_complete/.test(String(stdout));
          process.stderr.write(`[supervisor-cron] Owner重新授权（app=${app.label}）${done ? '完成' : '未完成（超时或未点）'}\n`);
        },
      );
    } else {
      text = `🔑 我的飞书「${app.label}·你本人身份」授权失效了，这次自动发起重新授权也没成功；明天凌晨我会再自动试一次，到时给你发链接。`;
    }
    try {
      await getFeishuClient(app.appId).im.v1.message.create({
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
        params: { receive_id_type: 'chat_id' },
      });
      // 发送成功才落当日去重标记——发送失败时不能把今天"用掉"，否则失效会静默过夜
      try { if (mark) writeFileSync(mark, today); } catch { /* ignore */ }
    } catch (e) {
      process.stderr.write(`[supervisor-cron] 重授权提醒发送失败: ${e instanceof Error ? e.message : e}\n`);
    }
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

    // 2. feishu-token-keepalive：每天 04:00 → 以「Owner DM 所属应用」的用户身份配置跑一次 lark-cli 用户接口。
    //    lark-cli 的 refresh token 7 天滚动，每天用一次即自动续期；用户身份缺失/失效 → alertOwnerReauth：
    //    品品自己发起设备码授权、把链接私聊给Owner点一下、后台轮询完成登录（Owner不用跑任何命令）。
    //    品品全家的 LARKSUITE_CLI_CONFIG_DIR 指向 bot 专用目录，这里要换成该应用的用户身份目录才是Owner本人配置。
    this.jobs.set('feishu-token-keepalive', {
      name: 'feishu-token-keepalive',
      schedule: { kind: 'daily', h: 4, m: 0 },
      handler: () =>
        new Promise<void>((resolve) => {
          const chatId = process.env.PINPIN_OWNER_CHAT_ID;
          const dmApp: FeishuAppConfig | undefined = chatId ? this.supervisor.appForChat(chatId) : undefined;
          const env = { ...process.env };
          if (dmApp?.larkUserDir) env.LARKSUITE_CLI_CONFIG_DIR = dmApp.larkUserDir;
          else delete env.LARKSUITE_CLI_CONFIG_DIR;
          exec(
            'lark-cli contact +get-user --as user --json',
            { env, windowsHide: true, timeout: 60_000 },
            (err, stdout) => {
              let ok = false;
              try {
                ok = JSON.parse(String(stdout)).ok === true;
              } catch {
                /* 非 JSON 输出 = 失败 */
              }
              process.stderr.write(
                `[supervisor-cron] feishu-token-keepalive(app=${dmApp?.label ?? '?'}) ${ok ? '续期检查完成' : 'Owner用户身份不可用'}${err ? `（${err.message}）` : ''}\n`,
              );
              if (!ok && dmApp) this.alertOwnerReauth(dmApp).catch(() => {});
              resolve();
            },
          );
        }),
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
        // 刻意 stop 不 evict（区别于 pauseChannel）：留在 Map(status=stopped)，让 04:10 用 start() 就地复活常驻频道（比全 spawn 省）。
        for (const c of chats) {
          this.supervisor.getChannel(c.chat_id)?.stop();
        }
        // 睡眠频道 stop 后从 Map 移除，使 04:10 不重启它们（维持"睡眠=不在 Map"，靠消息唤醒）
        this.supervisor.evictStandbyChannels();
      },
    });

    // 4. daily-restart-startup：04:10 start 所有持久化频道（含被 03:55 stop 的）
    this.jobs.set('daily-restart-startup', {
      name: 'daily-restart-startup',
      schedule: { kind: 'daily', h: STARTUP_HOUR, m: STARTUP_MIN },
      handler: () => {
        process.stderr.write('[supervisor-cron] daily-restart-startup 04:10 触发，重启所有常驻频道\n');
        // ① 03:55 stop 后仍在 Map（status=stopped）的常驻频道 → 错峰 start() 复活实例
        //   （与 spawnAllKnownChannels 共用错峰闸，防全频道同 tick 齐开 IO 风暴 → MCP 连接超时聋频道）。
        this.supervisor.startStoppedChannelsStaggered();
        // ② 被 /下线 / ✕关闭 evict 出 Map 的常驻频道（不在 ① 的遍历里）→ spawnAllKnownChannels 重拉。
        //    它跳过睡眠归属（睡眠频道维持"重启不上线、靠消息唤醒"），且对已在 Map 的幂等跳过。
        this.supervisor.spawnAllKnownChannels();
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
