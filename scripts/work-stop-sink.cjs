#!/usr/bin/env node
/**
 * work-stop-sink —— 遥控 work CLI 的「完工信号」Stop hook（批2）。
 *
 * work CLI 干完一轮停下等输入那刻，Claude Code 确定性触发本 Stop hook（替掉 supervisor 端
 * 的 idle 6 秒静默猜停——猜停误报/漏报/淹没的根）。本脚本：
 *   1. 读 stdin JSON（Stop hook 输入）取 transcript_path
 *   2. 读 argv --ws-id=<id>（spawn 时 work-session.ts 注入，标识哪个 work session）
 *   3. 反扫 transcript 取最近一条 assistant 文字（作完工回报正文）
 *   4. TCP 连 127.0.0.1:PINPIN_SUPERVISOR_PORT 发 NDJSON
 *      { method:'worksession.stop-signal', params:{ ws_id, transcript_path, last_text } }
 *      fire-and-forget（仿 statusline-sink.cjs）
 *
 * 设计铁律：
 *   - **绝不输出 decision:block**——这是完工「通知」不是「闸」，不拦 work CLI，永远 exit 0。
 *   - fail-open：任何读不到 / 解析失败 / socket 写不通 → 静默 exit 0，绝不卡死 work CLI。
 *   - 不走 hello 注册（匿名短连接，同 statusline-sink）。
 *
 * CJS + 零外部依赖（claude 启动 cwd 是 work_dir，require 范围有限）。
 */

const fs = require('fs');
const net = require('net');

// argv --ws-id=xxx
let wsId = '';
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--ws-id=')) wsId = a.slice('--ws-id='.length);
}
const port = parseInt(process.env.PINPIN_SUPERVISOR_PORT || '0', 10);

/** 反扫 transcript 取最近一条 assistant 文字（join type:'text' parts，逻辑同 work-session.extractAssistantText） */
function extractLastAssistantText(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch (_) {
    return '';
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch (_) {
      continue;
    }
    if (!o || o.type !== 'assistant' || !o.message) continue;
    const c = o.message.content;
    if (!Array.isArray(c)) continue;
    const parts = [];
    for (const p of c) {
      if (p && p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return '';
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.exit(0);
  }
  let input;
  try {
    input = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (_) {
    process.exit(0);
  }

  const transcriptPath = input && input.transcript_path;
  if (!transcriptPath || !port || !wsId) process.exit(0); // 缺关键信息 → 静默放行

  const lastText = extractLastAssistantText(transcriptPath) || '（工作 CLI 完成一轮，无文字输出）';

  try {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      const env = {
        method: 'worksession.stop-signal',
        params: { ws_id: wsId, transcript_path: transcriptPath, last_text: lastText },
      };
      socket.write(JSON.stringify(env) + '\n');
      socket.end();
    });
    socket.setTimeout(2000);
    socket.on('error', () => { /* supervisor 没在 / 端口错 → 静默 */ });
    socket.on('timeout', () => { try { socket.destroy(); } catch (_) {} });
  } catch (_) {
    /* 静默 */
  }
  // 不等 socket（fire-and-forget）；2.5s 后无论如何退出，绝不挂住 work CLI
  setTimeout(() => process.exit(0), 2500).unref();
}

try {
  main();
} catch (_) {
  process.exit(0); // 顶层兜底 fail-open
}
