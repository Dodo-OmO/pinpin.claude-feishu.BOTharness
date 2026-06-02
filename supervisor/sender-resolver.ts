/**
 * 发送者昵称解析（supervisor 端）—— src/mcp/utils/sender-names.ts 的精简同款搬迁。
 *
 * 跟子 MCP server 端区别：
 *   - 不绑定 src/mcp/tools/feishu-send 的 client；用 supervisor/feishu-client 自己的
 *   - 同步 fallback 路径：先 env 命中（BOT_NAME_MAP / FEISHU_KNOWN_USERS / cache）→ 返真名
 *     未命中 → 返 fallback（slice -8）+ 异步预热缓存（下次同 sender 拿真名）
 *   - 异步预热不阻塞日志 push（main.ts pushLog 是同步路径）
 *
 * env 协议同 src/mcp/utils/sender-names.ts，重启 launcher 即生效。
 */

import { getFeishuClient } from './feishu-client.js';

// ── BOT_NAME_MAP env 解析（同 sender-names.ts:parseBotRosterEnv） ──
function parseEnvMap(envName: string): Record<string, string> {
  const raw = process.env[envName];
  const m: Record<string, string> = {};
  if (!raw || !raw.trim()) return m;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof k === 'string' && typeof v === 'string') m[k] = v;
      }
    } catch (e) {
      process.stderr.write(
        `[sender-resolver] ${envName} JSON 解析失败: ${e instanceof Error ? e.message : e}\n`,
      );
    }
    return m;
  }
  for (const pair of trimmed.split(',')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k && v) m[k] = v;
  }
  return m;
}

const BOT_NAME_MAP = parseEnvMap('FEISHU_BOT_ROSTER');
const ENV_KNOWN_USERS = parseEnvMap('FEISHU_KNOWN_USERS');

/** 同步 user 缓存（首次返 fallback，async 预热后下次命中） */
const userNameCache = new Map<string, string>();
const inflightLookups = new Set<string>();

/** 同步反查：bot env → user env → cache → fallback（slice -8） */
export function resolveSenderNameSync(senderOpenId: string, senderType: 'user' | 'app'): string {
  if (!senderOpenId) return '?';
  if (senderType === 'app') {
    return BOT_NAME_MAP[senderOpenId] ?? senderOpenId.slice(-8);
  }
  // user
  const envName = ENV_KNOWN_USERS[senderOpenId];
  if (envName) return envName;
  const cached = userNameCache.get(senderOpenId);
  if (cached) return cached;
  // 触发异步预热（下次 hit）
  void primeUserName(senderOpenId);
  return senderOpenId.slice(-8);
}

/** 异步预热 user name —— 不阻塞 caller，结果缓存供下次 sync 命中 */
async function primeUserName(openId: string): Promise<void> {
  if (inflightLookups.has(openId) || userNameCache.has(openId)) return;
  inflightLookups.add(openId);
  try {
    const res = await getFeishuClient().contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    });
    const name = res.data?.user?.name?.trim() || res.data?.user?.nickname?.trim();
    if (name) {
      userNameCache.set(openId, name);
    }
  } catch (e) {
    const feishuCode = (e as { response?: { data?: { code?: number } } })?.response?.data?.code;
    if (feishuCode === 41050) {
      // no user authority —— ENV_KNOWN_USERS 没配，缓存 fallback 避免反复请求
      userNameCache.set(openId, openId.slice(-8));
      process.stderr.write(
        `[sender-resolver] ${openId} 41050 (无权读用户名；可在 .env FEISHU_KNOWN_USERS 配 "${openId}:友好名" 显式映射)\n`,
      );
    } else {
      process.stderr.write(
        `[sender-resolver] getUserName 失败 ${openId}: ${e instanceof Error ? e.message : e}\n`,
      );
    }
  } finally {
    inflightLookups.delete(openId);
  }
}

// ── 飞书 mention 字段（raw.mentions 数组） ──
export interface FeishuMention {
  key?: string;       // "@_user_1"
  id?: { open_id?: string; user_id?: string; union_id?: string };
  name?: string;      // 真名
  tenant_key?: string;
}

/** 把消息 text 里的 @_user_N / @_chat_N 占位符替换为 @<真名>（同 chat-message.ts:resolveMentions） */
export function resolveMentions(text: string, mentions: FeishuMention[] | undefined): string {
  if (!text || !mentions || mentions.length === 0) return text;
  let out = text;
  for (const m of mentions) {
    if (!m.key || !m.name) continue;
    out = out.split(m.key).join(`@${m.name}`);
  }
  return out;
}
