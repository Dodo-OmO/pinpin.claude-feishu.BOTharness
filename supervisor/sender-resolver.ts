/**
 * 发送者昵称解析（supervisor 端）—— src/mcp/utils/sender-names.ts 的精简同款搬迁。
 *
 * 跟子 MCP server 端区别：
 *   - 不绑定 src/mcp/tools/feishu-send 的 client；用 supervisor/feishu-client 自己的（多应用 Map）
 *   - 同步 fallback 路径：先 env 命中（BOT_NAME_MAP / FEISHU_KNOWN_USERS，合并全部应用 / cache）→ 返真名
 *     未命中 → 返 fallback（slice -8）+ 异步预热缓存（下次同 sender 拿真名）
 *   - 异步预热不阻塞日志 push（main.ts pushLog 是同步路径）
 *   - 多应用：预热逐个试各飞书应用的 client（appId 命中的优先），41050 只说明该 app 缺权限，换下一个再试
 *
 * env 协议同 src/mcp/utils/sender-names.ts，重启 launcher 即生效。
 */

import { listFeishuClients } from "./feishu-client.js";
import { loadFeishuApps } from "./feishu-apps.js";
import { parseEnvMap, resolveMentions } from "../src/shared/sender-shared.js";
import {
  getHumanNameMapping,
  getBotNameMapping,
} from "../src/shared/name-map-store.js";
export type { FeishuMentionShared as FeishuMention } from "../src/shared/sender-shared.js";

// 跨应用合并（appRoot 传空串——这里只取 knownUsers/botRoster 字段，larkBotDir 不用）。
// 惰性构建：本模块随 ESM import 早于 main.ts 的 dotenv.config() 执行，模块顶层读 process.env 只会拿到空表。
let envMaps: {
  bots: Record<string, string>;
  users: Record<string, string>;
} | null = null;
function envNameMaps(): {
  bots: Record<string, string>;
  users: Record<string, string>;
} {
  if (envMaps) return envMaps;
  const apps = loadFeishuApps(process.env, "");
  const built = {
    bots: {} as Record<string, string>,
    users: {} as Record<string, string>,
  };
  for (const a of apps) {
    Object.assign(built.bots, parseEnvMap(a.botRoster));
    Object.assign(built.users, parseEnvMap(a.knownUsers));
  }
  if (apps.length > 0) envMaps = built; // env 还没加载（无应用）时不缓存空表，下次再建
  return built;
}

/** 同步 user 缓存（首次返 fallback，async 预热后下次命中） */
const userNameCache = new Map<string, string>();
/** 进行中的 API 反查（open_id → promise）：fire-and-forget 与 await 两种调用方共用同一个 promise，不互相打断 */
const inflightLookups = new Map<string, Promise<void>>();

/** 同步反查：name-map-store（Owner启动器改的实时映射，最高优先）→ bot/user env → cache → fallback（slice -8） */
export function resolveSenderNameSync(
  senderOpenId: string,
  senderType: "user" | "app",
  appId?: string,
): string {
  if (!senderOpenId) return "?";
  if (senderType === "app") {
    const mapped = getBotNameMapping(senderOpenId);
    if (mapped) return mapped;
    return envNameMaps().bots[senderOpenId] ?? senderOpenId.slice(-8);
  }
  // user
  const mapped = getHumanNameMapping(senderOpenId);
  if (mapped) return mapped;
  const envName = envNameMaps().users[senderOpenId];
  if (envName) return envName;
  const cached = userNameCache.get(senderOpenId);
  if (cached) return cached;
  // 触发异步预热（下次 hit）
  void primeUserName(senderOpenId, appId);
  return senderOpenId.slice(-8);
}

/** 异步预热 user name —— 不阻塞 caller，结果缓存供下次 sync 命中。
 *  多应用：appId 命中的 client 优先试，其余全部应用逐个兜底试（41050 只代表该 app 无权限，换下一个）。
 *  全部应用都试完且至少一个 41050 才缓存 fallback（slice -8）；全部因非 41050 错误失败则不缓存，允许下次重试。 */
function primeUserName(openId: string, appId?: string): Promise<void> {
  if (userNameCache.has(openId)) return Promise.resolve();
  const inflight = inflightLookups.get(openId);
  if (inflight) return inflight;
  const p = lookupUserName(openId, appId).finally(() =>
    inflightLookups.delete(openId),
  );
  inflightLookups.set(openId, p);
  return p;
}

async function lookupUserName(openId: string, appId?: string): Promise<void> {
  const all = listFeishuClients();
  const ordered = appId
    ? [
        ...all.filter((c) => c.appId === appId),
        ...all.filter((c) => c.appId !== appId),
      ]
    : all;
  let anyAuthDenied = false;
  for (const { appId: candidateAppId, client } of ordered) {
    try {
      const res = await client.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: "open_id" },
      });
      const name =
        res.data?.user?.name?.trim() || res.data?.user?.nickname?.trim();
      if (name) {
        userNameCache.set(openId, name);
        return;
      }
    } catch (e) {
      const feishuCode = (e as { response?: { data?: { code?: number } } })
        ?.response?.data?.code;
      if (feishuCode === 41050) {
        anyAuthDenied = true;
        process.stderr.write(
          `[sender-resolver] ${openId} app=${candidateAppId.slice(0, 8)}… 41050（该应用无权读用户名，试下一个应用）\n`,
        );
      } else {
        process.stderr.write(
          `[sender-resolver] getUserName 失败 ${openId} app=${candidateAppId.slice(0, 8)}…: ${e instanceof Error ? e.message : e}\n`,
        );
      }
    }
  }
  // 全部应用都试完仍未拿到名字：只有出现过 41050（明确无权限，非临时网络错误）才缓存 fallback 避免反复请求
  if (anyAuthDenied) {
    userNameCache.set(openId, openId.slice(-8));
  }
}

/** 异步反查用户全名：同步源命中直接返；否则等 API 预热后再取。拿不到返 undefined（不返 slice 兜底）。 */
export async function resolveUserNameAsync(
  openId: string,
  appId?: string,
): Promise<string | undefined> {
  const known =
    getHumanNameMapping(openId) ??
    envNameMaps().users[openId] ??
    userNameCache.get(openId);
  if (known && known !== openId.slice(-8)) return known;
  await primeUserName(openId, appId);
  const cached = userNameCache.get(openId);
  return cached && cached !== openId.slice(-8) ? cached : undefined;
}

export { resolveMentions };
