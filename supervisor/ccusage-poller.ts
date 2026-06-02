/**
 * ccusage Poller —— 后台每 5min spawn `npx ccusage@latest <subcmd> --json` 拉 quota 数据，
 * 解析后 emit 给 supervisor，supervisor 转 IPC push 给启动器 footer chip。
 *
 * 三个 subcmd：
 *   - blocks  → 5 小时滚动窗口
 *   - weekly  → 本周累计
 *   - daily   → 今日累计
 *
 * 兜底：spawn fail / 解析 fail / npx 离线 / 包升级中断 → 标记 quota_unavailable，
 * 不阻塞主流程；renderer chip 显示 "quota 暂不可用"。
 *
 * 设计目标：0 token 0 进程常驻——本进程 sleep 5min 后 spawn 一次，跑完即退出。
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { RateLimits } from '../src/ipc/protocol.js';

const SPAWN_TIMEOUT_MS = 30000;

export interface CcusageBlock {
  /** 当前 5h 滚动窗口已用 token（百分比/重置时刻改由 statusLine rate_limits 提供，ccusage 仅供 token 数） */
  tokens?: number;
}

export interface CcusageDaily {
  tokens?: number;
  /** 当日开销 USD */
  cost_usd?: number;
}

export interface CcusageWeekly {
  /** 本周累计 token（百分比/重置时刻由 statusLine rate_limits.seven_day 提供） */
  tokens?: number;
}

export interface QuotaSnapshot {
  ts: number;
  available: boolean;
  blocks?: CcusageBlock;
  daily?: CcusageDaily;
  weekly?: CcusageWeekly;
  /** 账号级额度 5h+7天（来自 statusLine rate_limits，非 ccusage）：各窗口 used_percentage + resets_at */
  rate_limits?: RateLimits | null;
  error?: string;
}

async function runCcusageSubcommand(subcmd: 'blocks' | 'weekly' | 'daily'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
      '-y',
      'ccusage@latest',
      subcmd,
      '--json',
    ], {
      windowsHide: true,
      // Windows 上 spawn .cmd 文件必须走 shell（Node.js spawn 不支持直接执行 .cmd），
      // 否则 EINVAL（P3 bug 3 根因，bug-fixer 阶段 3 假设 H 排序确认）
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`ccusage ${subcmd} timeout ${SPAWN_TIMEOUT_MS}ms`));
    }, SPAWN_TIMEOUT_MS);

    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ccusage ${subcmd} exit ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`ccusage ${subcmd} JSON parse failed: ${e instanceof Error ? e.message : e}`));
      }
    });
  });
}

/** 把 ccusage 各 subcmd 的 JSON 映射成 quota chip 扁平结构。
 *  实测 ccusage@latest blocks --json 输出 schema:
 *    { blocks: [{ id, startTime, endTime, isActive, totalTokens, costUSD,
 *                 tokenCounts: { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens },
 *                 models, entries, burnRate, projection, ... }] }
 *  daily/weekly 假设同款 { totalTokens, totalCost } 顶层或类似数组结构。
 */
function extractBlocks(json: unknown): CcusageBlock {
  const o = (json ?? {}) as { blocks?: Array<Record<string, unknown>> };
  if (!Array.isArray(o.blocks) || o.blocks.length === 0) return {};
  // 优先找 isActive=true（当前 5h），找不到取最后一个（按时间顺序）
  const active = o.blocks.find((b) => b.isActive === true) ?? o.blocks[o.blocks.length - 1];
  if (!active) return {};
  // 只取 token 数；百分比/重置时刻由 statusLine rate_limits.five_hour 提供。
  return { tokens: typeof active.totalTokens === 'number' ? active.totalTokens : undefined };
}

/** ccusage daily --json: 假设 { daily?: [{ date, totalTokens, totalCost }] } 或 { totalTokens, totalCost } 顶层。
 *  defensive 取值——多种 schema 兜底。 */
function extractDaily(json: unknown): CcusageDaily {
  const o = (json ?? {}) as Record<string, unknown>;
  // 路径 a: 顶层 totalTokens / totalCost
  let totalTokens = typeof o.totalTokens === 'number' ? (o.totalTokens as number) : undefined;
  let totalCost = typeof o.totalCost === 'number' ? (o.totalCost as number)
    : typeof o.costUSD === 'number' ? (o.costUSD as number) : undefined;
  // 路径 b: daily 数组取今日
  const dailyArr = (o.daily ?? o.entries) as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(dailyArr) && dailyArr.length > 0) {
    const today = dailyArr[dailyArr.length - 1];
    totalTokens = totalTokens ?? (typeof today.totalTokens === 'number' ? today.totalTokens : undefined);
    totalCost = totalCost ?? (typeof today.totalCost === 'number' ? today.totalCost
      : typeof today.costUSD === 'number' ? today.costUSD : undefined);
  }
  return { tokens: totalTokens, cost_usd: totalCost };
}

/** ccusage weekly --json: 类似 daily 但按周聚合。只取 token 数；百分比/重置时刻由 statusLine rate_limits.seven_day 提供。 */
function extractWeekly(json: unknown): CcusageWeekly {
  const o = (json ?? {}) as Record<string, unknown>;
  let totalTokens = typeof o.totalTokens === 'number' ? (o.totalTokens as number) : undefined;
  const weeklyArr = (o.weekly ?? o.entries) as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(weeklyArr) && weeklyArr.length > 0) {
    const thisWeek = weeklyArr[weeklyArr.length - 1];
    totalTokens = totalTokens ?? (typeof thisWeek.totalTokens === 'number' ? thisWeek.totalTokens : undefined);
  }
  return { tokens: totalTokens };
}

export class CcusagePoller extends EventEmitter {
  /** stop() 保留供 supervisor.stop() 调用（index.ts:303），实际无资源需清理（P1.3 改按需触发，无常驻 interval）。 */
  async stop(): Promise<void> {
    /* noop — 无常驻 timer/process，调用方 supervisor.stop() 统一收尾用 */
  }

  /** P1.3: 公开方法，footer "获取 quota" 按钮通过 supervisor.fetchQuotaNow → IPC 触发 */
  async fetchOnce(): Promise<void> {
    await this.pollOnce();
  }

  private async pollOnce(): Promise<void> {
    const snap: QuotaSnapshot = { ts: Date.now(), available: false };
    try {
      const [blocks, weekly, daily] = await Promise.all([
        runCcusageSubcommand('blocks').catch((e) => ({ _err: e })),
        runCcusageSubcommand('weekly').catch((e) => ({ _err: e })),
        runCcusageSubcommand('daily').catch((e) => ({ _err: e })),
      ]);
      const anyErr =
        (blocks as { _err?: Error })._err ||
        (weekly as { _err?: Error })._err ||
        (daily as { _err?: Error })._err;
      if (anyErr) {
        snap.error = `ccusage 部分 subcmd 失败：${anyErr.message}`;
        process.stderr.write(`[ccusage] ${snap.error}\n`);
      }
      snap.blocks = (blocks as { _err?: Error })._err ? undefined : extractBlocks(blocks);
      snap.weekly = (weekly as { _err?: Error })._err ? undefined : extractWeekly(weekly);
      snap.daily = (daily as { _err?: Error })._err ? undefined : extractDaily(daily);
      snap.available = !!(snap.blocks || snap.weekly || snap.daily);
      // ccusage 只供 token 数（百分比/重置时刻走 statusLine rate_limits）
      process.stderr.write(
        `[ccusage] snapshot available=${snap.available} blocks_tokens=${snap.blocks?.tokens ?? '?'} daily_tokens=${snap.daily?.tokens ?? '?'} daily_cost=$${snap.daily?.cost_usd ?? '?'} weekly_tokens=${snap.weekly?.tokens ?? '?'}\n`,
      );
    } catch (e) {
      snap.error = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[ccusage] poll 失败: ${snap.error}\n`);
    }
    this.emit('snapshot', snap);
  }
}
