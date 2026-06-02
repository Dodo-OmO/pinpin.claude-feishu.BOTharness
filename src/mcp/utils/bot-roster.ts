// bot 花名册——纯 env 解析，零依赖（无 DB / 飞书 import）。
// 从 sender-names.ts 抽离：原文件顶层 import db/database + feishu-send 污染了这几个纯 env
// 函数的依赖链，supervisor 进程（buildInstructions 改走 --append-system-prompt-file 后由它调）
// 若 import 会触发 better-sqlite3 初始化，违反"Supervisor 不开 DB"。抽到本文件根治。
//
// 懒求值：BOT_NAME_MAP 不在模块顶层求值——Electron 主进程 import Supervisor 链早于
// main.ts 的 dotenv.config()，顶层求值会拿到空 env。首次调用时才 parse，确保晚于 dotenv。

let _botMapCache: Record<string, string> | null = null;

// 格式同 FEISHU_KNOWN_USERS：`cli_号:友好名,cli_号:友好名` 或 JSON 对象。缺省 → 空 map。
function parseBotRosterEnv(): Record<string, string> {
  const raw = process.env.FEISHU_BOT_ROSTER;
  const m: Record<string, string> = {};
  if (!raw || !raw.trim()) return m;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof k === "string" && typeof v === "string") m[k] = v;
      }
    } catch (e) {
      process.stderr.write(
        `[bot-roster] FEISHU_BOT_ROSTER JSON 解析失败: ${e instanceof Error ? e.message : e}\n`,
      );
    }
    return m;
  }
  for (const pair of trimmed.split(",")) {
    const idx = pair.indexOf(":");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k && v) m[k] = v;
  }
  return m;
}

/** 懒求值缓存——首次调用 parse env（确保晚于 dotenv.config）。 */
function getBotMap(): Record<string, string> {
  if (_botMapCache) return _botMapCache;
  _botMapCache = parseBotRosterEnv();
  return _botMapCache;
}

/** 反查 bot 名字。未登记返 undefined（chat-message.ts 据此触发未登记日志）。 */
export function resolveBotName(appId: string): string | undefined {
  return getBotMap()[appId];
}

/**
 * 拼"群里已知 bot 花名册"——给 instructions 用，让品品圈 bot 时知道 cli_xxx 对应谁。
 * 输出形如：[群里已知bot（圈它用 <at user_id="cli_号">显示名</at>…）：BotC=cli_xxxx…｜BotA=cli_yyyy…]
 */
export function loadBotRoster(): string {
  const entries = Object.entries(getBotMap());
  if (entries.length === 0) return "";
  const roster = entries.map(([appId, name]) => `${name}=${appId}`).join("｜");
  return `[群里已知bot（圈它用 <at user_id="cli_号">显示名</at>，中间必带显示名否则空白）：${roster}]`;
}

// ── 未登记 bot 首次发言告知（一次性日志，避免每 8s 刷屏）──
const loggedUnknownBots = new Set<string>();
export function logUnknownBotOnce(appId: string, chatId: string, preview: string): void {
  if (loggedUnknownBots.has(appId)) return;
  loggedUnknownBots.add(appId);
  process.stderr.write(
    `[bot-roster] 未登记 bot app_id=${appId} 群=${chatId} 首次发言:"${preview.slice(0, 30)}"——告诉Owner这是谁，把 \`${appId}:友好名\` 追加进 .env 的 FEISHU_BOT_ROSTER 重启 CLI 即生效\n`,
  );
}
