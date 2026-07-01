/**
 * supervisor ↔ stdio MCP server 子进程 IPC 协议定义。
 *
 * 双方通过本机 TCP（127.0.0.1）传输 NDJSON（每行一个 JSON 对象），不走 stdio——
 * 因为 stdio MCP server 的 stdin/stdout 是被 Claude Code CLI 占用的 JSON-RPC channel。
 *
 * 协议风格类似 LSP：单向 notification + 双向 request/response（id 配对）。
 * 方法全集见下方 IPC_METHODS 逐条注释（hello/bye、push、request、warden 桥接四类，40+ method）。
 */

export interface IpcEnvelope<T = unknown> {
  /** Request/response 配对 id；单向 notification 无 id */
  id?: string;
  method?: string;
  params?: T;
  result?: T;
  error?: { code: number; message: string };
}

// ── 协议方法常量 ──

export const IPC_METHODS = {
  HELLO: 'hello',
  BYE: 'bye',
  FEISHU_MESSAGE: 'feishu.message',
  CHAT_TRIGGER: 'chat-trigger',
  // 诉求 B 传话筒（step 4）—— child → main 是 request，main → child 是 push notification
  WORK_SPAWN: 'work.spawn',         // request → returns { session_id }
  WORK_SEND: 'work.send',           // request → returns { ok }
  WORK_END: 'work.end',             // request → returns { ok }
  WORK_PEEK: 'work.peek',           // Q7: request → returns { lines: string[] } 品品主动看 work 翻译行
  WORK_STOPPED: 'work.stopped',     // main → child push notification（stop signal）
  // P1.3: statusLine sink → supervisor 推 per-CLI 上下文用量（fire-and-forget，不走 hello）
  STATUSLINE_UPDATE: 'statusline.update',
  // 手动 /压缩：compact_chat tool → supervisor 往本频道 CLI 的 PTY 写 `/compact\n` 触发原生压缩
  COMPACT_VIA_PTY: 'compact.via-pty',  // request → returns { ok }
  // 飞书 /下线：sleep_self tool → supervisor 关闭本频道（pauseChannel：stop + evict 出 Map，归属不变，下条消息唤醒）
  SLEEP_SELF: 'sleep-self',            // request → returns WorkOkResult
  // 品品主动单聊 / 建群后即时挂频道监听（不等对方或群友先发消息）
  SPAWN_CHANNEL: 'spawn-channel',      // request → returns WorkOkResult
  // 停某频道 CLI + 删配置，不再重 spawn（解散群后调）
  STOP_CHANNEL: 'stop-channel',        // request → returns WorkOkResult
  // 人名/bot名映射管理（启动器面板用；后端先就绪，UI 后续阶段做）
  GET_NAME_MAPPINGS: 'get-name-mappings',  // request → NameMap { humans, bots }
  GET_PENDING_NAMES: 'get-pending-names',  // request → PendingNameEntry[]（待命名 sender）
  SET_NAME_MAPPING: 'set-name-mapping',    // request {type,id,name} → WorkOkResult（写映射 + 清待命名）
  // 方案A：投票点击 → supervisor 把记票请求路由到有 DB 的频道子进程执行（main → child request）
  POLL_VOTE: 'poll.vote',              // main → child request → returns PollVoteResult
  // ── 管家(warden)桥接：独立管家进程连 supervisor 固定端口，手机远程看/控 CLI ──
  WARDEN_LIST_CLIS: 'warden.list-clis',           // request → { clis: ChannelCli.getStats()[] }
  WARDEN_RESTART_CLI: 'warden.restart-cli',       // request {chat_id} → WorkOkResult
  WARDEN_STOP_CLI: 'warden.stop-cli',             // request {chat_id} → WorkOkResult
  WARDEN_SUB_TERMINAL: 'warden.sub-terminal',     // request {chat_id} → WorkOkResult（订阅后 server push TERMINAL_DATA）
  WARDEN_UNSUB_TERMINAL: 'warden.unsub-terminal', // request {chat_id} → WorkOkResult
  WARDEN_TERMINAL_DATA: 'warden.terminal-data',   // notification main→warden {chat_id, data}
  WARDEN_SYSTEM_INFO: 'warden.system-info',       // request → WardenSystemInfo
  // 批1 频道完整管理
  WARDEN_START_CLI: 'warden.start-cli',           // request {chat_id} → WorkOkResult（spawn+start）
  WARDEN_COMPACT_CLI: 'warden.compact-cli',       // request {chat_id} → WorkOkResult
  WARDEN_SET_CONFIG: 'warden.set-config',         // request {chat_id, model?/effort?/fast?/autoCompactPct?} → WorkOkResult（持久化，重启生效）
  WARDEN_SET_NAME: 'warden.set-name',             // request {chat_id, name} → WorkOkResult
  WARDEN_SEND_INPUT: 'warden.send-input',         // request {chat_id, text} → WorkOkResult（写 PTY，跟 CLI 对话）
  // 批2 额度
  WARDEN_FETCH_QUOTA: 'warden.fetch-quota',       // request → 透传 {quota, today_messages, rate_limits}（先触发 fetchQuotaNow 刷新）
  // 批3 work session（Owner"干活"session 全复刻：列表/终端看写/结束）
  WARDEN_LIST_WORK: 'warden.list-work',           // request → 透传 {sessions: WorkSession.getStats()[]}
  WARDEN_WORK_SUB_TERMINAL: 'warden.work-sub-terminal',     // request {session_id} → WorkOkResult（attach，push TERMINAL_DATA 以 session_id 作路由 key）
  WARDEN_WORK_UNSUB_TERMINAL: 'warden.work-unsub-terminal', // request {session_id} → WorkOkResult
  WARDEN_WORK_SEND: 'warden.work-send',           // request {session_id, text} → WorkOkResult（给 work CLI 发指令）
  WARDEN_WORK_END: 'warden.work-end',             // request {session_id} → WorkOkResult（结束 work）
  // 批4 全局设置 + 系统 + 日志
  WARDEN_GET_DEFAULTS: 'warden.get-defaults',     // request → {channel:{model,effort,fast,autoCompactPct}, work:{model,effort,fast}}
  WARDEN_SET_DEFAULTS: 'warden.set-defaults',     // request {model?,effort?,fast?,autoCompactPct?} → WorkOkResult
  WARDEN_SET_WORK_DEFAULTS: 'warden.set-work-defaults', // request {model?,effort?,fast?} → WorkOkResult
  WARDEN_RESTART_SUPERVISOR: 'warden.restart-supervisor', // request → WorkOkResult（重启品品 supervisor）
  WARDEN_QUIT_APP: 'warden.quit-app',             // request → WorkOkResult（关闭品品，经 main.ts isQuiting）
  WARDEN_RECENT_LOGS: 'warden.recent-logs',       // request {limit?} → {logs: WardenLogEntry[]}
} as const;


// ── 管家桥接固定端口（区别于子进程动态端口；管家与 supervisor 两端共享此单源）──
export const WARDEN_BRIDGE_PORT = 47900;

/** 管家在桥接上注册用的固定 client id（hello 注册后 supervisor 才能 push TERMINAL_DATA 回来） */
export const WARDEN_CLIENT_ID = '__warden__';

// ── 管家协议 params/result（CLI 状态结构不在此重复定义，直接透传 ChannelCli.getStats()）──
export interface WardenTerminalDataParams {
  chat_id: string;
  /** PTY ring buffer 增量 / 回放（ANSI 文本） */
  data: string;
}
/** 仪表盘日志流条目（supervisor ring buffer 存、warden.recent-logs 透传给手机；同 launcher LogEntry 结构） */
export interface WardenLogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

/** 账号级用量（手机仪表盘头部展示）；字段缺失为 null */
export interface WardenSystemInfo {
  /** 当前在册频道数（supervisor.channels.size） */
  channel_count: number;
  /** 账号额度（5h/7天），同 statusLine rate_limits */
  rate_limits?: RateLimits | null;
}

// ── 子 → 主 params ──

export interface HelloParams {
  chat_id: string;
  pid: number;
}

export interface ByeParams {
  chat_id: string;
}

// ── 主 → 子 params ──

export interface FeishuInboundMessagePayload {
  chat_id: string;
  /** chat 友好名（"废话茶水间"），supervisor 从 chat.list 填；子端 setChatNameCache 写盘日志用 */
  chat_name?: string;
  message_id: string;
  msg_type: string;
  sender_open_id: string;
  sender_type: 'user' | 'app';
  text?: string;
  create_time_ms: number;
  /** supervisor/index.ts 单点提取，子端不再钻 raw 取这三字段 */
  content?: string;
  mentions?: unknown[];
  parent_id?: string;
  /** P2P 单聊标志（supervisor 按入站路径定：WS=true 群poll=false）。子端对话记录命名区分单聊用。 */
  is_p2p?: boolean;
  /** 原始飞书消息（含 mentions / parent_id / body / sender 全字段），传给子端做后续协议 #33 mention 解析等 */
  raw?: unknown;
}

export interface FeishuMessageParams {
  message: FeishuInboundMessagePayload;
}

export interface ChatTriggerParams {
  body: string;
  meta?: Record<string, string>;
}

// ── work session params（step 4 诉求 B 传话筒） ──

export interface WorkSpawnParams {
  /** 谁发起的——supervisor 通过这个反推 stop 信号往哪推 */
  origin_chat_id: string;
  work_dir: string;
  goal: string;
  /** 可选——默认 supervisor 用 opus 4.6 [1m] / high */
  model?: string;
  effort?: string;
}

export interface WorkSpawnResult {
  session_id: string;
}

export interface WorkSendParams {
  session_id: string;
  message: string;
}

export interface WorkEndParams {
  session_id: string;
}

export interface WorkOkResult {
  ok: boolean;
  error?: string;
}

// Q7: peek 主动观察 work 翻译行（品品判断啥时看，supervisor 返最近 N 条翻译事件）
export interface WorkPeekParams {
  session_id: string;
  /** 默认 50 条；上限 500 */
  limit?: number;
}

export interface WorkPeekResult {
  ok: boolean;
  error?: string;
  /** 人类可读翻译行（system_init/assistant/tool_use/tool_result/result），按时间顺序 */
  lines: string[];
  /** 当前 work 状态：running/stopped/failed 等 */
  status?: string;
}

export interface WorkStoppedPush {
  session_id: string;
  /** claude --output-format stream-json 的 type:"result" 事件 */
  result: string;
  is_error: boolean;
  stop_reason?: string;
  duration_ms?: number;
  total_cost_usd?: number;
}

// ── 手动 /压缩 params（compact_chat → COMPACT_VIA_PTY；复用 WorkOkResult 作返回）──
export interface CompactViaPtyParams {
  /** 触发压缩的频道 chat_id（supervisor 据此找 ChannelCli 写 PTY） */
  chat_id: string;
}

// ── 主动挂/停频道 params（SPAWN_CHANNEL / STOP_CHANNEL；均复用 WorkOkResult 返回）──
export interface SpawnChannelParams {
  chat_id: string;
  /** 可选频道友好名（建群时传群名；单聊可不传，supervisor 用 chat_id 兜底） */
  chat_name?: string;
}
export interface StopChannelParams {
  chat_id: string;
}

// ── 人名/bot名映射管理 params/result（GET_NAME_MAPPINGS / GET_PENDING_NAMES / SET_NAME_MAPPING）──
/** 全部映射；同 name-map-store 的 NameMap（humans: open_id→名, bots: cli_id→名） */
export interface NameMappings {
  humans: Record<string, string>;
  bots: Record<string, string>;
}
/** 待命名 sender 条目（解析后仍纯 ID 兜底=没友好名）：供启动器面板列出待Owner补名 */
export interface PendingNameEntry {
  id: string;
  chat_id: string;
  /** 该 sender 最近一条消息前 30 字（帮Owner认是谁） */
  snippet: string;
  type: 'human' | 'bot';
  ts: number;
}
export interface SetNameMappingParams {
  type: 'human' | 'bot';
  id: string;
  name: string;
}

// ── 账号级额度（来自 statusLine rate_limits）：每窗口 used_percentage(0-100) + resets_at(Unix 秒) ──
// 仅 Claude Code 用量额度数据存在时出现，窗口可独立缺失 → 字段 null。
export interface RateLimitWindow {
  used_percentage: number | null;
  resets_at: number | null;
}
export interface RateLimits {
  five_hour?: RateLimitWindow | null;
  seven_day?: RateLimitWindow | null;
}

// ── P1.3 statusLine sink params ──
export interface StatuslineUpdateParams {
  chat_id: string;
  /** 上下文 window 已用百分比 (0-100) */
  used_percentage: number | null;
  /** 当前上下文 input tokens (input + cache_read + cache_create) */
  total_input_tokens: number | null;
  /** 上下文 window 最大尺寸（如 1000000 for [1m]） */
  context_window_size: number | null;
  /** session 累计花费 USD */
  cost_usd: number | null;
  /** session 累计 wall-clock 时长 ms */
  duration_ms: number | null;
  /** 账号级额度（5h + 7天）；来自 statusLine rate_limits，缺失窗口/字段为 null */
  rate_limits?: RateLimits | null;
}

// ── 方案A 投票记票 params/result（POLL_VOTE；main → child request）──
export interface PollVoteParams {
  poll_id: string;
  option_idx: number;
  voter_open_id: string;
}
export interface PollVoteResult {
  ok: boolean;
  error?: string;
  question?: string;
  options?: string[];
  /** option_idx → 票数 */
  votes?: Record<number, number>;
}

// ── NDJSON framing utils ──

/** 编码一条 envelope 为单行（含 \n） */
export function encodeFrame(env: IpcEnvelope): string {
  return JSON.stringify(env) + '\n';
}
