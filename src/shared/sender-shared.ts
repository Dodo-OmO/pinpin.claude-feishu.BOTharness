// 发送者解析共用逻辑（supervisor 端 sender-resolver.ts 与 MCP 端 chat-message.ts / sender-names.ts 共享）

/** 飞书 mention 条目（key = "@_user_N"，name = 真名） */
export interface FeishuMentionShared {
  key?: string;
  id?: string | { open_id?: string; user_id?: string; union_id?: string };
  id_type?: string;
  name?: string;
  tenant_key?: string;
}

/**
 * 解析 `ou_xxx:名字,ou_yyy:名字` 或 `{"ou_xxx":"名字"}` 格式的 env 字符串。
 * 返回 Record<open_id, name>。解析失败静默返回空对象。
 */
export function parseEnvMap(raw: string | undefined): Record<string, string> {
  const m: Record<string, string> = {};
  if (!raw || !raw.trim()) return m;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof k === 'string' && typeof v === 'string') m[k] = v;
      }
    } catch {
      /* 解析失败返空 */
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

/** 把消息 text 里的 @_user_N / @_chat_N 占位符替换为 @<真名> */
export function resolveMentions(
  text: string,
  mentions: FeishuMentionShared[] | undefined,
): string {
  if (!text || !mentions || mentions.length === 0) return text;
  let out = text;
  for (const m of mentions) {
    if (!m.key || !m.name) continue;
    out = out.split(m.key).join(`@${m.name}`);
  }
  return out;
}
