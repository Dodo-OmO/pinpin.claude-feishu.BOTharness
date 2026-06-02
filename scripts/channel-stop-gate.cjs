#!/usr/bin/env node
/**
 * channel-stop-gate —— 防串台第 3 层 Stop hook（兜底）。
 *
 * 统一口径（Owner 2026-05-30）：品品每轮收到飞书消息 → 二选一必调一个工具：
 *   回 = pinpin_reply_text / voice / react（或其它用户可见输出工具）
 *   不回 = pinpin_no_reply（空操作留痕）
 * 本 hook 在品品每轮停下（Stop）时检查：本轮有真飞书入站、却一个"放行工具"都没调 →
 * 拦一次逼它补（要么回、要么 no_reply）。纯靠 prompt 模型会漏，hook 是确定性兜底。
 *
 * 设计铁律：**fail-open**——任何读不到/解析失败/异常 → 放行（exit 0），绝不卡死品品。
 *
 * transcript 结构（2026-05-30 主对话真机核实 a34c8eba...jsonl）：
 *   - 真飞书入站：{type:"user", message:{content:"<channel source=\"feishu-channel\" ... sender_type=\"human|bot\" message_id=\"om_...\" ...>正文</channel>"}}（content 是字符串）
 *   - 品品回复：{type:"assistant", message:{content:[{type:"tool_use", name:"mcp__feishu-channel__pinpin_reply_text", ...}]}}（content 是数组）
 *   - tool_result：{type:"user", message:{content:[{type:"tool_result",...}]}}（content 是数组 → 靠 string/array 区分，不会误当入站）
 *   - 系统触发：channel 字符串里含 trigger="..."（不兜底，系统触发自有其行为协议）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 放行集：调了这些"用户可见输出工具"任一 = 本轮有交代，放行（带 mcp__feishu-channel__ 前缀）。
const ALLOW_TOOLS = new Set([
  'mcp__feishu-channel__pinpin_reply_text',
  'mcp__feishu-channel__pinpin_reply_voice',
  'mcp__feishu-channel__pinpin_react',
  'mcp__feishu-channel__pinpin_no_reply',
  'mcp__feishu-channel__cross_chat_message',
  'mcp__feishu-channel__send_private_message',
  'mcp__feishu-channel__relay_message',
  'mcp__feishu-channel__send_card',
  'mcp__feishu-channel__send_poll_card',
  'mcp__feishu-channel__pinpin_send_file',
  'mcp__feishu-channel__create_cloud_doc',
  'mcp__feishu-channel__create_group',
  'mcp__feishu-channel__disband_group',
]);

// 上游 bug 自愈：Opus 4.8 偶发「想调工具但没真调出来」，两种形态都致消息漏回——
//   形态①：把工具调用写成文字（assistant text 含 <invoke name= 形状），没发真 tool_use（CLI 常注入
//           "tool call was malformed" 提示自纠，但若那轮最终没调回复工具仍漏）。
//   形态②：真发了调用但 JSON 解析失败，报 "could not be parsed (retry also failed)"（CLI 重试也失败的终态）。
// 同一入站累计这么多次工具调用故障后放行，避免连撞故障时无限拦死品品。
// 计数靠 transcript 里 assistant 故障产出行数（单调递增、必达上限），不依赖 marker，无死循环风险。
const MAX_HEAL_RETRIES = 3;
const PARSE_ERROR_SIGNATURE = 'could not be parsed';

function pass() {
  process.exit(0); // 放行：不输出 decision 即允许品品正常停下
}

function main() {
  // 1. 读 stdin JSON（Stop hook 输入）
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    return pass();
  }
  let input;
  try {
    input = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (_) {
    return pass();
  }

  const transcriptPath = input.transcript_path;
  const sessionId = input.session_id || 'unknown';
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return pass();

  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch (_) {
    return pass();
  }

  // 2. 反向找最近"真飞书入站"
  let inboundIdx = -1;
  let inboundMsgId = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch (_) {
      continue;
    }
    if (!o || o.type !== 'user' || !o.message) continue;
    const c = o.message.content;
    if (typeof c !== 'string') continue; // tool_result 是数组 → 排除
    if (c.indexOf('source="feishu-channel"') === -1) continue;
    const isHumanOrBot =
      c.indexOf('sender_type="human"') !== -1 || c.indexOf('sender_type="bot"') !== -1;
    if (!isHumanOrBot) continue; // 系统/未知不兜底
    if (c.indexOf('trigger=') !== -1) continue; // 系统触发不兜底
    inboundIdx = i;
    const m = c.match(/message_id="(om_[^"]+)"/);
    inboundMsgId = m ? m[1] : 'idx' + i;
    break;
  }
  if (inboundIdx === -1) return pass(); // 本轮无真飞书入站 → 不管

  // 3. 从入站之后扫：① 调了放行工具 → 放行；② 统计「工具调用故障」次数（两形态合计，自愈计数）。
  //    只数 assistant 产出行（每次故障 1 条，精确不重复），不数 CLI 注入的 user 纠错提示。
  let toolFailCount = 0;
  for (let i = inboundIdx + 1; i < lines.length; i++) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch (_) {
      continue;
    }
    if (!o || o.type !== 'assistant' || !o.message) continue;
    const mc = o.message.content;
    // 形态②：报错行 isApiErrorMessage=true 且文本含 signature（content 可能 string 或 [{text}] 数组）。
    if (o.isApiErrorMessage === true) {
      const errText =
        typeof mc === 'string'
          ? mc
          : Array.isArray(mc)
            ? mc.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('')
            : '';
      if (errText.indexOf(PARSE_ERROR_SIGNATURE) !== -1) toolFailCount++;
      continue;
    }
    if (!Array.isArray(mc)) continue;
    // 形态①：把工具调用写成 text（含 <invoke name= / antml:invoke 形状），没发真 tool_use。
    let wroteToolAsText = false;
    for (const part of mc) {
      if (part && part.type === 'tool_use' && ALLOW_TOOLS.has(part.name)) return pass();
      if (
        part &&
        part.type === 'text' &&
        typeof part.text === 'string' &&
        (part.text.indexOf('<invoke name=') !== -1 || part.text.indexOf('antml:invoke') !== -1)
      ) {
        wroteToolAsText = true;
      }
    }
    if (wroteToolAsText) toolFailCount++;
  }

  // 4. 没调任何放行工具。分两种情况：
  // (a) 工具调用故障场景（toolFailCount>=1，形态①写成文字 / 形态②解析失败）：未达上限 → 继续拦逼重试
  //     （自愈引导话术）；达上限 → 放行，避免连撞故障时无限拦死。计数靠 transcript assistant 故障行数
  //     （单调递增、必达上限），不依赖 marker，无死循环风险。
  if (toolFailCount >= 1) {
    if (toolFailCount >= MAX_HEAL_RETRIES) return pass();
    const healReason =
      '⚠️ 上一轮你的回复没真正发出去——工具调用没生效（可能把调用写成了文字没真执行、或底层偶发故障）。' +
      '请重新、干脆地真正调用 pinpin_reply_text 工具把话发出来：务必是真的工具调用，' +
      '别把 <invoke>/工具调用文本打进回复内容；这轮思考也尽量简洁（长篇思考更易再次触发）。';
    process.stdout.write(JSON.stringify({ decision: 'block', reason: healReason }));
    return process.exit(0);
  }

  // (b) 品品真没调工具（偷懒/漏）→ 原防循环 marker 检查（同一入站只拦一次）+ 原逼补话术。
  const markerPath = path.join(os.tmpdir(), 'pinpin-stopgate-' + sessionId + '.json');
  try {
    const prev = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (prev && prev.blockedMsgId === inboundMsgId) return pass(); // 已拦过同一入站 → 放行防死循环
  } catch (_) {
    /* 无 marker / 坏 marker → 继续拦 */
  }

  // 5. 拦截：写 marker + 输出 block
  try {
    fs.writeFileSync(markerPath, JSON.stringify({ blockedMsgId: inboundMsgId }), 'utf8');
  } catch (_) {
    /* marker 写不了也照拦，只是极端情况下次可能重拦一次（仍 fail-safe） */
  }
  const reason =
    '本轮有消息但你既没发回复也没调 pinpin_no_reply。打在 CLI 用户看不到。' +
    '要回就调 pinpin_reply_text / pinpin_reply_voice / pinpin_react；' +
    '本就不该回就调 pinpin_no_reply（空操作、判断留内部、绝不逼你硬发，只留个"我看过决定不回"的痕）。二选一调一个即可。';
  process.stdout.write(JSON.stringify({ decision: 'block', reason: reason }));
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0); // 顶层兜底 fail-open
}
