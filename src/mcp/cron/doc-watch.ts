// 文档探针 cron（MCP 版）
// 2026-09-15 Client工作深度接管 B7：每日 3 次（09:00/13:00/17:00）查豆姐最近打开/编辑的文档，
// 有新的才叫醒品品入图（Owner步骤 6）。
//
// 归属：Owner单聊 CLI（isOwnerOfCron("owner")），且只在Client这个飞书应用下跑——
// PINPIN_APP_LABEL 用于多飞书应用场景区分，PINPIN_DOCWATCH_APP_LABEL 允许覆盖默认值"Client"。
//
// lark-cli drive +search 用Owner身份（LARKSUITE_CLI_CONFIG_DIR 由启动器/CLI 进程环境注入）
// 分别查 --opened-since / --edited-since 两次（5h 窗口，覆盖 3 个 job 间隔 4h，留 1h 缓冲防漏），
// 按 result_meta.token 去重合并，再跟 app_meta 里 docwatch:<token> 比对——已推过的不再提。

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { registerCron } from "./registry.js";
import { isOwnerOfCron } from "./cron-owner.js";
import { pushChannelTrigger } from "../utils/push-channel.js";
import { getMeta, setMeta } from "../db/database.js";
import { logBackground } from "../utils/background-log.js";

const execFileAsync = promisify(execFileCb);

const META_PREFIX = "docwatch:";
// 时间窗 5h（覆盖 4h 间隔 + 1h 缓冲）。lark-cli 相对写法只认 d/m/y，小时级用 unix 秒。
const SINCE_WINDOW_SEC = 5 * 3600;

interface DocSearchResultMeta {
  token: string;
  doc_types?: string;
  url?: string;
  last_open_time_iso?: string;
  update_time_iso?: string;
  owner_name?: string;
}

interface DocSearchResultItem {
  entity_type?: string;
  title_highlighted?: string;
  result_meta: DocSearchResultMeta;
}

interface DocSearchResponse {
  ok: boolean;
  data?: { results?: DocSearchResultItem[] };
}

function stripHighlight(title: string | undefined): string {
  if (!title) return "(无标题)";
  return title.replace(/<[^>]+>/g, "");
}

async function searchDocs(
  sinceFlag: "--opened-since" | "--edited-since",
  sinceVal: string
): Promise<DocSearchResultItem[]> {
  // shell:true 下分离的空字符串参数会被吞，空 query 必须写成单 token `--query=`
  const args = [
    "drive",
    "+search",
    "--query=",
    sinceFlag,
    sinceVal,
    "--page-size",
    "20",
    "--format",
    "json",
  ];
  const { stdout } = await execFileAsync("lark-cli", args, {
    shell: true,
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as DocSearchResponse;
  if (!parsed.ok) return [];
  return parsed.data?.results ?? [];
}

/**
 * 探一轮：查 opened + edited 两条，按 token 合并去重，跟 app_meta 比对出真正新的，
 * 有新的才推 doc-discovered trigger，推送成功后才落 app_meta 标记（避免推失败却标记已读）。
 * 任何一步（lark-cli 失败 / JSON 解析失败）都直接向上抛——让 cron/registry.ts 判失败、
 * 不刷 last_run_at，下次 catch-up 能重试。
 */
export async function runDocWatch(): Promise<void> {
  const since = String(Math.floor(Date.now() / 1000) - SINCE_WINDOW_SEC);
  const [opened, edited] = await Promise.all([
    searchDocs("--opened-since", since),
    searchDocs("--edited-since", since),
  ]);

  const merged = new Map<string, DocSearchResultItem>();
  for (const item of [...opened, ...edited]) {
    const token = item.result_meta?.token;
    if (!token) continue;
    if (!merged.has(token)) merged.set(token, item);
  }

  const fresh: DocSearchResultItem[] = [];
  for (const item of merged.values()) {
    if (getMeta(META_PREFIX + item.result_meta.token) === undefined) {
      fresh.push(item);
    }
  }

  if (fresh.length === 0) return;

  const lines = fresh.map((item) => {
    const title = stripHighlight(item.title_highlighted);
    const type = item.result_meta.doc_types ?? item.entity_type ?? "文档";
    const url = item.result_meta.url ?? "";
    return `- ${title}｜${type}｜${url}`;
  });
  const body =
    `📄 发现豆姐最近打开/编辑的新文档 ${fresh.length} 篇：\n` +
    lines.join("\n") +
    `\n（不用管的 pinpin_no_reply）`;

  await pushChannelTrigger(
    {
      trigger: "doc-discovered",
      chat_id: process.env.PINPIN_CHAT_ID,
      body,
    },
    { throwOnError: true }
  );

  // 推送成功才落标记，避免推失败却被标记为已读
  for (const item of fresh) {
    setMeta(META_PREFIX + item.result_meta.token, new Date().toISOString());
  }
  logBackground("doc-watch", `发现并推送新文档 ${fresh.length} 篇`);
}

const DOCWATCH_APP_LABEL = process.env.PINPIN_DOCWATCH_APP_LABEL ?? "Client";

if (isOwnerOfCron("owner") && process.env.PINPIN_APP_LABEL === DOCWATCH_APP_LABEL) {
  registerCron("doc-watch-9", { kind: "daily", h: 9, m: 0 }, runDocWatch);
  registerCron("doc-watch-13", { kind: "daily", h: 13, m: 0 }, runDocWatch);
  registerCron("doc-watch-17", { kind: "daily", h: 17, m: 0 }, runDocWatch);
}
