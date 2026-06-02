#!/usr/bin/env node
/**
 * Claude Code statusLine sink (P1.3) —— per-CLI 上下文用量 + cost 推 supervisor。
 *
 * Claude Code 每次 API 响应后调本脚本，stdin 收 JSON session data（含权威
 * context_window.used_percentage / total_input_tokens 等字段）。
 * 本脚本：
 *   1. 解析 stdin JSON
 *   2. 通过 TCP socket（PINPIN_SUPERVISOR_PORT env）写 NDJSON 协议帧给 supervisor
 *      method: 'statusline.update', params: { chat_id, context_pct, context_tokens, ... }
 *   3. stdout 输出友好 status line 文本，让 channel 终端窗口也能看到
 *
 * 不依赖任何外部包（claude code 启动时 cwd 是 vault，require 范围有限）；CJS 格式
 * 让 claude 通过 `node {path}` 命令直接跑（不需 ts-node / esbuild）。
 *
 * 用法：
 *   node statusline-sink.cjs --chat-id=oc_xxx
 * env：
 *   PINPIN_SUPERVISOR_PORT  supervisor IPC server 端口（必填）
 *
 * 失败兜底：socket 写不通 / supervisor 没在 → stdout 仍输出友好文本，不阻塞 CLI。
 */

const net = require('net');

// 解析 --chat-id=xxx
const args = process.argv.slice(2);
let chatId = '';
for (const a of args) {
  if (a.startsWith('--chat-id=')) chatId = a.slice('--chat-id='.length);
}
const port = parseInt(process.env.PINPIN_SUPERVISOR_PORT || '0', 10);

// 读 stdin 全文
let stdinData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdinData += chunk; });
process.stdin.on('end', () => {
  let data = {};
  try {
    data = JSON.parse(stdinData);
  } catch {
    // 失败：输出 fallback statusline + 不写 IPC
    process.stdout.write('[品品] statusLine 解析失败\n');
    process.exit(0);
  }

  const ctx = (data && data.context_window) || {};
  const cost = (data && data.cost) || {};
  const model = (data && data.model) || {};
  // 口径统一：上下文% 一律用 CLI 权威的 used_percentage（= total_input_tokens / 窗口）。
  // work-session.ts 自算分支用同一口径（同分子 total_input_tokens），故两处可横向比较。
  const usedPct = typeof ctx.used_percentage === 'number' ? ctx.used_percentage : null;
  const totalIn = typeof ctx.total_input_tokens === 'number' ? ctx.total_input_tokens : null;
  const ctxSize = typeof ctx.context_window_size === 'number' ? ctx.context_window_size : null;
  const costUsd = typeof cost.total_cost_usd === 'number' ? cost.total_cost_usd : null;
  const durationMs = typeof cost.total_duration_ms === 'number' ? cost.total_duration_ms : null;
  const modelName = (model.display_name || model.id || '?');
  // 账号级额度（5h + 7天）—— Claude Code statusLine 的 rate_limits，每窗口带
  // used_percentage(0-100) + resets_at(Unix 秒)。仅在 Claude Code 用量额度可用时出现，
  // 窗口可独立缺失 → 取不到的字段置 null，绝不报错（optional chaining 防御）。
  const numOrNull = (v) => (typeof v === 'number' ? v : null);
  const rl = data?.rate_limits || {};
  const rateLimits = {
    five_hour: {
      used_percentage: numOrNull(rl.five_hour?.used_percentage),
      resets_at: numOrNull(rl.five_hour?.resets_at),
    },
    seven_day: {
      used_percentage: numOrNull(rl.seven_day?.used_percentage),
      resets_at: numOrNull(rl.seven_day?.resets_at),
    },
  };

  // 推 supervisor（fire-and-forget；失败不影响 stdout）
  if (port && chatId) {
    try {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        const env = {
          method: 'statusline.update',
          params: {
            chat_id: chatId,
            used_percentage: usedPct,
            total_input_tokens: totalIn,
            context_window_size: ctxSize,
            cost_usd: costUsd,
            duration_ms: durationMs,
            rate_limits: rateLimits,
          },
        };
        socket.write(JSON.stringify(env) + '\n');
        socket.end();
      });
      socket.setTimeout(2000);
      socket.on('error', () => { /* supervisor 没在 / 端口错 → 静默忽略 */ });
      socket.on('timeout', () => { try { socket.destroy(); } catch (e) {} });
    } catch (e) {
      /* 静默 */
    }
  }

  // stdout 友好文本（Owner从终端窗口能看到）
  const pctStr = usedPct !== null ? `${Math.round(usedPct)}%` : '--';
  const tokStr = totalIn !== null
    ? (totalIn >= 1000 ? `${(totalIn / 1000).toFixed(1)}K` : `${totalIn}`)
    : '--';
  const costStr = costUsd !== null ? `$${costUsd.toFixed(2)}` : '';
  process.stdout.write(`[${modelName}] 上下文 ${pctStr} (${tokStr}) ${costStr}`.trim() + '\n');
});

// 5s 超时兜底（stdin 不到也别挂死）
setTimeout(() => {
  process.stdout.write('[品品] statusLine 超时\n');
  process.exit(0);
}, 5000).unref();
