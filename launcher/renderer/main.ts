/**
 * 启动器主面板 renderer —— vanilla JS + IPC 订阅 supervisor 状态实时刷新。
 *
 * 数据流：
 *   main.ts (electron main, 持 supervisor) ──IPC 'state'/'log'──▶ renderer
 *   renderer 收 state → 重渲染 channels / work sessions / counts
 *   renderer 收 log → 推 logs[] 数组，按 nav 当前页面/filter 渲染
 *
 * 用户交互：
 *   channel 卡 -> 打开终端 (step 6 占位) / ⋯ dropdown (启停 / compact / 重启)
 *   nav 切换 5 页
 *   footer 按钮：重启品品 / 完全关闭
 */

interface ChannelStatusInfo {
  chat_id: string;
  chat_name?: string;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  pid?: number;
  uptime_ms: number;
  /** CLI 进程启动时刻（Date.now()）；停止时为 null */
  started_at?: number | null;
  model: string;
  effort: string;
  // P1.3: per-CLI 上下文用量
  context_pct?: number | null;
  context_tokens?: number | null;
  context_window_size?: number | null;
  cost_usd?: number | null;
  usage_updated_at?: number;
}

interface WorkSessionInfo {
  session_id: string;
  origin_chat_id: string;
  work_dir: string;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  pid?: number;
  uptime_ms: number;
  model: string;
  effort: string;
  /** Q4 续: work session 上下文用量（jsonl assistant.usage 实时） */
  context_tokens?: number;
  context_window_size?: number | null;
  context_pct?: number | null;
}

interface SupervisorStateSnapshot {
  ipc_port: number;
  chats: Array<{ chat_id: string; name?: string }>;
  channels: ChannelStatusInfo[];
  work_sessions: WorkSessionInfo[];
  today_messages: number;
}

interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

interface AppSettings {
  default_model: string;
  default_effort: string;
  work_default_model: string;
  work_default_effort: string;
}

interface RateLimitWindow { used_percentage: number | null; resets_at: number | null }
interface QuotaSnapshot {
  ts: number;
  available: boolean;
  blocks?: { tokens?: number };
  daily?: { tokens?: number; cost_usd?: number };
  weekly?: { tokens?: number };
  /** 账号级额度 5h+7天（来自 statusLine rate_limits，非 ccusage）：各窗口 used_percentage + resets_at(Unix 秒) */
  rate_limits?: { five_hour?: RateLimitWindow | null; seven_day?: RateLimitWindow | null } | null;
  error?: string;
}

declare global {
  interface Window {
    pinpin: {
      ping: () => Promise<string>;
      getState: () => Promise<SupervisorStateSnapshot>;
      onState: (cb: (s: SupervisorStateSnapshot) => void) => () => void;
      onLog: (cb: (l: LogEntry) => void) => () => void;
      onQuota: (cb: (s: QuotaSnapshot) => void) => () => void;
      channel: {
        start: (id: string) => Promise<void>;
        startAll: () => Promise<void>;
        stop: (id: string) => Promise<void>;
        restart: (id: string) => Promise<void>;
        compact: (id: string) => Promise<void>;
        openTerminal: (id: string) => Promise<void>;
        setModel: (id: string, model: string) => Promise<void>;
        setEffort: (id: string, effort: string) => Promise<void>;
        setDisplayName: (id: string, name: string) => Promise<void>;
        forget: (id: string) => Promise<boolean>;
        listForgotten: () => Promise<Array<{ chat_id: string; display_name?: string }>>;
        restoreForgotten: (id: string) => Promise<boolean>;
      };
      work: { end: (id: string) => Promise<void>; openTerminal: (id: string) => Promise<void> };
      app: { restartBot: () => Promise<void>; quit: () => Promise<void> };
      settings: { get: () => Promise<AppSettings>; set: (s: Partial<AppSettings>) => Promise<void> };
      quota: { fetchNow: () => Promise<{ ok: true } | null> };
    };
  }
}

// ── 状态 ──
let lastState: SupervisorStateSnapshot = { ipc_port: 0, chats: [], channels: [], work_sessions: [], today_messages: 0 };
const logs: LogEntry[] = [];
const errors: LogEntry[] = [];
const MAX_LOGS = 500;

function fmtUptime(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** 频道卡"启动"项：绝对启动时间 "YYYY-MM-DD HH:mm（X 前）"。
 *  started_at 缺失时回退到相对时长（兼容旧 supervisor / 重启过渡态）。 */
function fmtStartedAt(c: ChannelStatusInfo): string {
  if (c.started_at) {
    const d = new Date(c.started_at);
    const pad = (n: number) => String(n).padStart(2, '0');
    const abs = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const rel = fmtUptime(Date.now() - c.started_at);
    return `${abs}（${rel} 前）`;
  }
  if (c.uptime_ms > 0) return `${fmtUptime(c.uptime_ms)} 前`;
  return c.status === 'stopped' ? '已关闭' : '—';
}

function healthDot(status: ChannelStatusInfo['status']): string {
  if (status === 'running') return 'green';
  if (status === 'starting') return 'yellow';
  if (status === 'failed') return 'red';
  return 'gray';
}

function effortClass(effort: string): string {
  if (effort === 'low') return 'effort-low';
  if (effort === 'medium') return 'effort-medium';
  if (effort === 'high') return 'effort-high';
  if (effort === 'max' || effort === 'xhigh') return 'effort-max';
  return '';
}

// ── 频道行渲染 ──
// ⚠️ model 名与 [1m] 之间必须有空格；sonnet 不带 [1m]（Owner 2026-05-31 定）
const MODEL_OPTIONS = ['claude-opus-4-8 [1m]', 'claude-opus-4-7 [1m]', 'claude-opus-4-6 [1m]', 'claude-sonnet-4-6'];
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'max'];

/** 生成 model <option> 列表。current 不在 MODEL_OPTIONS 时补一个（兼容旧持久化值，避免 select 静默回退第一项后被覆盖）。 */
function buildModelOptions(current: string): string {
  const opts = MODEL_OPTIONS.includes(current) || !current ? MODEL_OPTIONS : [current, ...MODEL_OPTIONS];
  return opts
    .map((m) => `<option value="${escapeHtml(m)}" ${m === current ? 'selected' : ''}>${escapeHtml(m)}</option>`)
    .join('');
}

function renderChannels(): void {
  const row = document.getElementById('channels-row');
  if (!row) return;
  const channels = lastState.channels;
  if (channels.length === 0) {
    row.innerHTML = `<div class="empty-hint">尚未拉到 chat 列表（supervisor 正在启动 / 飞书空）</div>`;
  } else {
    row.innerHTML = channels.map((c) => renderChannelCard(c)).join('');
    // wire button actions
    row.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        const cid = btn.getAttribute('data-chat-id');
        if (!action || !cid) return;
        if (action === 'open-terminal') {
          void window.pinpin.channel.openTerminal(cid);
        } else if (action === 'start') void window.pinpin.channel.start(cid);
        else if (action === 'stop') void window.pinpin.channel.stop(cid);
        else if (action === 'restart') void window.pinpin.channel.restart(cid);
        else if (action === 'compact') void window.pinpin.channel.compact(cid);
        else if (action === 'forget') {
          // 2026-05-28 频道常驻 + forget：renderer 不能用 window.confirm（默认禁用），
          // 改由 main process 弹原生 dialog.showMessageBox（IPC handler 里做），renderer 只触发
          void window.pinpin.channel.forget(cid);
        }
        else if (action === 'rename') {
          // Electron renderer 默认禁用 window.prompt/confirm/alert（silent return null），
          // 改用 contentEditable 让 .card-title 自身可编辑
          const card = btn.closest('.card');
          const titleEl = card?.querySelector('.card-title') as HTMLDivElement | null;
          if (!titleEl) return;
          const originalText = titleEl.textContent ?? '';
          titleEl.contentEditable = 'true';
          titleEl.classList.add('editing');
          titleEl.focus();
          // select all
          const range = document.createRange();
          range.selectNodeContents(titleEl);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);

          let committed = false;
          const commit = (): void => {
            if (committed) return;
            committed = true;
            titleEl.contentEditable = 'false';
            titleEl.classList.remove('editing');
            const next = (titleEl.textContent ?? '').trim();
            if (next !== originalText.trim()) {
              void window.pinpin.channel.setDisplayName(cid, next);
            }
          };
          const cancel = (): void => {
            if (committed) return;
            committed = true;
            titleEl.contentEditable = 'false';
            titleEl.classList.remove('editing');
            titleEl.textContent = originalText;
          };
          titleEl.addEventListener('blur', commit, { once: true });
          titleEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              titleEl.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          });
        }
      });
    });
    // wire dropdown change（运行中 disabled，所以只 stopped 时触发）
    row.querySelectorAll<HTMLSelectElement>('select[data-channel-config]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const cid = sel.getAttribute('data-chat-id');
        const kind = sel.getAttribute('data-channel-config'); // 'model' | 'effort'
        if (!cid || !kind) return;
        if (kind === 'model') void window.pinpin.channel.setModel(cid, sel.value);
        else if (kind === 'effort') void window.pinpin.channel.setEffort(cid, sel.value);
      });
    });
  }
  const count = document.getElementById('channels-count');
  if (count) {
    const running = channels.filter((c) => c.status === 'running').length;
    const stopped = channels.length - running;
    count.textContent = stopped > 0 ? `${running} 监听 · ${stopped} 已关闭` : `${running} 监听`;
  }
}

function fmtCtxLine(c: ChannelStatusInfo): string {
  // P1.3: 上下文用量行（statusLine sink 事件驱动；未收到时显示 "—"）
  if (c.context_pct === null || c.context_pct === undefined) return '—';
  const pct = Math.round(c.context_pct);
  const tok = c.context_tokens !== null && c.context_tokens !== undefined
    ? (c.context_tokens >= 1000 ? `${(c.context_tokens / 1000).toFixed(0)}k` : `${c.context_tokens}`)
    : '';
  const max = c.context_window_size
    ? (c.context_window_size >= 1_000_000 ? `${c.context_window_size / 1_000_000}M` : `${c.context_window_size / 1000}k`)
    : '';
  const main = tok && max ? `${tok}/${max} (${pct}%)` : `${pct}%`;
  return main;
}
function ctxPctClass(pct?: number | null): string {
  if (pct === null || pct === undefined) return '';
  if (pct < 50) return 'ctx-low';
  if (pct < 80) return 'ctx-mid';
  return 'ctx-high';
}

function renderChannelCard(c: ChannelStatusInfo): string {
  const dim = c.status === 'stopped' ? 'dim' : '';
  const isRunning = c.status === 'running' || c.status === 'starting';
  const lockTitle = isRunning ? '运行中不可换，先关闭频道再切' : '';
  const startedBtn = c.status === 'stopped'
    ? `<button class="btn primary" data-action="start" data-chat-id="${c.chat_id}">启动</button>`
    : `<button class="btn primary" data-action="open-terminal" data-chat-id="${c.chat_id}">打开终端</button>`;
  const compactBtn = isRunning
    ? `<button class="btn btn-more" data-action="compact" data-chat-id="${c.chat_id}" title="压缩上下文 /compact">压缩</button>`
    : '';
  const restartBtn = `<button class="btn btn-more" data-action="restart" data-chat-id="${c.chat_id}" title="重启">↻</button>`;
  const stopBtn = c.status === 'running'
    ? `<button class="btn btn-more" data-action="stop" data-chat-id="${c.chat_id}" title="关闭">✕</button>`
    : '';
  // 2026-05-28 频道常驻 + forget：删除卡片入口（不再常驻 + 后续不再重 spawn）
  const forgetBtn = `<button class="btn btn-more btn-danger" data-action="forget" data-chat-id="${c.chat_id}" data-chat-name="${escapeHtml(c.chat_name ?? c.chat_id.slice(-12))}" title="删除频道（停止 CLI + 不再重连）">🗑</button>`;
  // dropdown: 运行中灰，选当前 c.model / c.effort
  const modelOptions = buildModelOptions(c.model);
  const effortOptions = EFFORT_OPTIONS.map((e) =>
    `<option value="${e}" ${e === c.effort ? 'selected' : ''}>${e}</option>`,
  ).join('');
  return `
    <div class="card ${dim}">
      <div class="card-head">
        <div class="health-dot ${healthDot(c.status)}"></div>
        <div class="card-title" title="${escapeHtml(c.chat_id)}">${escapeHtml(c.chat_name ?? c.chat_id.slice(-12))}</div>
        <button class="btn-rename" data-action="rename" data-chat-id="${c.chat_id}" data-current-name="${escapeHtml(c.chat_name ?? '')}" title="改卡片名">✎</button>
      </div>
      <div class="card-meta">
        <div class="k">模型</div>
        <div class="v"><select class="card-select" data-channel-config="model" data-chat-id="${c.chat_id}" ${isRunning ? 'disabled' : ''} title="${lockTitle}">${modelOptions}</select></div>
        <div class="k">effort</div>
        <div class="v"><select class="card-select effort-select ${effortClass(c.effort)}" data-channel-config="effort" data-chat-id="${c.chat_id}" ${isRunning ? 'disabled' : ''} title="${lockTitle}">${effortOptions}</select></div>
        <div class="k">上下文</div><div class="v ${ctxPctClass(c.context_pct)}">${fmtCtxLine(c)}</div>
        <div class="k">启动</div><div class="v">${fmtStartedAt(c)}</div>
      </div>
      <div class="card-actions">${startedBtn}${compactBtn}${restartBtn}${stopBtn}${forgetBtn}</div>
    </div>
  `;
}

function renderWorkSessions(): void {
  const row = document.getElementById('work-row');
  if (!row) return;
  const ws = lastState.work_sessions;
  if (ws.length === 0) {
    row.innerHTML = `<div class="empty-hint">无进行中的 work session</div>`;
  } else {
    row.innerHTML = ws.map((w) => {
      const originName = lastState.chats.find((c) => c.chat_id === w.origin_chat_id)?.name ?? w.origin_chat_id.slice(-12);
      const ctxText = w.context_pct != null
        ? `${w.context_pct}% (${fmtTokens(w.context_tokens)})`
        : w.context_tokens != null
          ? fmtTokens(w.context_tokens)
          : '—';
      const ctxClass = w.context_pct == null ? '' :
        w.context_pct > 80 ? 'ctx-high' :
        w.context_pct > 50 ? 'ctx-mid' : 'ctx-low';
      return `
      <div class="card work-card">
        <div class="card-head">
          <div class="health-dot ${healthDot(w.status)}"></div>
          <div class="card-title" title="${escapeHtml(w.work_dir)}">${escapeHtml(w.work_dir.split(/[\\/]/).pop() ?? w.work_dir)}</div>
          <div class="card-tag">${w.status}</div>
        </div>
        <div class="card-meta">
          <div class="k">来自</div><div class="v" title="${escapeHtml(w.origin_chat_id)}">${escapeHtml(originName)}</div>
          <div class="k">模型</div><div class="v">${escapeHtml(w.model)}</div>
          <div class="k">effort</div><div class="v ${effortClass(w.effort)}">${w.effort}</div>
          <div class="k">上下文</div><div class="v ${ctxClass}">${ctxText}</div>
          <div class="k">启动</div><div class="v">${fmtUptime(w.uptime_ms)} 前</div>
        </div>
        <div class="card-actions">
          <button class="btn primary" data-work-open-terminal="${w.session_id}" title="打开 work 终端：关窗不杀进程，真结束点 ✕">打开终端</button>
          <button class="btn btn-more" data-work-end="${w.session_id}" title="结束">✕</button>
        </div>
      </div>
    `;
    }).join('');
    row.querySelectorAll<HTMLButtonElement>('button[data-work-end]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-work-end');
        if (id) void window.pinpin.work.end(id);
      });
    });
    row.querySelectorAll<HTMLButtonElement>('button[data-work-open-terminal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-work-open-terminal');
        if (id) void window.pinpin.work.openTerminal(id);
      });
    });
  }
  const count = document.getElementById('work-count');
  if (count) count.textContent = `${ws.filter((w) => w.status === 'running').length} 进行中`;
}

// ── 日志渲染 ──
let currentLogFilter: 'all' | 'warn' | 'error' = 'all';
/** 2026-05-28：按 source（频道 / 系统）过滤；'all' = 不过滤 / '__system__' = 非频道 source / 否则 source 名匹配 */
let currentSourceFilter = 'all';

/** 把当前 lastState.channels 的可读名 + "系统" 选项 populate 到 source filter select */
function populateLogSourceFilters(): void {
  const channelNames = lastState.channels.map((c) => c.chat_name ?? c.chat_id.slice(-12));
  const options =
    '<option value="all">全部</option>' +
    channelNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('') +
    '<option value="__system__">系统</option>';
  for (const id of ['log-source-filter-overview', 'log-source-filter-full']) {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    if (!el) continue;
    const prev = el.value;
    el.innerHTML = options;
    // 保持当前选中项（若刷新后选项仍存在）
    if ([...el.options].some((o) => o.value === prev)) el.value = prev;
  }
}

function renderLogs(): void {
  const overviewList = document.getElementById('log-list-overview');
  const fullList = document.getElementById('log-list-full');
  const channelNames = new Set(lastState.channels.map((c) => c.chat_name ?? c.chat_id.slice(-12)));
  const filtered = logs.filter((l) => {
    // level filter
    if (currentLogFilter === 'warn' && !(l.level === 'warn' || l.level === 'error')) return false;
    if (currentLogFilter === 'error' && l.level !== 'error') return false;
    // source filter
    if (currentSourceFilter === '__system__') {
      // "系统" = 不属于任何频道的 source（如 supervisor / launcher / feishu-poll 等）
      if (channelNames.has(l.source)) return false;
    } else if (currentSourceFilter !== 'all') {
      if (l.source !== currentSourceFilter) return false;
    }
    return true;
  });
  const html = filtered.slice(-200).map((l) => `
    <div class="log-row ${l.level === 'info' ? '' : l.level}">
      <span class="log-time">${fmtTime(l.ts)}</span>
      <span class="log-channel">${escapeHtml(l.source.slice(0, 10))}</span>
      <span class="log-msg">${escapeHtml(l.message)}</span>
    </div>
  `).join('');
  if (overviewList) {
    overviewList.innerHTML = html;
    overviewList.scrollTop = overviewList.scrollHeight;
  }
  if (fullList) {
    fullList.innerHTML = html;
    fullList.scrollTop = fullList.scrollHeight;
  }
  const total = document.getElementById('log-total');
  if (total) total.textContent = `${logs.length} 条`;
}

function renderErrors(): void {
  const list = document.getElementById('errors-list');
  if (!list) return;
  list.innerHTML = errors.slice(-200).map((e) => `
    <div class="log-row error">
      <span class="log-time">${fmtTime(e.ts)}</span>
      <span class="log-channel">${escapeHtml(e.source.slice(0, 10))}</span>
      <span class="log-msg">${escapeHtml(e.message)}</span>
    </div>
  `).join('');
  const count = document.getElementById('errors-count');
  if (count) count.textContent = `${errors.length} 条`;
  const badge = document.getElementById('error-badge');
  if (badge) {
    if (errors.length > 0) {
      badge.style.display = '';
      badge.textContent = String(errors.length);
    } else {
      badge.style.display = 'none';
    }
  }
  const footerBadge = document.getElementById('footer-err-badge');
  const footerCount = document.getElementById('footer-err-count');
  if (footerBadge && footerCount) {
    if (errors.length > 0) {
      footerBadge.style.display = '';
      footerCount.textContent = String(errors.length);
    } else {
      footerBadge.style.display = 'none';
    }
  }
}

// ── nav 切换 ──
function switchPage(page: string): void {
  document.querySelectorAll<HTMLElement>('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-page') === page);
  });
  document.querySelectorAll<HTMLElement>('.page').forEach((el) => {
    el.style.display = el.getAttribute('data-page') === page ? '' : 'none';
  });
  // 2026-05-28 进入"设置"页时拉一次 forgotten 列表
  if (page === 'settings') void refreshForgottenList();
}

async function refreshForgottenList(): Promise<void> {
  const container = document.getElementById('forgotten-list');
  if (!container) return;
  let items: Array<{ chat_id: string; display_name?: string }> = [];
  try {
    items = await window.pinpin.channel.listForgotten();
  } catch (e) {
    container.innerHTML = `<div class="empty-hint">读取失败：${escapeHtml(String(e))}</div>`;
    return;
  }
  if (items.length === 0) {
    container.innerHTML = `<div class="empty-hint">没有被删除的频道</div>`;
    return;
  }
  container.innerHTML = items.map((it) => {
    const name = it.display_name ?? it.chat_id.slice(-12);
    return `
      <div class="forgotten-row">
        <div class="forgotten-name" title="${escapeHtml(it.chat_id)}">${escapeHtml(name)}</div>
        <button class="btn primary" data-restore-chat-id="${escapeHtml(it.chat_id)}">恢复</button>
      </div>
    `;
  }).join('');
  container.querySelectorAll<HTMLButtonElement>('button[data-restore-chat-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-restore-chat-id');
      if (!id) return;
      btn.setAttribute('disabled', '');
      btn.textContent = '恢复中…';
      const ok = await window.pinpin.channel.restoreForgotten(id);
      if (ok) await refreshForgottenList(); // 重拉一遍
      else { btn.removeAttribute('disabled'); btn.textContent = '恢复'; }
    });
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── 初始化 ──
async function init(): Promise<void> {
  // nav 监听
  document.querySelectorAll<HTMLElement>('.nav-item').forEach((el) => {
    el.addEventListener('click', () => {
      const page = el.getAttribute('data-page');
      if (page) switchPage(page);
    });
  });
  // log filter
  const f1 = document.getElementById('log-filter-overview') as HTMLSelectElement | null;
  const f2 = document.getElementById('log-filter-full') as HTMLSelectElement | null;
  if (f1) f1.addEventListener('change', () => { currentLogFilter = f1.value as typeof currentLogFilter; renderLogs(); });
  if (f2) f2.addEventListener('change', () => { currentLogFilter = f2.value as typeof currentLogFilter; renderLogs(); });
  // 2026-05-28 source（频道）filter——双向同步 + 状态绑定
  const sf1 = document.getElementById('log-source-filter-overview') as HTMLSelectElement | null;
  const sf2 = document.getElementById('log-source-filter-full') as HTMLSelectElement | null;
  const onSourceChange = (sel: HTMLSelectElement): void => {
    currentSourceFilter = sel.value;
    // 双向同步：两处 dropdown 选项保持一致体验
    if (sf1 && sf1.value !== currentSourceFilter) sf1.value = currentSourceFilter;
    if (sf2 && sf2.value !== currentSourceFilter) sf2.value = currentSourceFilter;
    renderLogs();
  };
  if (sf1) sf1.addEventListener('change', () => onSourceChange(sf1));
  if (sf2) sf2.addEventListener('change', () => onSourceChange(sf2));
  document.getElementById('log-clear')?.addEventListener('click', () => { logs.length = 0; renderLogs(); });
  document.getElementById('errors-clear')?.addEventListener('click', () => { errors.length = 0; renderErrors(); });
  // settings
  document.getElementById('save-settings')?.addEventListener('click', async () => {
    const m = (document.getElementById('default-model') as HTMLSelectElement).value;
    const e = (document.getElementById('default-effort') as HTMLSelectElement).value;
    const wm = (document.getElementById('work-default-model') as HTMLSelectElement).value;
    const we = (document.getElementById('work-default-effort') as HTMLSelectElement).value;
    await window.pinpin.settings.set({ default_model: m, default_effort: e, work_default_model: wm, work_default_effort: we });
  });
  // footer btn
  // 确认对话框已移到 main process 的 ipcMain.handle('app.restart-bot') 里（dialog.showMessageBox），
  // renderer 不能用 window.confirm（Electron 默认禁用，静默返回 null）
  // 批3「开启所有」：启动器默认完全静默，点这个才把所有频道 CLI 开起来
  document.getElementById('btn-start-all')?.addEventListener('click', () => {
    void window.pinpin.channel.startAll();
  });
  document.getElementById('btn-restart-bot')?.addEventListener('click', () => {
    void window.pinpin.app.restartBot();
  });
  document.getElementById('btn-quit')?.addEventListener('click', () => {
    void window.pinpin.app.quit();
  });
  document.getElementById('refresh-channels')?.addEventListener('click', async () => {
    lastState = await window.pinpin.getState();
    renderAll();
  });
  document.getElementById('footer-err-badge')?.addEventListener('click', () => switchPage('errors'));

  // P1.3: 获取 quota 按钮 + 60s ago tick
  const fetchBtn = document.getElementById('quota-fetch');
  fetchBtn?.addEventListener('click', async () => {
    if (!fetchBtn) return;
    fetchBtn.setAttribute('disabled', '');
    fetchBtn.textContent = '获取中…';
    try {
      await window.pinpin.quota.fetchNow();
      // snapshot 通过 onQuota 推到 renderQuota，自动更新 lastQuotaTs
    } finally {
      setTimeout(() => {
        if (!fetchBtn) return;
        fetchBtn.removeAttribute('disabled');
        fetchBtn.textContent = lastQuotaTs ? '重新获取' : '主动获取';
      }, 500);
    }
  });
  setInterval(updateQuotaAgo, 60_000); // 每分钟刷一次 "X 分钟前" 文字

  // 设置初值
  try {
    const s = await window.pinpin.settings.get();
    // 批3: model 改下拉——用 buildModelOptions 填充（含旧值兼容：当前值不在列表则补一项，selected 已标好）
    const dm = document.getElementById('default-model') as HTMLSelectElement;
    dm.innerHTML = buildModelOptions(s.default_model);
    (document.getElementById('default-effort') as HTMLSelectElement).value = s.default_effort;
    const wdm = document.getElementById('work-default-model') as HTMLSelectElement;
    wdm.innerHTML = buildModelOptions(s.work_default_model);
    (document.getElementById('work-default-effort') as HTMLSelectElement).value = s.work_default_effort;
  } catch { /* ignore */ }

  // 拉一次 state + 订阅
  lastState = await window.pinpin.getState();
  renderAll();
  document.getElementById('about-ipc')!.textContent = `IPC port: ${lastState.ipc_port}`;

  window.pinpin.onState((s) => { lastState = s; renderAll(); });
  window.pinpin.onQuota((snap) => renderQuota(snap));
  window.pinpin.onLog((l) => {
    logs.push(l);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    if (l.level === 'error' || l.level === 'warn') {
      errors.push(l);
      if (errors.length > MAX_LOGS) errors.splice(0, errors.length - MAX_LOGS);
      renderErrors();
    }
    renderLogs();
  });
}

function renderAll(): void {
  renderChannels();
  renderWorkSessions();
  populateLogSourceFilters(); // 频道列表变动时刷新日志 source filter 选项
  document.getElementById('about-ipc')!.textContent = `IPC port: ${lastState.ipc_port}`;
  // 修内审 Optional #8 E7 本日消息统计 chip
  const msgChip = document.getElementById('quota-messages');
  if (msgChip) msgChip.textContent = String(lastState.today_messages);
}

function fmtTokens(n?: number): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

/** quota 百分比：有值显 " · NN%"，null/undefined 优雅省略（只显 token 数） */
function fmtPct(pct?: number | null): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '';
  return ` · ${Math.round(pct)}%`;
}

function fmtReset(seconds?: number): string {
  if (!seconds) return '';
  if (seconds < 3600) return `·重置 ${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `·重置 ${(seconds / 3600).toFixed(1)}h`;
  return `·重置 ${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

/** rate_limits.*.resets_at 是绝对 Unix 秒；渲染时换算成"距现在还剩"再交给 fmtReset（缺/已过则省略）。 */
function fmtResetAt(resetsAt?: number | null): string {
  if (resetsAt === null || resetsAt === undefined || !Number.isFinite(resetsAt)) return '';
  const remain = resetsAt - Math.floor(Date.now() / 1000);
  return remain > 0 ? fmtReset(remain) : '';
}

// P1.3: 上次 quota 获取时间戳 + ago 60s tick
let lastQuotaTs: number | null = null;
function fmtAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 30) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return new Date(ts).toLocaleString();
}
function updateQuotaAgo(): void {
  const el = document.getElementById('quota-ago');
  if (!el) return;
  if (lastQuotaTs === null) {
    el.textContent = '';
    return;
  }
  el.textContent = `获取于 ${new Date(lastQuotaTs).toLocaleTimeString().slice(0, 5)} (${fmtAgo(lastQuotaTs)})`;
}

function renderQuota(snap: QuotaSnapshot): void {
  const dailyEl = document.getElementById('quota-daily');
  const fiveH = document.getElementById('quota-5h');
  const weekly = document.getElementById('quota-weekly');

  lastQuotaTs = snap.ts;
  updateQuotaAgo();

  if (!snap.available) {
    if (dailyEl) dailyEl.textContent = '暂不可用';
    if (fiveH) fiveH.textContent = '—';
    if (weekly) weekly.textContent = '—';
    return;
  }
  if (dailyEl) {
    const tok = fmtTokens(snap.daily?.tokens);
    const cost = snap.daily?.cost_usd !== undefined ? ` · $${snap.daily.cost_usd.toFixed(2)}` : '';
    dailyEl.textContent = `${tok}${cost}`;
  }
  if (fiveH) {
    // 5h：token 数（ccusage）+ pct% + 重置时间（均来自 statusLine rate_limits.five_hour，无则优雅省略）
    const tok = fmtTokens(snap.blocks?.tokens);
    const pct = fmtPct(snap.rate_limits?.five_hour?.used_percentage);
    const reset = fmtResetAt(snap.rate_limits?.five_hour?.resets_at);
    fiveH.textContent = tok === '—' ? '—' : `${tok}${pct}${reset}`;
  }
  if (weekly) {
    // weekly：token 数（ccusage）+ pct% + 重置时间（均来自 statusLine rate_limits.seven_day，无则优雅省略）
    const tok = fmtTokens(snap.weekly?.tokens);
    const pct = fmtPct(snap.rate_limits?.seven_day?.used_percentage);
    const reset = fmtResetAt(snap.rate_limits?.seven_day?.resets_at);
    weekly.textContent = tok === '—' ? '—' : `${tok}${pct}${reset}`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});

export {};
