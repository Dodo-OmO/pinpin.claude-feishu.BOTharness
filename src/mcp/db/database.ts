// MCP 版 SQLite DB 层
// 阶段 4 批次 0 步骤 0.2：从 早期版本 src/db/database.ts (632 行) 优雅重写为 ~400 行
// CLI 优雅化改动：
//   1. 砍 sessions 表（Owner决策——MCP 版单 session 无脑子分片记账本）
//   2. 砍 projects 表 + 6 个 wrapper（MCP 版无 群组概念，src/ 全无引用）
//   3. channel_message_ids 表：曾用于飞书 messageId 跨重启去重。方案A 后 supervisor 卸 DB、
//      入口去重改纯 in-memory Set，此表已无读写方（保留空表定义避免对存量库做破坏性迁移）
//   4. 砍 ALTER TABLE 历史迁移代码（MCP 版全新建库）

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ScheduledTaskRecord,
  ScheduledJob,
  AddTimerJobInput,
  AddSpeakWatchJobInput,
  AddRelayJobInput,
  KnownUser,
  FeishuTaskMap,
  DiyPollDef,
  RelayPayload,
} from "./types.js";

// MCP server 被 vault \.mcp.json spawn 时 process.cwd() 是 vault 目录而非代码包根，
// 用 import.meta.url 推算代码包根：dist/mcp/db/database.js → ../../.. = 代码包根
// 多 CLI 架构下 supervisor 通过 PINPIN_DB_PATH env 注入显式路径让所有进程都指同一个 data.db
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.PINPIN_DB_PATH
  ? process.env.PINPIN_DB_PATH
  : path.join(__dirname, "..", "..", "..", "data.db");

let db: Database.Database | null = null;

export function initDatabase(): void {
  if (db) return;
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    -- 周期任务执行记录（早报/周回顾/记忆自检/token 保活等）。
    -- cron registry 启动时读 last_run_at 决定是否补跑（catch-up）。
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      task_id TEXT PRIMARY KEY,
      last_run_at TEXT,
      status TEXT DEFAULT 'idle',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 协议 #41：品品按语义自决注册的一次性任务（timer + speak_watch 两类）
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      type TEXT NOT NULL,
      fire_at TEXT,
      watch_user_id TEXT,
      context_hint TEXT,
      payload TEXT,
      intent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      fired_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_pending_fire
      ON scheduled_jobs(status, fire_at);

    -- 协议 #46：认识的人——收人类消息且拿到真名时沉淀 open_id↔名
    -- 主动单聊/传话/拉日历/派任务靠 resolveOpenId(名) 反查
    CREATE TABLE IF NOT EXISTS known_users (
      open_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- 轻量 kv：bot 自己的持久状态
    -- 用例：飞书 OAuth state 防 CSRF / 任务清单 name→guid 缓存 / 24h 告警去重等
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- 协议 #51：确定性投票卡 poll 定义 + 票
    CREATE TABLE IF NOT EXISTS diy_polls (
      poll_id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      message_id TEXT,
      chat_id TEXT
    );

    CREATE TABLE IF NOT EXISTS diy_poll_votes (
      poll_id TEXT NOT NULL,
      option_idx INTEGER NOT NULL,
      voter_open_id TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (poll_id, voter_open_id)
    );

    -- 协议 #49：飞书自带任务 ↔ 本地 OB 台账映射
    -- 品品建飞书任务时落 1 行，作 feishu_task_done/delete 按关键词定位的索引
    CREATE TABLE IF NOT EXISTS feishu_task_map (
      task_guid TEXT PRIMARY KEY,
      ob_file TEXT,
      ob_marker TEXT,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT DEFAULT (datetime('now')),
      done_at TEXT
    );

    -- 飞书 messageId 跨重启去重表（历史遗留）。方案A 后 supervisor 卸 DB、入口去重改纯
    -- in-memory，此表已无读写方；保留 IF NOT EXISTS 定义仅为不对存量库做破坏性迁移。
    CREATE TABLE IF NOT EXISTS channel_message_ids (
      message_id TEXT PRIMARY KEY,
      processed_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_channel_message_ids_processed
      ON channel_message_ids(processed_at);

    -- 品品按语义自建的群（解散群鉴权用）：只解散品品自己建的群，防误删Owner正式群
    CREATE TABLE IF NOT EXISTS pinpin_created_groups (
      chat_id TEXT PRIMARY KEY,
      name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // 兼容迁移：diy_polls 早期建表无 message_id/chat_id 列，IF NOT EXISTS 加列
  for (const col of ["message_id", "chat_id"]) {
    try {
      db.exec(`ALTER TABLE diy_polls ADD COLUMN ${col} TEXT`);
    } catch {
      // 列已存在时 SQLite 抛错——忽略（ALTER TABLE IF NOT EXISTS 列不被 SQLite 3.x 支持）
    }
  }
}

function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized; call initDatabase() first");
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ============ scheduled_tasks (周期任务 last_run_at catch-up) ============

export function getScheduledTask(taskId: string): ScheduledTaskRecord | undefined {
  return getDb()
    .prepare("SELECT * FROM scheduled_tasks WHERE task_id = ?")
    .get(taskId) as ScheduledTaskRecord | undefined;
}

// touchLastRun=true 时刷新 last_run_at（仅"成功完成"该传 true）；false 只更 status，
// 不动 last_run_at——否则 handler 中途崩溃时"running"预写已把 last_run_at 刷成 now，
// 重启后 isMissed 判 false 静默吞掉该周期（早报/记忆自检漏发无告警）。
export function upsertScheduledTaskRun(
  taskId: string,
  status: "idle" | "running" | "failed",
  touchLastRun: boolean = false
): void {
  if (touchLastRun) {
    getDb()
      .prepare(
        `INSERT INTO scheduled_tasks (task_id, last_run_at, status)
         VALUES (?, datetime('now'), ?)
         ON CONFLICT(task_id) DO UPDATE SET last_run_at = datetime('now'), status = excluded.status`
      )
      .run(taskId, status);
    return;
  }
  // 只更 status，保留既有 last_run_at（首次插入时 last_run_at 为 NULL，符合"从未成功跑过"语义）
  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks (task_id, status)
       VALUES (?, ?)
       ON CONFLICT(task_id) DO UPDATE SET status = excluded.status`
    )
    .run(taskId, status);
}

// ============ scheduled_jobs (timer + speak_watch) ============

export function addTimerJob(input: AddTimerJobInput): number {
  // 去重：LLM 对同一意图重试/误判会调两次 → 双触发（Owner收重复提醒）。
  // 四要素全匹配才算重复（chat_id+type='timer'+context_hint+同一分钟 fire_at），
  // 避免误杀Owner故意设的两个相近提醒。命中则返回既有行 id，不再插入。
  const dup = getDb()
    .prepare(
      `SELECT id FROM scheduled_jobs
       WHERE type = 'timer' AND status = 'pending'
         AND chat_id = ? AND context_hint = ?
         AND SUBSTR(fire_at, 1, 16) = SUBSTR(?, 1, 16)
       LIMIT 1`
    )
    .get(input.chatId, input.contextHint, input.fireAtIso) as { id: number } | undefined;
  if (dup) return dup.id;

  const result = getDb()
    .prepare(
      `INSERT INTO scheduled_jobs (chat_id, type, fire_at, context_hint, payload, intent, status)
       VALUES (?, 'timer', ?, ?, ?, ?, 'pending')`
    )
    .run(
      input.chatId,
      input.fireAtIso,
      input.contextHint,
      input.payload ?? null,
      input.intent
    );
  return Number(result.lastInsertRowid);
}

export function addSpeakWatchJob(input: AddSpeakWatchJobInput): number {
  const result = getDb()
    .prepare(
      `INSERT INTO scheduled_jobs (chat_id, type, watch_user_id, context_hint, payload, intent, status)
       VALUES (?, 'speak_watch', ?, ?, ?, 'soft', 'pending')`
    )
    .run(input.chatId, input.targetOpenId, input.targetName, input.message);
  return Number(result.lastInsertRowid);
}

export function listPendingSpeakWatchByOpenId(openId: string): ScheduledJob[] {
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_jobs
       WHERE type = 'speak_watch' AND status = 'pending' AND watch_user_id = ?`
    )
    .all(openId) as ScheduledJob[];
}

export function listPendingTimerJobs(beforeIso: string, ownChatId?: string): ScheduledJob[] {
  // 多 CLI 架构（2026-05-28 Owner决策）：临时 cron 归属各自频道。
  // 每个 CLI 子进程调本函数时传自己的 chat_id，只 schedule 自己 chat 的 pending timer——
  // 防止 A 频道设的 timer 被 B 频道 CLI 抢先 fire 推到 B 主对话（错位 bug）。
  if (ownChatId) {
    return getDb()
      .prepare(
        `SELECT * FROM scheduled_jobs
         WHERE type = 'timer' AND status = 'pending' AND fire_at <= ? AND chat_id = ?
         ORDER BY fire_at ASC`
      )
      .all(beforeIso, ownChatId) as ScheduledJob[];
  }
  // 未传 ownChatId（兼容旧调用方 / supervisor 跨 chat scan 场景）
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_jobs
       WHERE type = 'timer' AND status = 'pending' AND fire_at <= ?
       ORDER BY fire_at ASC`
    )
    .all(beforeIso) as ScheduledJob[];
}

export function listAllPendingJobs(chatId?: string): ScheduledJob[] {
  if (chatId) {
    return getDb()
      .prepare(`SELECT * FROM scheduled_jobs WHERE status = 'pending' AND chat_id = ? ORDER BY id`)
      .all(chatId) as ScheduledJob[];
  }
  return getDb()
    .prepare(`SELECT * FROM scheduled_jobs WHERE status = 'pending' ORDER BY id`)
    .all() as ScheduledJob[];
}

export function getJobById(id: number): ScheduledJob | undefined {
  return getDb()
    .prepare(`SELECT * FROM scheduled_jobs WHERE id = ?`)
    .get(id) as ScheduledJob | undefined;
}

export function markJobFired(id: number): void {
  getDb()
    .prepare(`UPDATE scheduled_jobs SET status = 'fired', fired_at = datetime('now') WHERE id = ?`)
    .run(id);
}

export function revertJobToPending(id: number): number {
  const result = getDb()
    .prepare(
      `UPDATE scheduled_jobs SET status = 'pending', retry_count = retry_count + 1 WHERE id = ?`
    )
    .run(id);
  const row = getJobById(id);
  return row?.retry_count ?? 0;
}

export function markJobFailed(id: number): void {
  getDb()
    .prepare(`UPDATE scheduled_jobs SET status = 'failed' WHERE id = ?`)
    .run(id);
}

export function cancelJob(id: number): boolean {
  const result = getDb()
    .prepare(`UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
    .run(id);
  return result.changes > 0;
}

export function rescheduleJob(id: number, fireAtIso: string): void {
  getDb().prepare(`UPDATE scheduled_jobs SET fire_at = ? WHERE id = ?`).run(fireAtIso, id);
}

// ============ relay payload (主动单聊传话催回) ============

/**
 * 查 pending relay 任务（schedulerStart 重启恢复用）。
 * 多 CLI 架构：传 ownChatId 时只返回该频道的 relay——防止多个 CLI 同时 fire 同一条 relay 双催 B。
 * 不传时返回全部（兼容旧调用 / supervisor 扫表场景）。
 */
export function listPendingRelayJobs(ownChatId?: string): ScheduledJob[] {
  if (ownChatId) {
    return getDb()
      .prepare(
        `SELECT * FROM scheduled_jobs WHERE type = 'relay' AND status = 'pending' AND chat_id = ? ORDER BY fire_at ASC`
      )
      .all(ownChatId) as ScheduledJob[];
  }
  return getDb()
    .prepare(`SELECT * FROM scheduled_jobs WHERE type = 'relay' AND status = 'pending' ORDER BY fire_at ASC`)
    .all() as ScheduledJob[];
}

/** 创建一条 relay 传话任务（type='relay'，watch_user_id=B 的 open_id） */
export function addRelayJob(input: AddRelayJobInput): number {
  const payload: RelayPayload = {
    fromName: input.fromName,
    body: input.body,
    remindCount: 0,
    _fromOpenId: input.fromOpenId,
  };
  // relay 任务的 chat_id 存委托人 A 所在频道（多 CLI 调度隔离：只有该频道的 CLI 才 fire）；
  // 被转达方存 watch_user_id；首次催时间存 fire_at
  const result = getDb()
    .prepare(
      `INSERT INTO scheduled_jobs (chat_id, type, fire_at, watch_user_id, context_hint, payload, intent, status)
       VALUES (?, 'relay', ?, ?, ?, ?, 'soft', 'pending')`
    )
    .run(
      input.chatId,
      input.firstNudgeAtIso,
      input.watcherOpenId,
      `relay from ${input.fromName}`,
      JSON.stringify(payload)
    );
  return Number(result.lastInsertRowid);
}

/**
 * 查找 B（watcherOpenId）是否有 pending 的 relay 任务（回音检测用）。
 * B 发消息进来时调此函数——命中说明 B 已回，可回报委托人 A。
 */
export function findPendingRelayJobByWatcher(
  watcherOpenId: string
): ScheduledJob | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_jobs
       WHERE type = 'relay' AND status = 'pending' AND watch_user_id = ?
       LIMIT 1`
    )
    .get(watcherOpenId) as ScheduledJob | undefined;
}

export function bumpRelayNudge(jobId: number, newFireAtIso: string): number {
  const job = getJobById(jobId);
  if (!job || !job.payload) return 0;
  let payload: RelayPayload;
  try {
    payload = JSON.parse(job.payload);
  } catch {
    return 0;
  }
  payload.remindCount = (payload.remindCount ?? 0) + 1;
  getDb()
    .prepare(`UPDATE scheduled_jobs SET payload = ?, fire_at = ? WHERE id = ?`)
    .run(JSON.stringify(payload), newFireAtIso, jobId);
  return payload.remindCount;
}

// ============ known_users (协议 #46) ============

export function upsertKnownUser(openId: string, name: string): void {
  getDb()
    .prepare(
      `INSERT INTO known_users (open_id, name, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(open_id) DO UPDATE SET name = excluded.name, updated_at = datetime('now')`
    )
    .run(openId, name);
}

export function resolveOpenId(nameOrAlias: string): string | undefined {
  const exact = getDb()
    .prepare(`SELECT open_id FROM known_users WHERE name = ?`)
    .get(nameOrAlias) as { open_id: string } | undefined;
  if (exact) return exact.open_id;
  const fuzzy = getDb()
    .prepare(`SELECT open_id FROM known_users WHERE name LIKE ? LIMIT 1`)
    .get(`%${nameOrAlias}%`) as { open_id: string } | undefined;
  return fuzzy?.open_id;
}

export function listKnownUsers(): KnownUser[] {
  return getDb().prepare(`SELECT * FROM known_users ORDER BY name`).all() as KnownUser[];
}

export function getKnownUserName(openId: string): string | undefined {
  const row = getDb()
    .prepare(`SELECT name FROM known_users WHERE open_id = ?`)
    .get(openId) as { name: string } | undefined;
  return row?.name;
}

export function seedKnownUsers(entries: Array<{ openId: string; name: string }>): void {
  const stmt = getDb().prepare(
    `INSERT INTO known_users (open_id, name) VALUES (?, ?) ON CONFLICT(open_id) DO NOTHING`
  );
  const tx = getDb().transaction((rows: typeof entries) => {
    for (const e of rows) stmt.run(e.openId, e.name);
  });
  tx(entries);
}

// ============ pinpin_created_groups（建群/解散群 协议追加 2026-05-29） ============

// created_at 不在 ON CONFLICT 更新——飞书 chat_id 全局唯一不复用，DO UPDATE 实际不触发，
// 仅作幂等兜底（万一同 chat_id 二次标记则保留首次建群时间）。
export function markCreatedGroup(chatId: string, name: string): void {
  getDb()
    .prepare(
      `INSERT INTO pinpin_created_groups (chat_id, name) VALUES (?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name`
    )
    .run(chatId, name);
}

export function isCreatedByPinpin(chatId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM pinpin_created_groups WHERE chat_id = ?`)
    .get(chatId);
  return !!row;
}

export function removeCreatedGroup(chatId: string): void {
  getDb().prepare(`DELETE FROM pinpin_created_groups WHERE chat_id = ?`).run(chatId);
}

// ============ app_meta (kv) ============

export function getMeta(key: string): string | undefined {
  const row = getDb()
    .prepare(`SELECT value FROM app_meta WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO app_meta (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .run(key, value);
}

export function deleteMeta(key: string): void {
  getDb().prepare(`DELETE FROM app_meta WHERE key = ?`).run(key);
}

/** 列所有 app_meta 条目（清缓存用：删清单时清掉指向它的 name→guid 缓存） */
export function listMetaEntries(): Array<{ key: string; value: string }> {
  return getDb().prepare(`SELECT key, value FROM app_meta`).all() as Array<{
    key: string;
    value: string;
  }>;
}

// ============ diy_polls + diy_poll_votes (协议 #51) ============

export function insertDiyPoll(
  pollId: string,
  question: string,
  options: string[],
  messageId?: string,
  chatId?: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO diy_polls (poll_id, question, options_json, message_id, chat_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(pollId, question, JSON.stringify(options), messageId ?? null, chatId ?? null);
}

/** 发卡后回写 message_id（先 insertDiyPoll 建记录，拿到 messageId 后再调此函数） */
export function updateDiyPollMessageId(pollId: string, messageId: string): void {
  getDb()
    .prepare(`UPDATE diy_polls SET message_id = ? WHERE poll_id = ?`)
    .run(messageId, pollId);
}

export function getDiyPoll(pollId: string): DiyPollDef | undefined {
  return getDb()
    .prepare(`SELECT * FROM diy_polls WHERE poll_id = ?`)
    .get(pollId) as DiyPollDef | undefined;
}

export function upsertPollVote(
  pollId: string,
  voterOpenId: string,
  optionIdx: number
): void {
  getDb()
    .prepare(
      `INSERT INTO diy_poll_votes (poll_id, option_idx, voter_open_id, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(poll_id, voter_open_id) DO UPDATE SET option_idx = excluded.option_idx, updated_at = datetime('now')`
    )
    .run(pollId, optionIdx, voterOpenId);
}

export function countPollVotes(pollId: string): Array<{ option_idx: number; count: number }> {
  return getDb()
    .prepare(
      `SELECT option_idx, COUNT(*) as count FROM diy_poll_votes WHERE poll_id = ? GROUP BY option_idx`
    )
    .all(pollId) as Array<{ option_idx: number; count: number }>;
}

// ============ feishu_task_map (协议 #49) ============

export function insertFeishuTaskMap(rec: {
  taskGuid: string;
  obFile: string | null;
  obMarker: string | null;
  summary: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO feishu_task_map (task_guid, ob_file, ob_marker, summary)
       VALUES (?, ?, ?, ?)`
    )
    .run(rec.taskGuid, rec.obFile, rec.obMarker, rec.summary);
}

export function listOpenFeishuTaskMaps(): FeishuTaskMap[] {
  return getDb()
    .prepare(`SELECT * FROM feishu_task_map WHERE status = 'open' ORDER BY created_at DESC`)
    .all() as FeishuTaskMap[];
}

export function markFeishuTaskMapDone(taskGuid: string): void {
  getDb()
    .prepare(`UPDATE feishu_task_map SET status = 'done', done_at = datetime('now') WHERE task_guid = ?`)
    .run(taskGuid);
}

export function getFeishuTaskMap(taskGuid: string): FeishuTaskMap | undefined {
  return getDb()
    .prepare(`SELECT * FROM feishu_task_map WHERE task_guid = ?`)
    .get(taskGuid) as FeishuTaskMap | undefined;
}

export function deleteFeishuTaskMap(taskGuid: string): void {
  getDb().prepare(`DELETE FROM feishu_task_map WHERE task_guid = ?`).run(taskGuid);
}

