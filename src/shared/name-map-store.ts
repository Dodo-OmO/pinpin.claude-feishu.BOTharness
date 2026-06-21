// 人名 / bot 名映射的跨进程共享存储（纯 fs/json，零 DB / 零飞书依赖——supervisor 与子 MCP 进程通用）。
//
// 设计：单一 JSON 文件 `name-mappings.json`（supervisor userData 目录），supervisor 唯一写者，
// 两进程都读。子进程靠 mtime 变更**惰性热重载**——Owner在启动器改名 → supervisor 写文件 →
// 子进程下条消息读 name 时 statSync 发现 mtime 变 → 重载 → 立刻显示新名（无需 IPC push、无需重启）。
//
// 优先级（在 sender 解析里）：本 store > 飞书 API/known_users DB > slice(-8) 兜底。
// 初始种子：supervisor 启动时若文件不存在，用 .env FEISHU_KNOWN_USERS / FEISHU_BOT_ROSTER 灌一份。

import fs from 'node:fs';

export interface NameMap {
  /** open_id → 友好名（人类） */
  humans: Record<string, string>;
  /** cli_号/app_id → 友好名（bot） */
  bots: Record<string, string>;
}

let _cache: NameMap = { humans: {}, bots: {} };
let _lastMtimeMs = -1;
let _filePath: string | null = null;

/** 进程启动调一次：绑定文件路径并首次加载。supervisor 传 userData 下的绝对路径，
 *  子进程从 PINPIN_NAME_MAP_PATH env 拿同一路径。 */
export function initNameMapStore(filePath: string): void {
  _filePath = filePath;
  _lastMtimeMs = -1;
  reloadIfChanged();
}

/** 惰性热重载：mtime 没变直接返回；变了重读。文件不存在 → 保持当前 cache（不清空）。 */
function reloadIfChanged(): void {
  if (!_filePath) return;
  try {
    const st = fs.statSync(_filePath);
    if (st.mtimeMs === _lastMtimeMs) return;
    _lastMtimeMs = st.mtimeMs;
    const parsed = JSON.parse(fs.readFileSync(_filePath, 'utf8')) as Partial<NameMap>;
    _cache = {
      humans: (parsed.humans && typeof parsed.humans === 'object') ? parsed.humans : {},
      bots: (parsed.bots && typeof parsed.bots === 'object') ? parsed.bots : {},
    };
  } catch {
    /* 文件缺失/损坏 → 保持上次 cache，不抛（解析链不能因映射文件挂） */
  }
}

/** 查人名映射（无 → undefined）。每次查前惰性热重载。 */
export function getHumanNameMapping(openId: string): string | undefined {
  reloadIfChanged();
  return _cache.humans[openId];
}

/** 查 bot 名映射（无 → undefined）。 */
export function getBotNameMapping(cliId: string): string | undefined {
  reloadIfChanged();
  return _cache.bots[cliId];
}

/** 取全部映射（启动器"已映射"管理面板用）。返回副本。 */
export function getAllMappings(): NameMap {
  reloadIfChanged();
  return { humans: { ..._cache.humans }, bots: { ..._cache.bots } };
}

/** 写一条映射 + 原子落盘（仅 supervisor 调）。name 空字符串 = 删除该条。 */
export function setNameMapping(type: 'human' | 'bot', id: string, name: string): void {
  reloadIfChanged();
  const bucket = type === 'human' ? _cache.humans : _cache.bots;
  const trimmed = name.trim();
  if (trimmed) bucket[id] = trimmed;
  else delete bucket[id];
  flush();
}

/** 首次种子（仅 supervisor 启动调）：文件已存在则跳过，不覆盖用户已改的。 */
export function seedNameMapIfAbsent(humans: Record<string, string>, bots: Record<string, string>): void {
  if (!_filePath) return;
  if (fs.existsSync(_filePath)) return;
  _cache = { humans: { ...humans }, bots: { ...bots } };
  flush();
}

function flush(): void {
  if (!_filePath) return;
  const tmp = `${_filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(_cache, null, 2), 'utf8');
    fs.renameSync(tmp, _filePath);
    _lastMtimeMs = fs.statSync(_filePath).mtimeMs; // 同步自己写后的 mtime，避免下次自读触发无谓重载
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    process.stderr.write(
      `[name-map-store] ❌ flush 失败，映射未落盘：${_filePath} err=${e instanceof Error ? e.message : e}\n`,
    );
  }
}
