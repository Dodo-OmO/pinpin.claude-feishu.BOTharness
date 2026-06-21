// 启动器三端（main / preload / renderer）共享类型单源
// preload 中 export 保持不变（通过 re-export），renderer 本地定义已收敛至此。

export interface ChannelStatusInfo {
  chat_id: string;
  chat_name?: string;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  pid?: number;
  uptime_ms: number;
  /** CLI 进程启动时刻（Date.now()）；停止时为 null */
  started_at?: number | null;
  model: string;
  effort: string;
  /** 自动压缩阈值（上下文用量百分比）。 */
  autoCompactPct?: number;
  /** fast 模式（Opus 加速输出）。 */
  fast?: boolean;
  /** 休眠模式：每日 4 点整体重启时不自动拉起，有人在该频道说话才唤醒（唤醒后读到触发消息）。
   *  睡着时该卡为 stopped 态但带休眠标记；醒着时 running 仍带休眠标记（下次重启回休眠）。 */
  standby?: boolean;
  /** P1.3: per-CLI 上下文用量（statusLine sink 推过来） */
  context_pct?: number | null;
  context_tokens?: number | null;
  context_window_size?: number | null;
  cost_usd?: number | null;
  usage_updated_at?: number;
}

export interface WorkSessionInfo {
  session_id: string;
  origin_chat_id: string;
  work_dir: string;
  fast?: boolean;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  pid?: number;
  uptime_ms: number;
  model: string;
  effort: string;
  /** Q4 续: work session 上下文用量（jsonl assistant.usage 实时解析） */
  context_tokens?: number;
  context_window_size?: number | null;
  context_pct?: number | null;
}

export interface SupervisorStateSnapshot {
  ipc_port: number;
  chats: Array<{ chat_id: string; name?: string }>;
  channels: ChannelStatusInfo[];
  work_sessions: WorkSessionInfo[];
  today_messages: number;
}

export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

export interface AppSettings {
  default_model: string;
  default_effort: string;
  work_default_model: string;
  work_default_effort: string;
  work_default_fast: boolean;
  default_fast: boolean;
  default_compact_pct: number;
}

export interface RateLimitWindow {
  used_percentage: number | null;
  resets_at: number | null;
}

/** 已映射人名/bot 名（与 src/ipc/protocol.ts NameMappings 同形，启动器面板用） */
export interface NameMappings {
  humans: Record<string, string>;
  bots: Record<string, string>;
}
/** 待命名 sender 条目（解析后仍纯 ID 兜底=没友好名），供启动器面板列出待补名 */
export interface PendingNameEntry {
  id: string;
  chat_id: string;
  snippet: string;
  type: 'human' | 'bot';
  ts: number;
}

export interface QuotaSnapshot {
  ts: number;
  available: boolean;
  blocks?: { tokens?: number };
  daily?: { tokens?: number; cost_usd?: number };
  weekly?: { tokens?: number };
  /** 账号级额度 5h+7天（来自 statusLine rate_limits，非 ccusage）：各窗口 used_percentage + resets_at(Unix 秒) */
  rate_limits?: { five_hour?: RateLimitWindow | null; seven_day?: RateLimitWindow | null } | null;
  error?: string;
}
