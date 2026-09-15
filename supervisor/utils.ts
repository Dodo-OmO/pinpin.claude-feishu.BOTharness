// supervisor 共用小工具（供 channel-cli.ts 共享）

import { execSync } from 'node:child_process';

/** node-pty spawn 不走 shell——必须绝对路径。
 *  优先级：PINPIN_CLAUDE_PATH env → where claude.exe → 'claude' 兜底 */
export function resolveClaudePath(): string {
  if (process.env['PINPIN_CLAUDE_PATH']) return process.env['PINPIN_CLAUDE_PATH'];
  const cmd = process.platform === 'win32' ? 'where claude.exe' : 'which claude';
  try {
    const out = execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0].trim();
    if (out) return out;
  } catch {
    /* fall through */
  }
  return 'claude';
}

/** ANSI escape sequence 清理（启动期 auto-confirm 文本匹配用） */
export const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

/** 单轮 API 失败重试次数加固（CLI 原生默认 10，env override）。调高 = 多扛网络瞬时抖动、抖动过去自动接上。 */
const PINPIN_API_MAX_RETRIES = process.env['PINPIN_API_MAX_RETRIES'] ?? '20';

/** Claude CLI 联网 env（网络 + 重试）单源——channel-cli spawn 共用。
 *  缺则该 CLI 一发 API 请求即被对华封锁返 403。大小写各注入一份（Node 认大写、部分依赖只认小写）。
 *  须铺在 `...process.env` 之后注入，覆盖宿主可能残留的空/错网络。 */
export function claudeApiNetEnv(): Record<string, string> {
  return {
    CLAUDE_CODE_MAX_RETRIES: PINPIN_API_MAX_RETRIES,
  };
}
