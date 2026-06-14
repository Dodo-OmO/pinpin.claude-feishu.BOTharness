// 发送者昵称解析——人类查飞书 contact API + known_users DB 兜底。
// 从 早期版本 src/feishu/api.ts:getUserName 搬迁。
//
// bot 花名册相关（resolveBotName / loadBotRoster / logUnknownBotOnce）已抽到 ./bot-roster.js
// （纯 env、无 DB/飞书依赖，供 supervisor 侧 buildInstructions 安全 import）；本文件 re-export
// 保持 reply-quote / chat-message 等调用方 import 路径不变。
//
// MCP 版差异：
// - 没有 config 模块，FEISHU_KNOWN_USERS 直接读 process.env JSON 字符串
// - log 走 process.stderr.write（避免污染 stdio JSON-RPC）

import { getFeishuClient } from "../tools/feishu-send.js";
import { getKnownUserName, seedKnownUsers } from "../db/database.js";
import { parseEnvMap } from "../../shared/sender-shared.js";

export { resolveBotName, loadBotRoster, logUnknownBotOnce } from "./bot-roster.js";

// ── FEISHU_KNOWN_USERS env 解析（一次性缓存）──
// 兼容两种格式（跟 早期版本 .env 同款）：
//   ① `ou_xxx:名字,ou_yyy:名字`（冒号分隔单条 + 逗号分隔多条，早期版本用法）
//   ② `{"ou_xxx":"名字",...}`（JSON 对象，备选）
let _envKnownUsersCache: Map<string, string> | null = null;
function getEnvKnownUsers(): Map<string, string> {
  if (_envKnownUsersCache) return _envKnownUsersCache;
  _envKnownUsersCache = new Map(Object.entries(parseEnvMap(process.env.FEISHU_KNOWN_USERS)));
  return _envKnownUsersCache;
}

// C2 身份归一：known_users DB 是真人映射的**单一运行时权威源**。
// FEISHU_KNOWN_USERS env 只作"启动种子"——server.ts 启动时调本函数把 env 里
// contact API 查不到的成员（如User A）灌进 DB（ON CONFLICT DO NOTHING），
// 之后运行时一律查 DB（getKnownUserName / resolveOpenId），不再并行查 env。
export function seedKnownUsersFromEnv(): void {
  const m = getEnvKnownUsers();
  if (m.size === 0) return;
  const entries = Array.from(m.entries()).map(([openId, name]) => ({ openId, name }));
  seedKnownUsers(entries);
  process.stderr.write(`[sender-names] 已用 FEISHU_KNOWN_USERS 种子 ${entries.length} 条灌入 known_users DB\n`);
}

// ── 人类用户名缓存（永不过期，重启刷新）──
const userNameCache = new Map<string, string>();

/**
 * 通过 open_id 获取用户真实姓名（优先 name，回退 nickname，再回退 open_id 后 8 字符）。
 * 任何调用失败都不抛——返回 fallback 兜底，保证 inbound 通道不阻塞。
 */
export async function getUserName(openId: string): Promise<string> {
  if (!openId) return "未知用户";
  const cached = userNameCache.get(openId);
  if (cached) return cached;
  const fallback = openId.length > 8 ? openId.slice(-8) : openId;
  try {
    const res = await getFeishuClient().contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: "open_id" },
    });
    const name = res.data?.user?.name?.trim() || res.data?.user?.nickname?.trim();
    if (name) {
      userNameCache.set(openId, name);
      return name;
    }
    // API 成功但字段空 → 缓存 fallback 避免反复请求
    userNameCache.set(openId, fallback);
    return fallback;
  } catch (e) {
    // 飞书业务 code 在 e.response.data.code；AxiosError 的 e.code 是字符串需 || 兜底
    const feishuCode = (e as { response?: { data?: { code?: number } } })?.response?.data?.code;
    const errCode = feishuCode || (e as { code?: number })?.code;
    // 41050 = no user authority：bot 账号 / 通讯录可见范围外成员 → 查 known_users DB（单一权威源，
    // 启动时已由 seedKnownUsersFromEnv 把 FEISHU_KNOWN_USERS 种子灌入，故种子成员必命中）
    if (errCode === 41050) {
      const mappedName = getKnownUserName(openId);
      if (mappedName) {
        userNameCache.set(openId, mappedName);
        process.stderr.write(
          `[sender-names] getUserName ${openId} → "${mappedName}" (41050, known_users DB 命中)\n`,
        );
        return mappedName;
      }
      userNameCache.set(openId, fallback);
      process.stderr.write(
        `[sender-names] getUserName ${openId} → fallback (41050 no user authority; 同企业成员请检查飞书后台「通讯录数据可见范围」或 .env FEISHU_KNOWN_USERS 手动配)\n`,
      );
      return fallback;
    }
    const httpStatus = (e as { response?: { status?: number } })?.response?.status;
    process.stderr.write(
      `[sender-names] getUserName 失败 ${openId} (HTTP ${httpStatus ?? "?"}, code ${feishuCode ?? "?"}): ${e instanceof Error ? e.message : e}\n`,
    );
    userNameCache.set(openId, fallback);
    return fallback;
  }
}
