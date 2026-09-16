// 启动器三端（main / preload / renderer）共享类型单源
// preload 中 export 保持不变（通过 re-export），renderer 本地定义已收敛至此。

// model/effort 清单单源：renderer 没配 vite alias 到 src/ipc，经本文件相对路径转一手 re-export。
export { MODEL_OPTIONS, EFFORT_OPTIONS } from '../src/ipc/protocol.js';

/** fast 模式（Opus 加速输出）仅 Opus 5 / Opus 4.8 支持。modelId 形如 "claude-opus-5 [1m]"——
 *  去掉 " [1m]" 后缀与首尾空白再比对（MODEL_OPTIONS 单源见 src/ipc/protocol.ts）。
 *  main（切模型联动）与 renderer（弹窗禁用态）两侧复用，判断逻辑单源于此。 */
export function supportsFast(modelId: string): boolean {
  const bare = (modelId || '').replace(/\s*\[1m\]\s*/g, '').trim();
  return bare === 'claude-opus-5' || bare === 'claude-opus-4-8';
}

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
  standby?: boolean; // 睡眠：不随启动器/04:10 自动上线，有消息仍被唤醒。新私聊首次出现默认 true（Owner单聊 + PINPIN_P2P_ALWAYS_ON_OPEN_IDS 豁免）
  /** P1.3: per-CLI 上下文用量（statusLine sink 推过来） */
  context_pct?: number | null;
  context_tokens?: number | null;
  context_window_size?: number | null;
  cost_usd?: number | null;
  usage_updated_at?: number;
  /** 该 chat 归属的飞书应用 label（供启动器频道列表分组；缺失显示"其他"）。 */
  app_label?: string;
  /** 最后一次入站消息时刻（Date.now()，进程内 Map，重启清零）。无记录 = undefined。 */
  last_activity_at?: number;
  /** 未就绪时缓冲的待投递消息数（pendingInbound 长度）。0 或未初始化时省略/为 0。 */
  pending_count?: number;
}

/** 常驻工人（医生 / 总导演 / 顺子等）状态，独立于频道列表；启动器「工人」分组渲染用。 */
export interface WorkerStatusInfo {
  name: string;
  status: 'awake' | 'asleep' | 'broken';
  pid?: number;
  /** 最后一次 PTY 输出时刻（Date.now()）；从未输出过则省略。 */
  last_output_at?: number;
  /** status='broken' 时的失败原因（拉起失败 / 60s 未出现在 ListAgents / transcript 缺失损坏等）。 */
  error?: string;
}

export interface SupervisorStateSnapshot {
  ipc_port: number;
  chats: Array<{ chat_id: string; name?: string }>;
  channels: ChannelStatusInfo[];
  today_messages: number;
  workers?: WorkerStatusInfo[];
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
