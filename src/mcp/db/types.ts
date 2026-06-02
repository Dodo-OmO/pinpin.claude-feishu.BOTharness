// MCP 版 DB 层类型定义
// 阶段 4：从 早期版本 src/db/types.ts 继承核心类型，砍 早期版本的 Project/Session 概念

export type JobType = "timer" | "speak_watch" | "relay";
export type JobIntent = "hard" | "soft";
export type JobStatus = "pending" | "fired" | "cancelled" | "failed";

export interface ScheduledTaskRecord {
  task_id: string;
  last_run_at: string | null;
  status: "idle" | "running" | "failed";
}

export interface ScheduledJob {
  id: number;
  chat_id: string;
  type: JobType;
  fire_at: string | null;
  watch_user_id: string | null;
  context_hint: string | null;
  payload: string | null;
  intent: JobIntent;
  status: JobStatus;
  created_at: string;
  fired_at: string | null;
  retry_count: number;
}

export interface AddTimerJobInput {
  chatId: string;
  fireAtIso: string;
  contextHint: string;
  intent: JobIntent;
  payload?: string;
}

export interface AddSpeakWatchJobInput {
  chatId: string;
  targetOpenId: string;
  targetName: string;
  message: string;
}

export interface KnownUser {
  open_id: string;
  name: string;
  updated_at: string;
}

export interface FeishuTaskMap {
  task_guid: string;
  ob_file: string | null;
  ob_marker: string | null;
  summary: string;
  status: "open" | "done";
  created_at: string;
  done_at: string | null;
}

export interface DiyPollDef {
  poll_id: string;
  question: string;
  options_json: string;
  created_at: string;
  message_id: string | null;
  chat_id: string | null;
}

export interface RelayPayload {
  fromName: string;       // 委托人姓名（展示用）
  body: string;           // 要转达的原话
  remindCount?: number;   // 已催次数（0-2）
  _fromOpenId?: string;   // 委托人 open_id（回报回音时私聊用）
}

export interface AddRelayJobInput {
  /** 委托人 A 所在频道的 chat_id（多 CLI 调度隔离用，只有该频道的 CLI 才 fire） */
  chatId: string;
  /** 被转达方 open_id（B） */
  watcherOpenId: string;
  /** 委托人 open_id（A） */
  fromOpenId: string;
  /** 委托人姓名（展示用） */
  fromName: string;
  /** 要转达的原话 */
  body: string;
  /** 首次催检查时间（ISO） */
  firstNudgeAtIso: string;
}

