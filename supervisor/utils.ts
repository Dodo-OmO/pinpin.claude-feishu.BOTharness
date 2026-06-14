// supervisor 共用小工具（供 channel-cli.ts / work-session.ts 共享）

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
