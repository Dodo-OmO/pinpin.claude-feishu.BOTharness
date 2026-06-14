/**
 * 飞书自带任务集成：user_access_token 生命周期管理（MCP 版）
 *
 * 阶段 4 批次 0 步骤 0.3：从 早期版本 src/feishu/feishu-token.ts (376 行) CLI 优雅重写
 * CLI 优雅化改动：
 *   1. 砍 ../utils/config.js 抽象层 → 直接 process.env（MCP 版无需独立 config）
 *   2. alertReauth 复用 feishu-send getFeishuClient 直发 OWNER open_id 私聊（发送失败回落 stderr 留痕）
 *   3. 保留所有核心三态机 / Promise 锁 / 原子写 / 24h 告警去重逻辑
 *
 * source-driven（已对飞书官方文档 + @larksuiteoapi/node-sdk 1.65.0）：
 * - 换/刷统一 POST https://open.feishu.cn/open-apis/authen/v2/oauth/token（弃 v1）
 *   换码 grant_type=authorization_code + code + redirect_uri；刷 grant_type=refresh_token
 *   公共 client_id=APP_ID / client_secret=APP_SECRET
 * - 响应 access_token / expires_in(~2h) / refresh_token / refresh_token_expires_in
 *   (非固定示例7天，**勿硬编码读响应**) / scope / token_type=Bearer
 * - 刷新后原 refresh_token 立即失效返新的（必须原子持久化新的，丢=断链需重授权）
 * - 用户授权满 365 天必须重新授权（绝对硬顶，无法纯无人值守永续）
 * - scope 需 offline_access（不带不返 refresh_token）+ task:task:write + task:tasklist:write + task:section:write
 *
 * 三态机（getUserToken / 每日 keepalive 共用）：
 *   态1 无 token 文件 = 未授权 → 抛带引导 Error（keepalive 静默跳过不打扰）
 *   态2 access 临期 / 过期但 refresh 有效 → 自动刷新
 *   态3 refresh 过期 / 刷新被拒 / 授权满 365 天 → 私聊Owner带授权链接（24h 去重）+ 抛引导 Error
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getMeta, setMeta } from "../db/database.js";
import { getFeishuClient } from "../tools/feishu-send.js";

// 与 database.ts 相同的项目根推算（MCP server 被 vault spawn 时 cwd≠代码包根）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, "..", "..", "..", ".feishu-user-token.json");

const OAUTH_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const AUTHORIZE_BASE = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";

// 建/改/删任务 + 建清单/分组 + 拿 refresh_token 所需 scope
// （飞书后台「权限管理」须同步开启这 4 个，缺一对应功能 403）
export const REQUIRED_SCOPE =
  "task:task:write task:tasklist:write task:section:write offline_access";

// access 剩余 < 此值即视为临期，提前惰性刷新（避免边界竞态）
const ACCESS_REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 分钟
// refresh 剩余 < 此值，每日 keepalive 主动刷一次续期（防 bot 空闲期 refresh 过期）
const REFRESH_KEEPALIVE_MARGIN_MS = 3 * 24 * 60 * 60 * 1000; // 3 天
// 授权绝对硬顶（飞书官方：满 365 天必须重新授权），本地提前判给清晰引导
const AUTH_ABSOLUTE_MAX_MS = 365 * 24 * 60 * 60 * 1000;
// 态3 私聊Owner重授权告警去重窗（避免每次调用都轰炸）
const REAUTH_ALERT_DEDUP_MS = 24 * 60 * 60 * 1000;
const REAUTH_ALERT_META_KEY = "feishu_token_reauth_alerted_at";

export interface FeishuUserToken {
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  refresh_expires_at: number;
  scope: string;
  obtained_at: number;
  last_refresh_at: number;
}

/** 未授权 / 需重新授权——调用方 catch 转 bot 错误自动引导话术 */
export class FeishuAuthError extends Error {
  constructor(
    message: string,
    public readonly kind: "unauthorized" | "reauth"
  ) {
    super(message);
    this.name = "FeishuAuthError";
  }
}

// ── 原子读写 ────────────────────────────────────────────────

function readToken(): FeishuUserToken | null {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    const raw = fs.readFileSync(TOKEN_FILE, "utf-8");
    const t = JSON.parse(raw) as FeishuUserToken;
    if (!t.access_token || !t.refresh_token) {
      process.stderr.write("[feishu-token] token 文件字段缺失，按未授权处理\n");
      return null;
    }
    return t;
  } catch (e) {
    process.stderr.write(
      `[feishu-token] token 文件解析失败，按未授权处理: ${e instanceof Error ? e.message : e}\n`
    );
    return null;
  }
}

/** 原子写：写 .tmp → rename（rename 原子，防刷新中崩溃损坏主文件） */
function writeToken(t: FeishuUserToken): void {
  const tmp = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2), "utf-8");
  fs.renameSync(tmp, TOKEN_FILE);
}

// ── env 读取（替代 早期版本 utils/config.js 抽象层）────────────

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new FeishuAuthError(
      `缺环境变量 ${key}——请在 .env 文件配置好（详见飞书集成文档）。`,
      "unauthorized"
    );
  }
  return v;
}

// ── OAuth HTTP（自写，SDK 无 helper）────────────────────────

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  code?: number;
  error?: string;
  error_description?: string;
  msg?: string;
}

async function postOAuthToken(body: Record<string, string>): Promise<FeishuUserToken> {
  let resp: Response;
  try {
    resp = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(
      `飞书 OAuth 接口网络请求失败：${e instanceof Error ? e.message : String(e)}`
    );
  }

  let data: OAuthTokenResponse;
  try {
    data = (await resp.json()) as OAuthTokenResponse;
  } catch {
    throw new Error(`飞书 OAuth 接口返回非 JSON（HTTP ${resp.status}）`);
  }

  const failed =
    !resp.ok ||
    !data.access_token ||
    (typeof data.code === "number" && data.code !== 0) ||
    !!data.error;
  if (failed) {
    const reason =
      data.error_description || data.error || data.msg || `HTTP ${resp.status}`;
    const err = new Error(`飞书 OAuth 失败：${reason}`);
    (err as Error & { oauthFailed?: boolean }).oauthFailed = true;
    throw err;
  }

  const now = Date.now();
  return {
    access_token: data.access_token!,
    refresh_token: data.refresh_token ?? "",
    access_expires_at: now + (data.expires_in ?? 0) * 1000,
    // offline_access 下飞书恒返 refresh_token_expires_in；缺失/<=0 = 响应异常，
    // 用保守下限（6 天 < 示例 7 天）避免置 now 触发态3 误打扰Owner"授权过期"
    refresh_expires_at:
      now +
      (data.refresh_token_expires_in && data.refresh_token_expires_in > 0
        ? data.refresh_token_expires_in
        : 6 * 24 * 60 * 60) *
        1000,
    scope: data.scope ?? "",
    obtained_at: now,
    last_refresh_at: now,
  };
}

// ── 授权 URL（授权工具用）─────────────────────────────────────

/** 构造授权页 URL（state 仅作无害随机参数；品品是手动贴 code 流程、无浏览器回调，不做 CSRF 校验） */
export function buildAuthorizeUrl(): { url: string; state: string } {
  const redirect = process.env.FEISHU_OAUTH_REDIRECT_URI;
  if (!redirect) {
    throw new FeishuAuthError(
      "还没配飞书授权回调地址——需要在 .env 设 FEISHU_OAUTH_REDIRECT_URI，" +
        "并在飞书开放平台「安全设置→重定向 URL」加同一个网址（任意 https 占位即可）。",
      "unauthorized"
    );
  }
  const appId = requireEnv("FEISHU_APP_ID");
  const state = randomUUID();
  const url =
    `${AUTHORIZE_BASE}?client_id=${encodeURIComponent(appId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&scope=${encodeURIComponent(REQUIRED_SCOPE)}` +
    `&state=${encodeURIComponent(state)}`;
  return { url, state };
}

/** 用授权码换 token 并落盘（Owner贴 code 后调） */
export async function exchangeCodeForToken(code: string): Promise<void> {
  const redirect = process.env.FEISHU_OAUTH_REDIRECT_URI;
  if (!redirect) {
    throw new FeishuAuthError(
      "缺 FEISHU_OAUTH_REDIRECT_URI，没法换取授权——先在 .env 和飞书后台配好回调地址。",
      "unauthorized"
    );
  }
  let token: FeishuUserToken;
  try {
    token = await postOAuthToken({
      grant_type: "authorization_code",
      client_id: requireEnv("FEISHU_APP_ID"),
      client_secret: requireEnv("FEISHU_APP_SECRET"),
      code: code.trim(),
      redirect_uri: redirect,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FeishuAuthError(
      `授权没换成：${msg}。授权码飞书只给 5 分钟且用一次就失效——` +
        `重新点一次授权链接、复制新码后尽快发我。`,
      "reauth"
    );
  }
  if (!token.refresh_token) {
    throw new FeishuAuthError(
      "换到 token 但没拿到 refresh_token——多半是飞书后台没开 offline_access 权限，" +
        "去开放平台「权限管理」加上 offline_access 再重新授权一次。",
      "reauth"
    );
  }
  writeToken(token);
  clearReauthAlert();
  process.stderr.write("[feishu-token] 授权成功，user_access_token 已落盘\n");
}

// ── 刷新 + 三态机 ──────────────────────────────────────────

let refreshPromise: Promise<FeishuUserToken> | null = null;

/** 用 refresh_token 刷新；刷新后原 refresh 立即失效，必须原子写回新的。
 *  obtained_at 保留旧值（365 天硬顶基准从首次授权算，刷新不重置） */
async function doRefresh(old: FeishuUserToken): Promise<FeishuUserToken> {
  let fresh: FeishuUserToken;
  try {
    fresh = await postOAuthToken({
      grant_type: "refresh_token",
      client_id: requireEnv("FEISHU_APP_ID"),
      client_secret: requireEnv("FEISHU_APP_SECRET"),
      refresh_token: old.refresh_token,
    });
  } catch (e) {
    const oauthFailed = !!(e as Error & { oauthFailed?: boolean }).oauthFailed;
    if (oauthFailed) {
      await alertReauth(
        `飞书任务授权失效了（${e instanceof Error ? e.message : e}）`
      );
      throw new FeishuAuthError(
        "飞书任务授权失效，需要重新授权一次。",
        "reauth"
      );
    }
    throw e;
  }
  const merged: FeishuUserToken = { ...fresh, obtained_at: old.obtained_at };
  writeToken(merged);
  clearReauthAlert();
  return merged;
}

/**
 * 取一个可用 access_token。三态机 + access 惰性刷新 + 并发 Promise 锁。
 * @param opts.keepalive true=每日保活模式：refresh 临期才刷、无文件静默返 null 不抛
 */
export async function getUserToken(opts?: { keepalive?: boolean }): Promise<string | null> {
  const keepalive = opts?.keepalive ?? false;
  const tok = readToken();

  // 态1：未授权
  if (!tok) {
    if (keepalive) return null;
    throw new FeishuAuthError(
      "还没授权飞书任务——私聊我「授权飞书任务」走一次授权（一年一次）。",
      "unauthorized"
    );
  }

  const now = Date.now();

  // 态3-a：授权满 365 天硬顶
  if (now - tok.obtained_at >= AUTH_ABSOLUTE_MAX_MS) {
    await alertReauth("飞书任务授权满 1 年了（飞书规定满 365 天必须本人重新授权）");
    if (keepalive) return null;
    throw new FeishuAuthError(
      "飞书任务授权满 1 年，需要你本人重新授权一次（飞书平台强制，绕不过）。",
      "reauth"
    );
  }

  // 态3-b：refresh_token 已过期
  if (now >= tok.refresh_expires_at) {
    await alertReauth("飞书任务长时间没续上，授权已过期");
    if (keepalive) return null;
    throw new FeishuAuthError(
      "飞书任务授权过期了，需要重新授权一次。",
      "reauth"
    );
  }

  const accessStale = now >= tok.access_expires_at - ACCESS_REFRESH_MARGIN_MS;
  const refreshNearExpiry =
    now >= tok.refresh_expires_at - REFRESH_KEEPALIVE_MARGIN_MS;
  const needRefresh = keepalive ? refreshNearExpiry : accessStale;

  if (!needRefresh) {
    return tok.access_token;
  }

  // 态2：刷新（Promise 锁——并发调用只发一次刷新请求）
  if (!refreshPromise) {
    refreshPromise = doRefresh(tok).finally(() => {
      refreshPromise = null;
    });
  }
  try {
    const refreshed = await refreshPromise;
    return refreshed.access_token;
  } catch (e) {
    if (keepalive && e instanceof FeishuAuthError) return null;
    throw e;
  }
}

/** 当前是否已授权（无 IO 副作用判断，工具/命令快速分支用） */
export function isFeishuAuthorized(): boolean {
  return readToken() !== null;
}

// ── 态3 私聊Owner告警（24h 去重，防轰炸）────────────────────

function clearReauthAlert(): void {
  setMeta(REAUTH_ALERT_META_KEY, "0");
}

async function alertReauth(reason: string): Promise<void> {
  const last = Number(getMeta(REAUTH_ALERT_META_KEY) ?? "0");
  const now = Date.now();
  if (now - last < REAUTH_ALERT_DEDUP_MS) return;
  setMeta(REAUTH_ALERT_META_KEY, String(now));

  const ownerOpenId = process.env.FEISHU_OWNER_OPEN_ID;
  if (!ownerOpenId) {
    process.stderr.write(`[feishu-token] 需重新授权但未配 FEISHU_OWNER_OPEN_ID，无法私聊告警：${reason}\n`);
    return;
  }

  let urlPart: string;
  try {
    urlPart = buildAuthorizeUrl().url;
  } catch {
    urlPart = "（还需先在 .env / 飞书后台配好回调地址 FEISHU_OAUTH_REDIRECT_URI）";
  }

  const text =
    `飞书任务授权要续一下啦～（${reason}）。点这个链接重新授权，` +
    `然后把跳转后地址栏里 code= 后面那串复制发我就行（一年一次）：\n${urlPart}`;

  // 真私聊Owner（OWNER）：复用 feishu-send 的底层 client，直发 open_id text 消息。
  // 不走 send_private_message tool（那是给 LLM 调的、含 known_users 反查）——这里已有 open_id，直发最干净。
  try {
    await getFeishuClient().im.v1.message.create({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: ownerOpenId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  } catch (e) {
    // 私聊发不出去时回落 stderr 留痕，不静默吞掉
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[feishu-token] 重授权私聊告警发送失败（${msg}），原文：\n${text}\n`);
  }
}
