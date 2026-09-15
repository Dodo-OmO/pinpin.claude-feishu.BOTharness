#!/usr/bin/env node
// PreToolUse hook（matcher: Bash|PowerShell，注册在 ~/.claude/settings.json，对本机所有 Claude Code 会话生效）。
// 只看含 lark-cli 的命令：
//  ① 全机一律拒 `lark-cli event …`：品品 supervisor 已用同一飞书应用长连接收事件，飞书长连接为集群模式
//     （同应用多客户端只投一个），再起 event bus daemon 会抢走品品的消息。
//  ② 品品全家（启动器注入 PINPIN_LARK_GUARD=1，频道 CLI / MCP 子进程继承）再拒：
//     切 profile / 覆盖 LARKSUITE_CLI_* 环境变量 / profile·config 管理 / 登录登出 / 自升级。
//     身份主闸是品品专用配置目录的 strict-mode bot，本 hook 是防误用的第二道闸。
//  脚本任何异常 → 放行（exit 0），绝不拖累全机 Bash 工具。
'use strict';

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[lark-guard] ${reason}` },
  }));
  process.exit(0);
}

try {
  const raw = require('node:fs').readFileSync(0, 'utf8');
  if (!raw) process.exit(0);
  const cmd = String(JSON.parse(raw)?.tool_input?.command ?? '');
  if (!/lark-cli|@larksuite[\\/]cli/i.test(cmd)) process.exit(0);

  // lark-cli 可执行体的各种写法：lark-cli / lark-cli.exe / lark-cli.cmd / …\lark-cli.exe" / run.js
  const BIN = String.raw`(?:lark-cli(?:\.exe|\.cmd)?|run\.js)["']?\s+`;
  const sub = (name) => new RegExp(BIN + name + String.raw`\b`, 'i');

  if (sub('event').test(cmd)) {
    deny('本机品品已用它的各个飞书应用长连接收事件（集群模式只投一个客户端），`lark-cli event …` 会抢走品品的消息，任何会话都禁止。');
  }
  if (process.env.PINPIN_LARK_GUARD !== '1') process.exit(0);

  // Owner私聊频道（PINPIN_CHAT_ID === PINPIN_OWNER_CHAT_ID）例外：允许 `auth login`——
  // Owner身份授权失效时品品在私聊里自己发起设备码授权、把链接发给Owner点，不让她跑命令。
  const isDm = !!process.env.PINPIN_CHAT_ID && process.env.PINPIN_CHAT_ID === process.env.PINPIN_OWNER_CHAT_ID;
  const rules = [
    [/--profile\b/, '切换 profile'],
    [/LARKSUITE_CLI_/, '覆盖 lark-cli 环境变量'],
    [sub('profile'), 'profile 管理'],
    [sub('config'), 'lark-cli 配置管理'],
    [isDm ? new RegExp(BIN + String.raw`auth\s+logout\b`, 'i') : new RegExp(BIN + String.raw`auth\s+(?:login|logout)\b`, 'i'), isDm ? '登出' : '登录 / 登出'],
    [sub('update'), 'lark-cli 自升级'],
  ];
  for (const [re, what] of rules) {
    if (re.test(cmd)) deny(`品品不能做「${what}」——身份/配置由启动器固定（群里=机器人身份，Owner私聊=Owner身份），要改找Owner在她自己的窗口操作。`);
  }
  process.exit(0);
} catch {
  process.exit(0);
}
