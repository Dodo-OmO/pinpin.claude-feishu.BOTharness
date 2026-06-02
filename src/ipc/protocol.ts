/**
 * supervisor ↔ stdio MCP server 子进程 IPC 协议定义。
 *
 * 双方通过本机 TCP（127.0.0.1）传输 NDJSON（每行一个 JSON 对象），不走 stdio——
 * 因为 stdio MCP server 的 stdin/stdout 是被 Claude Code CLI 占用的 JSON-RPC channel。
 *
 * 协议风格类似 LSP：单向 notification + 双向 request/response（id 配对）。
 *
 * **子 → 主** notifications:
 *   - hello              { chat_id, pid }                        子进程上线，注册映射
 *   - bye                { chat_id }                             子进程优雅退出
 *
 * **主 → 子** notifications:
 *   - feishu.message     { message: FeishuInboundMessage }       新消息推过来
 *   - chat-trigger       { body, meta? }                         cron / 手动 trigger（push-channel 用）
 *
 * 步骤 3 实装：以上 4 个 notification。其它（tool RPC 等）后续步骤补。
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
  // 批2: work CLI 的 Stop hook（work-stop-sink.cjs）→ supervisor 推完工信号（fire-and-forget，不走 hello）
  WORK_STOP_SIGNAL: 'worksession.stop-signal',
  // P1.3: statusLine sink → supervisor 推 per-CLI 上下文用量（fire-and-forget，不走 hello）
  STATUSLINE_UPDATE: 'statusline.update',
  // 手动 /压缩：compact_chat tool → supervisor 往本频道 CLI 的 PTY 写 `/compact\n` 触发原生压缩
  COMPACT_VIA_PTY: 'compact.via-pty',  // request → returns { ok }
  // 品品主动单聊 / 建群后即时挂频道监听（不等对方或群友先发消息）
  SPAWN_CHANNEL: 'spawn-channel',      // request → returns WorkOkResult
  // 解散群后停该频道 CLI
  FORGET_CHANNEL: 'forget-channel',    // request → returns WorkOkResult
  // 方案A：投票点击 → supervisor 把记票请求路由到有 DB 的频道子进程执行（main → child request）
  POLL_VOTE: 'poll.vote',              // main → child request → returns PollVoteResult
} as const;

export type IpcMethod = (typeof IPC_METHODS)[keyof typeof IPC_METHODS];

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

// ── 主动挂/停频道 params（SPAWN_CHANNEL / FORGET_CHANNEL；均复用 WorkOkResult 返回）──
export interface SpawnChannelParams {
  chat_id: string;
  /** 可选频道友好名（建群时传群名；单聊可不传，supervisor 用 chat_id 兜底） */
  chat_name?: string;
}
export interface ForgetChannelParams {
  chat_id: string;
}

// ── 批2 work CLI 完工信号 params（work-stop-sink.cjs Stop hook → supervisor）──
export interface WorkStopSignalParams {
  /** 哪个 work session（hook command 里 --ws-id= 注入，回传以映射 WorkSession 实例） */
  ws_id: string;
  /** work CLI 的 transcript jsonl 路径（hook stdin 直接给，根治 supervisor 找不到 jsonl） */
  transcript_path: string;
  /** 本轮最近一条 assistant 文字（sink 反扫 transcript 提取，作完工回报正文） */
  last_text: string;
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
