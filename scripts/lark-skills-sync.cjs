#!/usr/bin/env node
// 把 lark-cli 二进制内嵌的全部 AI Agent Skills（SKILL.md + references）原样提取到
// %USERPROFILE%\.claude\skills\<name>\，与已装 lark-cli 版本严格一致。
// 用法：node scripts/lark-skills-sync.cjs        （lark-cli 升级后重跑一次即同步）
// 可选 env：LARK_CLI_BIN=<lark-cli 可执行文件绝对路径>（PATH 上找不到时用）
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BIN = process.env.LARK_CLI_BIN || 'lark-cli';
const DEST = path.join(os.homedir(), '.claude', 'skills');
const ENV = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };

function run(args, asBuffer = false) {
  return execFileSync(BIN, args, { env: ENV, maxBuffer: 64 * 1024 * 1024, encoding: asBuffer ? 'buffer' : 'utf8' });
}
function walk(p) {
  const j = JSON.parse(run(['skills', 'list', p]));
  const files = [];
  for (const e of j.entries) {
    if (e.is_dir) files.push(...walk(e.path));
    else files.push(e.path);
  }
  return files;
}

const version = run(['--version']).trim();
const skills = JSON.parse(run(['skills', 'list'])).skills;
let total = 0;
for (const s of skills) {
  const files = walk(s.name);
  const dir = path.join(DEST, s.name);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const out = path.join(DEST, ...f.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, run(['skills', 'read', f], true));
  }
  total += files.length;
  console.log(`${s.name}: ${files.length} files`);
}
console.log(`done: ${skills.length} skills, ${total} files, from ${version} → ${DEST}`);
