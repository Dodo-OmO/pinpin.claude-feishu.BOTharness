/**
 * 本机桥接口令——管家口（47900）与传话口（47901）共用。
 * supervisor 启动时 ensure（已有合法口令就沿用）；管家、本机 Claude 窗口等同机同用户客户端读同一文件。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BRIDGE_TOKEN_PATH = path.join(os.homedir(), '.pinpin', 'bridge-token');

/** 读口令；文件不存在返回空串 */
export function readBridgeToken(): string {
  try {
    return fs.readFileSync(BRIDGE_TOKEN_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

export function ensureBridgeToken(): string {
  const existing = readBridgeToken();
  if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  fs.mkdirSync(path.dirname(BRIDGE_TOKEN_PATH), { recursive: true });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(BRIDGE_TOKEN_PATH, token, 'utf8');
  return token;
}

/** 常量时间比对（given 来自连接帧，类型不可信） */
export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
