/**
 * supervisor ↔ stdio MCP server 子进程 IPC 协议定义。
 *
 * 双方通过本机 TCP（127.0.0.1）传输 NDJSON（每行一个 JSON 对象），不走 stdio——
 * 因为 stdio MCP server 的 stdin/stdout 是被 Claude Code CLI 占用的 JSON-RPC channel。
 *
 * 协议风格类似 LSP：单向 notification + 双向 request/response（id 配对）。
 * 方法全集见下方 IPC_METHODS 逐条注释（hello/bye、push、request、warden 桥接四类，40+ method）。
 */

// model/effort 清单单源——launcher renderer、warden-bridge、warden 页面都从这里取，不再各自维护副本。
export const MODEL_OPTIONS = ['claude-fable-5-1 [1m]', 'claude-opus-5 [1m]', 'claude-opus-4-8 [1m]', 'claude-opus-4-7 [1m]', 'claude-opus-4-6 [1m]', 'claude-sonnet-5', 'claude-sonnet-4-6'];
export const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'];

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
  // 彻底删除频道（delete_channel tool）：群→自建解散/否则退群，私聊→只清本地；归档简报+对话记录，取消待办、删画像映射
  DELETE_CHANNEL: 'delete-channel',    // request DeleteChannelParams → DeleteChannelResult
  // 记人名（set_person_name tool）：写认人表 + 私聊无名时补显示名
  SET_PERSON_NAME: 'set-person-name',  // request SetPersonNameParams → WorkOkResult
  // 叫醒常驻工人会话（wake_worker tool）：医生/工程师/顺子等，不在则 PTY 拉起并等就绪
  WAKE_WORKER: 'wake-worker',          // request WakeWorkerParams → WakeWorkerResult
  // 多飞书应用：supervisor 持有全部应用 client，跨应用能力集中在此（子进程只有本 chat 所属应用的 client）
  LIST_CHATS: 'list-chats',              // child → main request {} → ListChatsResult（全部应用的群，带 app 标签）
  PEER_MESSAGE: 'peer-message',          // child → main request PeerMessageParams → PeerMessageResult（给另一频道的品品捎话，main 推 trigger=peer-message）
  BROADCAST: 'broadcast',                // child → main request BroadcastParams → BroadcastResult（一件事扇出给相关频道，trigger=broadcast；同时落广播板）
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
  // 批4 全局设置 + 系统 + 日志
  WARDEN_GET_DEFAULTS: 'warden.get-defaults',     // request → {channel:{model,effort,fast,autoCompactPct}}
  WARDEN_SET_DEFAULTS: 'warden.set-defaults',     // request {model?,effort?,fast?,autoCompactPct?} → WorkOkResult
  WARDEN_RESTART_SUPERVISOR: 'warden.restart-supervisor', // request → WorkOkResult（重启品品 supervisor）
  WARDEN_QUIT_APP: 'warden.quit-app',             // request → WorkOkResult（关闭品品，经 main.ts isQuiting）
  WARDEN_RECENT_LOGS: 'warden.recent-logs',       // request {limit?} → {logs: WardenLogEntry[]}
  // ── 传话口(47901)：本机 Claude 窗口 ⇄ 品品（协议文档 docs/relay-protocol.md）──
  RELAY_HELLO: 'relay.hello',               // request RelayHelloParams → {ok, client_id}（首帧，验口令）
  RELAY_SUBMIT: 'relay.submit',             // request RelayNote 提交字段 → RelaySubmitResult
  RELAY_STATUS: 'relay.status',             // request {id} → RelayReceipt
  RELAY_RECEIPT: 'relay.receipt',           // notification → 提交方 session + relay 角色
  RELAY_LETTER: 'relay.letter',             // notification → relay 角色（hello 后补推未取走的）
  RELAY_LETTER_ACK: 'relay.letter-ack',     // request {id, result, note?} → {ok}
  RELAY_LETTER_TAKEN: 'relay.letter-taken', // notification {id} → 其余 relay 角色
  // 频道子进程 → supervisor
  RELAY_ACK: 'relay.ack',                   // request RelayAckParams → WorkOkResult
  RELAY_LETTER_CREATE: 'relay.letter-create', // request RelayLetterCreateParams → RelayLetterCreateResult
} as const;

export const RELAY_BRIDGE_PORT = 47901;

export type RelayAction = 'dm' | 'group' | 'group_at' | 'tell_pinpin';
export type RelayNoteStatus =
  | 'queued' | 'scheduled' | 'delivered' | 'sent' | 'deferred' | 'skipped' | 'failed' | 'no_ack';

export interface RelayHelloParams {
  token: string;
  role: 'submitter' | 'relay';
  session_title?: string;
  session_id?: string;
}

/** relay.submit params */
export interface RelaySubmitParams {
  id: string;
  from: { session_title: string; session_id?: string; project?: string };
  action: RelayAction;
  target?: { person?: string; chat?: string; at?: string[] };
  situation: string;
  request: string;
  urgency?: 'normal' | 'urgent';
  need_reply?: boolean;
  /** 回复来信时填来信 id（L-…） */
  reply_to?: string;
  attachments?: string[];
}

export type RelaySubmitResult =
  | { ok: true; id: string; status: RelayNoteStatus; deliver_after?: string }
  | { ok: false; id?: string; error: string; message?: string; candidates?: string[] };

/** relay.status 结果 / relay.receipt 推送 */
export interface RelayReceipt {
  id: string;
  /** 条子状态；查来信 id 时为来信状态 pending/taken/replied/expired */
  status: RelayNoteStatus | 'pending' | 'taken' | 'replied' | 'expired' | 'not_found';
  sent_text?: string;
  reason?: string;
  /** 对象回话（品品二次 ack 带上） */
  reply?: string;
  deliver_after?: string;
  updated_at?: string;
}

export interface RelayLetterPush {
  id: string;
  time: string;
  from: { chat_id: string; requester: string };
  target: string;
  content: string;
  need_reply: boolean;
  reply_chat_id: string;
}

export interface RelayAckParams {
  note_id: string;
  status: 'sent' | 'deferred' | 'skipped' | 'failed';
  sent_text?: string;
  reason?: string;
  reply?: string;
}

export interface RelayLetterCreateParams {
  target: string;
  content: string;
  need_reply: boolean;
}
export interface RelayLetterCreateResult {
  ok: boolean;
  id?: string;
  /** 当前在线传话员数（0 = 暂存待取） */
  relay_online?: number;
  error?: string;
}


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
  /** 管家桥接 hello 必带（bridge-token 文件内容）；频道子进程动态端口不校验 */
  token?: string;
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

export interface WorkOkResult {
  ok: boolean;
  error?: string;
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
  /** 单聊标志（B8 频道默认睡眠判定用：新私聊首次挂号默认 standby） */
  is_p2p?: boolean;
  /** 单聊对方 open_id（在 PINPIN_P2P_ALWAYS_ON_OPEN_IDS 白名单内则不睡眠） */
  peer_open_id?: string;
}
/** SPAWN_CHANNEL 返回：带上 supervisor 定的频道显示名，子进程写对话记录按它分目录 */
export interface SpawnChannelResult extends WorkOkResult {
  chat_name?: string;
}
export interface StopChannelParams {
  chat_id: string;
}

// ── 彻底删除频道 params/result（DELETE_CHANNEL）──
export interface DeleteChannelParams {
  chat_id: string;
  /** 必须原样复述频道显示名（去空格后全等）才放行，防误删 */
  confirm_name: string;
  /** true=品品自建群→解散；false/未传=Owner的正式群→退群 */
  disband?: boolean;
}
export interface DeleteChannelResult {
  ok: boolean;
  error?: string;
  chat_name?: string;
  kind?: 'group' | 'p2p';
  /** 归档/清理动作留痕（相对 vault 路径） */
  archived?: string[];
}

// ── 记人名 params（SET_PERSON_NAME；复用 WorkOkResult 返回）──
export interface SetPersonNameParams {
  open_id: string;
  name: string;
  /** 该私聊 chat_id（有值且该频道未落显示名时，同时补 `VS 名（私聊）`） */
  chat_id?: string;
}

// ── 常驻工人托管 params/result（WAKE_WORKER）──
export interface WakeWorkerParams {
  /** 工人名字，同 --name / ListAgents 里的名字（workers.json 配置项 name） */
  name: string;
}
export interface WakeWorkerResult {
  ok: boolean;
  /** woke=刚拉起成功；already=本来就醒着；failed=拉起或等就绪失败（详见 error） */
  state?: 'woke' | 'already' | 'failed';
  error?: string;
}

// ── 人名/bot名映射（supervisor 方法返回给启动器 Electron IPC 用；不走 TCP IPC）──
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

// ── 多飞书应用（LIST_CHATS / PEER_MESSAGE）──
export interface ChatSummary {
  chat_id: string;
  name?: string;
  app_id: string;
  /** 应用标签（.env FEISHU_APP_LABEL[_N]），给品品看的可读归属 */
  app_label: string;
}
export interface ListChatsResult {
  chats: ChatSummary[];
}
export interface PeerMessageParams {
  /** 目标频道 */
  chat_id: string;
  /** 捎的话：前因后果 + 请那边的品品做什么 */
  text: string;
  /** true = 原文逐字送达，不加"捎话"外壳（ask_person 回复转发用） */
  verbatim?: boolean;
  /** trigger 名（默认 peer-message；ask_person 用 ask-reply） */
  trigger?: string;
  /** 附加 meta，随 trigger 送到目标频道 */
  meta?: Record<string, string>;
}
export interface BroadcastParams {
  /** 事件类型：派活/改期/催办/完成/通知/其它 */
  kind: string;
  /** 一句话摘要 */
  text: string;
  /** person=只播 chat_ids；all=播全部Client频道（PINPIN_BROADCAST_CHAT_IDS） */
  scope: 'person' | 'all';
  chat_ids?: string[];
}
export interface BroadcastResult {
  /** 送达的频道友好名 */
  delivered: string[];
  /** 没送到的（拉不起来 / 不在服务范围） */
  failed: string[];
}
export interface PeerMessageResult {
  ok: boolean;
  /** 目标频道友好名（回给品品看） */
  chat_name?: string;
  error?: string;
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
