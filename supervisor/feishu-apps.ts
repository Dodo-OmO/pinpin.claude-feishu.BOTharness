/**
 * 多飞书应用配置——一个启动器同时挂 N 个飞书自建应用（每个 chat 归属且只归属一个应用）。
 *
 * .env 约定：应用 1 用无后缀字段（FEISHU_APP_ID …，向后兼容）= primary（兜底 + 历史数据归属）；
 * 应用 2..9 同名字段加 `_N` 后缀（FEISHU_APP_ID_2 …）。字段全集见 FeishuAppConfig 注释。
 * lark-cli bot 身份目录固定派生：应用 1 `<appRoot>/../lark-cli-pinpin`，应用 N `<appRoot>/../lark-cli-pinpin-N`。
 */

import path from 'node:path';

export interface FeishuAppConfig {
  /** 1 = primary（无后缀 env） */
  index: number;
  appId: string;
  appSecret: string;
  /** FEISHU_APP_LABEL[_N]：日志 / list_active_chats 标签 / vault 环境档案文件名；缺省 `app<N>` */
  label: string;
  /** FEISHU_OWNER_OPEN_ID[_N]：Owner在该应用下的 open_id（子进程 owner 判定） */
  ownerOpenId?: string;
  /** FEISHU_KNOWN_USERS[_N]：原样透传子进程（`ou:名,…` 或 JSON） */
  knownUsers?: string;
  /** FEISHU_BOT_ROSTER[_N]：原样透传子进程（`cli:名,…`） */
  botRoster?: string;
  /** FEISHU_PEER_USERS[_N]：同级放行名单 `ou:名,…`（instructions 权限段用） */
  peerUsers?: string;
  /** FEISHU_CHAT_ALLOWLIST[_N]：逗号分隔 chat_id；有值 → 该应用只服务这些 chat（其余群/私聊一律不理） */
  chatAllowlist?: Set<string>;
  /** FEISHU_ADD_DIRS[_N]：`;` 分隔的绝对路径——该应用所有频道默认外挂的知识目录（频道自己配了 addDirs 则以频道为准） */
  addDirs?: string[];
  /** lark-cli bot 身份配置目录（strict-mode bot） */
  larkBotDir: string;
  /** LARK_USER_CONFIG_DIR[_N]：Owner在该租户的 lark-cli 用户身份目录；未设 = lark-cli 默认 `~/.lark-cli` */
  larkUserDir?: string;
}

const MAX_APPS = 9;

function sfx(i: number): string {
  return i === 1 ? '' : `_${i}`;
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** 读 .env 里的全部应用；应用 1 缺 ID/Secret → 返回空数组（调用方 FATAL）。 */
export function loadFeishuApps(env: NodeJS.ProcessEnv, appRoot: string): FeishuAppConfig[] {
  const apps: FeishuAppConfig[] = [];
  for (let i = 1; i <= MAX_APPS; i++) {
    const s = sfx(i);
    const appId = nonEmpty(env[`FEISHU_APP_ID${s}`]);
    const appSecret = nonEmpty(env[`FEISHU_APP_SECRET${s}`]);
    if (!appId || !appSecret) {
      if (i === 1) return [];
      continue;
    }
    const allow = nonEmpty(env[`FEISHU_CHAT_ALLOWLIST${s}`]);
    const addDirs = nonEmpty(env[`FEISHU_ADD_DIRS${s}`]);
    apps.push({
      index: i,
      appId,
      appSecret,
      label: nonEmpty(env[`FEISHU_APP_LABEL${s}`]) ?? `app${i}`,
      ownerOpenId: nonEmpty(env[`FEISHU_OWNER_OPEN_ID${s}`]),
      knownUsers: nonEmpty(env[`FEISHU_KNOWN_USERS${s}`]),
      botRoster: nonEmpty(env[`FEISHU_BOT_ROSTER${s}`]),
      peerUsers: nonEmpty(env[`FEISHU_PEER_USERS${s}`]),
      chatAllowlist: allow
        ? new Set(allow.split(',').map((x) => x.trim()).filter(Boolean))
        : undefined,
      addDirs: addDirs ? addDirs.split(';').map((x) => x.trim()).filter(Boolean) : undefined,
      larkBotDir: path.join(appRoot, '..', i === 1 ? 'lark-cli-pinpin' : `lark-cli-pinpin-${i}`),
      larkUserDir: nonEmpty(env[`LARK_USER_CONFIG_DIR${s}`]),
    });
  }
  return apps;
}

/** 该应用是否服务此 chat：无 allowlist → 全放行。 */
export function isChatAllowed(app: FeishuAppConfig, chatId: string): boolean {
  return !app.chatAllowlist || app.chatAllowlist.has(chatId);
}
