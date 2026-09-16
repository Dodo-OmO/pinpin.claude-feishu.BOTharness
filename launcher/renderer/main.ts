/**
 * 启动器主面板 renderer —— vanilla JS + IPC 订阅 supervisor 状态实时刷新。
 *
 * 数据流：
 *   main.ts (electron main, 持 supervisor) ──IPC 'state'/'log'──▶ renderer
 *   renderer 收 state → 重渲染 channels / counts
 *   renderer 收 log → 推 logs[] 数组，按 nav 当前页面/filter 渲染
 *
 * 用户交互：
 *   channel 卡 -> 终端/启停/压缩/重启 + ⚙设置弹窗(模型/effort/压缩/fast) + 休眠开关 + 改名
 *   睡眠频道折叠进"睡眠模式·N"区；设置 page 含全局默认 + "认识的人/bot"映射面板
 *   nav 切换：频道 / 日志流 / 错误队列 / 设置 / 关于
 *   footer 按钮：重启品品 / 完全关闭
 */

import type {
  ChannelStatusInfo,
  SupervisorStateSnapshot,
  LogEntry,
  AppSettings,
  QuotaSnapshot,
  NameMappings,
  PendingNameEntry,
  WorkerStatusInfo,
} from '../shared-types.js';
import { MODEL_OPTIONS, EFFORT_OPTIONS, supportsFast } from '../shared-types.js';

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
        stop: (id: string) => Promise<void>;
        restart: (id: string) => Promise<void>;
        compact: (id: string) => Promise<void>;
        openTerminal: (id: string) => Promise<void>;
        setModel: (id: string, model: string) => Promise<void>;
        setEffort: (id: string, effort: string) => Promise<void>;
        setCompactThreshold: (id: string, pct: number) => Promise<void>;
        setFast: (id: string, fast: boolean) => Promise<void>;
        setStandby: (id: string, standby: boolean) => Promise<void>;
        setDisplayName: (id: string, name: string) => Promise<void>;
      };
      app: { restartBot: () => Promise<void>; quit: () => Promise<void> };
      settings: { get: () => Promise<AppSettings>; set: (s: Partial<AppSettings>) => Promise<void> };
      quota: { fetchNow: () => Promise<{ ok: true } | null> };
      names: {
        getMappings: () => Promise<NameMappings>;
        getPending: () => Promise<PendingNameEntry[]>;
        set: (type: 'human' | 'bot', id: string, name: string) => Promise<void>;
      };
      personas: {
        list: () => Promise<string[]>;
        get: (chatId: string) => Promise<string[] | '__ALL__'>;
        set: (chatId: string, sel: string[] | '__ALL__') => Promise<void>;
      };
      worker: {
        wake: (name: string) => Promise<{ ok: boolean; state?: 'woke' | 'already' | 'failed'; error?: string }>;
        stop: (name: string) => Promise<void>;
      };
    };
  }
}

// ── 状态 ──
let lastState: SupervisorStateSnapshot = { ipc_port: 0, chats: [], channels: [], today_messages: 0, workers: [] };
const logs: LogEntry[] = [];
const errors: LogEntry[] = [];
const MAX_LOGS = 500;

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
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
// model/effort 清单单源见 src/ipc/protocol.ts（经 shared-types.js re-export；warden/public/index.html 经 /api/defaults 拿同一份）

/** 生成 model <option> 列表。current 不在 MODEL_OPTIONS 时补一个（兼容旧持久化值，避免 select 静默回退第一项后被覆盖）。 */
function buildModelOptions(current: string): string {
  const opts = MODEL_OPTIONS.includes(current) || !current ? MODEL_OPTIONS : [current, ...MODEL_OPTIONS];
  return opts
    .map((m) => `<option value="${escapeHtml(m)}" ${m === current ? 'selected' : ''}>${escapeHtml(m)}</option>`)
    .join('');
}

/** 频道卡上的可见动作（终端/启动/关闭/重启/压缩/⚙设置/改名）+ 休眠开关的事件委托接线。
 *  active 大卡与休眠折叠行都调它（同款 data-action / data-channel-config 属性）。 */
function wireChannelActions(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action');
      const cid = btn.getAttribute('data-chat-id');
      if (!action || !cid) return;
      if (action === 'open-terminal') void window.pinpin.channel.openTerminal(cid);
      else if (action === 'start') void window.pinpin.channel.start(cid);
      else if (action === 'stop') void window.pinpin.channel.stop(cid);
      else if (action === 'restart') void window.pinpin.channel.restart(cid);
      else if (action === 'compact') void window.pinpin.channel.compact(cid);
      else if (action === 'settings') openChannelModal(cid);
      else if (action === 'rename') {
        // Electron renderer 默认禁用 window.prompt/confirm（silent null），用 contentEditable 让 .card-title 可编辑
        const container = btn.closest('.card');
        const titleEl = container?.querySelector('.card-title') as HTMLDivElement | null;
        if (!titleEl) return;
        const originalText = titleEl.textContent ?? '';
        titleEl.contentEditable = 'true';
        titleEl.classList.add('editing');
        titleEl.focus();
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
          if (next !== originalText.trim()) void window.pinpin.channel.setDisplayName(cid, next);
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
          if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
      }
    });
  });
  // 休眠开关（运行中也可切——开启会立即 evict 该频道）
  root.querySelectorAll<HTMLInputElement>('input[data-channel-config="standby"]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const cid = inp.getAttribute('data-chat-id');
      if (!cid) return;
      void window.pinpin.channel.setStandby(cid, inp.checked);
    });
  });
}

// ── 频道列表：应用分组 + 在线/睡眠折叠 + 过滤 ──
// 折叠状态存 localStorage（key 带应用 label），跨刷新/重开保留；读写包 try/catch（隐私模式等场景静默降级）。
const FOLD_KEY_PREFIX = 'pinpin.chanFold.';
function getFoldState(label: string, section: 'online' | 'sleep', defaultExpanded: boolean): boolean {
  try {
    const v = localStorage.getItem(`${FOLD_KEY_PREFIX}${label}.${section}`);
    return v === null ? defaultExpanded : v === '1';
  } catch {
    return defaultExpanded;
  }
}
function setFoldState(label: string, section: 'online' | 'sleep', expanded: boolean): void {
  try {
    localStorage.setItem(`${FOLD_KEY_PREFIX}${label}.${section}`, expanded ? '1' : '0');
  } catch { /* 隐私模式等场景静默降级 */ }
}

let chanFilterText = '';
let filterActiveOnly = false;
let filterFreshOnly = false;

/** "有新消息" 快捷筛：60 分钟内有活动 或 有待投递消息。 */
function isFreshChannel(c: ChannelStatusInfo): boolean {
  return (c.pending_count ?? 0) > 0 || (c.last_activity_at !== undefined && Date.now() - c.last_activity_at < 3600_000);
}
function passesChanFilter(c: ChannelStatusInfo): boolean {
  if (chanFilterText && !(c.chat_name ?? '').toLowerCase().includes(chanFilterText)) return false;
  if (filterActiveOnly && !(c.status === 'running' || c.status === 'starting')) return false;
  if (filterFreshOnly && !isFreshChannel(c)) return false;
  return true;
}

/** 相对时间："刚刚 / x 分钟前 / x 小时前 / —"（无记录）。 */
function fmtRelTime(ts?: number): string {
  if (ts === undefined || ts === null) return '—';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  return `${Math.floor(diffSec / 3600)} 小时前`;
}

function groupByAppLabel(channels: ChannelStatusInfo[]): Array<{ label: string; channels: ChannelStatusInfo[] }> {
  const map = new Map<string, ChannelStatusInfo[]>();
  for (const c of channels) {
    const label = c.app_label || '其他';
    const arr = map.get(label);
    if (arr) arr.push(c);
    else map.set(label, [c]);
  }
  const labels = [...map.keys()].sort((a, b) => {
    if (a === '其他' && b !== '其他') return 1;
    if (b === '其他' && a !== '其他') return -1;
    return a.localeCompare(b, 'zh');
  });
  return labels.map((label) => ({ label, channels: map.get(label)! }));
}

function renderChannels(): void {
  const root = document.getElementById('channels-groups');
  if (!root) return;
  const all = lastState.channels;

  const count = document.getElementById('channels-count');
  if (count) {
    const active = all.filter((c) => c.status === 'running' || c.status === 'starting').length;
    const sleep = all.filter((c) => c.standby).length;
    const failed = all.filter((c) => c.status === 'failed').length;
    count.textContent = `${all.length} 个频道｜活 ${active}｜睡 ${sleep}｜挂 ${failed}`;
  }

  if (all.length === 0) {
    root.innerHTML = `<div class="empty-hint">尚未拉到 chat 列表（supervisor 正在启动 / 飞书空）</div>`;
    return;
  }
  const filtered = all.filter(passesChanFilter);
  if (filtered.length === 0) {
    root.innerHTML = `<div class="empty-hint">没有匹配的频道</div>`;
    return;
  }
  root.innerHTML = groupByAppLabel(filtered).map((g) => renderChanGroup(g)).join('')
    + renderWorkerGroup(lastState.workers ?? []); // 顶部总账不计工人：count 只统计 all（频道）
  wireChannelActions(root); // 工人「终端」按钮沿用同一 data-action="open-terminal" 事件委托（id 传 worker:<name>）
  wireWorkerActions(root);
  wireChanFolds(root);
}

// ── 工人（常驻托管：医生 / 总导演 / 顺子）分组：沿用 chan-group / chan-row 样式，紧跟在频道分组之后 ──
function workerDot(status: WorkerStatusInfo['status']): string {
  if (status === 'awake') return 'green';
  if (status === 'broken') return 'red';
  return 'gray';
}

function renderWorkerGroup(workers: WorkerStatusInfo[]): string {
  if (workers.length === 0) return '';
  return `
    <div class="chan-group">
      <div class="chan-group-title">工人</div>
      <div class="chan-section-body">
        ${workers.map((w) => renderWorkerRow(w)).join('')}
      </div>
    </div>
  `;
}

function renderWorkerRow(w: WorkerStatusInfo): string {
  const isAwake = w.status === 'awake';
  const wakeBtn = !isAwake
    ? `<button class="btn primary" data-action="worker-wake" data-worker-name="${escapeHtml(w.name)}">唤醒</button>`
    : '';
  const termBtn = isAwake
    ? `<button class="btn btn-more" data-action="open-terminal" data-chat-id="worker:${escapeHtml(w.name)}" title="打开终端">终端</button>`
    : '';
  const stopBtn = isAwake
    ? `<button class="btn btn-more" data-action="worker-stop" data-worker-name="${escapeHtml(w.name)}" title="结束">✕</button>`
    : '';
  const errHtml = w.status === 'broken' && w.error
    ? `<span class="worker-error" title="${escapeHtml(w.error)}">${escapeHtml(w.error)}</span>`
    : '';
  return `
    <div class="card chan-row">
      <div class="health-dot ${workerDot(w.status)}" title="${escapeHtml(w.status)}"></div>
      <div class="card-title chan-row-name" title="${escapeHtml(w.name)}">${escapeHtml(w.name)}</div>
      <div class="chan-row-activity" title="最后输出">${fmtRelTime(w.last_output_at)}</div>
      ${errHtml}
      <div class="chan-row-actions">${termBtn}${wakeBtn}${stopBtn}</div>
    </div>
  `;
}

/** 唤醒 / 结束按钮接线（终端按钮走 wireChannelActions 的 open-terminal 分支，不重复接）。 */
function wireWorkerActions(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('button[data-action="worker-wake"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-worker-name');
      if (!name) return;
      const row = btn.closest('.chan-row');
      row?.querySelector('.worker-error')?.remove();
      btn.setAttribute('disabled', '');
      const original = btn.textContent;
      btn.textContent = '唤醒中…';
      void window.pinpin.worker.wake(name).then((res) => {
        if (res.ok) return; // 成功：channel-state-changed 推 state 会重渲染整行
        btn.removeAttribute('disabled');
        btn.textContent = original;
        const err = document.createElement('span');
        err.className = 'worker-error';
        err.title = res.error ?? '未知原因';
        err.textContent = `唤醒失败：${res.error ?? '未知原因'}`;
        const actions = row?.querySelector('.chan-row-actions');
        actions?.parentElement?.insertBefore(err, actions);
      }).catch((e: unknown) => {
        btn.removeAttribute('disabled');
        btn.textContent = original;
        console.warn('[worker] 唤醒失败', e);
      });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('button[data-action="worker-stop"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // 确认对话框在 main process 的 ipcMain.handle('worker.stop') 里（renderer window.confirm 默认禁用）
      const name = btn.getAttribute('data-worker-name');
      if (name) void window.pinpin.worker.stop(name);
    });
  });
}

function renderChanGroup(g: { label: string; channels: ChannelStatusInfo[] }): string {
  // 按归属分段：常驻（默认展开）/ 睡眠（默认折叠）；运行状态看行首状态点
  const online = g.channels.filter((c) => !c.standby);
  const sleeping = g.channels.filter((c) => c.standby);
  return `
    <div class="chan-group">
      <div class="chan-group-title">${escapeHtml(g.label)}</div>
      ${renderChanSection(g.label, 'online', '常驻', online, getFoldState(g.label, 'online', true))}
      ${renderChanSection(g.label, 'sleep', '睡眠', sleeping, getFoldState(g.label, 'sleep', false))}
    </div>
  `;
}

function renderChanSection(groupLabel: string, sectionKey: 'online' | 'sleep', title: string, list: ChannelStatusInfo[], expanded: boolean): string {
  if (list.length === 0) return '';
  return `
    <div class="chan-section">
      <div class="chan-section-head" data-fold-group="${escapeHtml(groupLabel)}" data-fold-section="${sectionKey}">
        <span class="chan-section-caret ${expanded ? 'open' : ''}">▸</span>
        <span class="chan-section-title">${escapeHtml(title)} · ${list.length}</span>
      </div>
      <div class="chan-section-body" style="display:${expanded ? '' : 'none'}">
        ${list.map((c) => renderChannelRow(c)).join('')}
      </div>
    </div>
  `;
}

function wireChanFolds(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-fold-group]').forEach((head) => {
    head.addEventListener('click', () => {
      const group = head.getAttribute('data-fold-group');
      const section = head.getAttribute('data-fold-section') as 'online' | 'sleep' | null;
      const body = head.nextElementSibling as HTMLElement | null;
      const caret = head.querySelector('.chan-section-caret');
      if (!group || !section || !body) return;
      const next = body.style.display === 'none';
      body.style.display = next ? '' : 'none';
      caret?.classList.toggle('open', next);
      setFoldState(group, section, next);
    });
  });
}

/** 60s tick：只刷新已渲染行上的相对时间文本，不整页重渲染。 */
function refreshActivityTimes(): void {
  document.querySelectorAll<HTMLElement>('.chan-row-activity').forEach((el) => {
    const ts = el.getAttribute('data-ts');
    el.textContent = ts ? fmtRelTime(Number(ts)) : '—';
  });
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

/** 短模型名（卡面精简显示）：去掉 [1m] 后缀 + claude- 前缀。 */
function shortModel(model: string): string {
  return (model || '').replace(/\s*\[1m\]\s*/g, '').replace(/^claude-/, '').trim() || '—';
}

/** 休眠开关（拨动 toggle）。标准卡 + 休眠行复用。 */
function standbyToggle(c: ChannelStatusInfo): string {
  return `<label class="mode-toggle" title="左「常驻」=频道常开；右「睡眠」=睡下省额度、有人说话自动唤醒（品品能读到那条消息），每天4点重启回睡眠。随时可切。">
    <input type="checkbox" data-channel-config="standby" data-chat-id="${c.chat_id}" ${c.standby ? 'checked' : ''}>
    <span class="mode-track"><span class="mode-label lbl-on">常驻</span><span class="mode-label lbl-off">睡眠</span></span>
  </label>`;
}

/** 一行一频道：状态点 + 名字（省略号，title=全名）+ 模型短名·effort + 最后活动 + 待处理徽章 + 原有按钮组。
 *  行元素保留 `.card` / 名字元素保留 `.card-title`——改名功能（wireChannelActions rename 分支）靠这俩类名定位。 */
function renderChannelRow(c: ChannelStatusInfo): string {
  const dim = c.status === 'stopped' ? 'dim' : '';
  const failedCls = c.status === 'failed' ? 'chan-row-failed' : '';
  const startedBtn = c.status === 'stopped'
    ? `<button class="btn primary" data-action="start" data-chat-id="${c.chat_id}">启动</button>`
    : `<button class="btn primary" data-action="open-terminal" data-chat-id="${c.chat_id}" title="打开终端">终端</button>`;
  const compactBtn = c.status === 'running'
    ? `<button class="btn btn-more" data-action="compact" data-chat-id="${c.chat_id}" title="压缩上下文 /compact">压缩</button>`
    : '';
  const restartBtn = `<button class="btn btn-more" data-action="restart" data-chat-id="${c.chat_id}" title="重启">↻</button>`;
  const stopBtn = c.status === 'running'
    ? `<button class="btn btn-more" data-action="stop" data-chat-id="${c.chat_id}" title="关闭">✕</button>`
    : '';
  const gearBtn = `<button class="btn btn-more" data-action="settings" data-chat-id="${c.chat_id}" title="频道设置（模型/effort/压缩/fast）">⚙</button>`;
  const fastBadge = c.fast ? '<span class="badge-fast">fast</span>' : '';
  const sleepBadge = c.standby
    ? '<span class="badge-sleep" title="睡眠归属：全部重启后不自动上线，有人说话才临时唤醒">睡眠</span>'
    : '';
  const pendingBadge = (c.pending_count ?? 0) > 0
    ? `<span class="chan-pending-badge" title="待投递消息">${c.pending_count}</span>`
    : '';
  const fullName = c.chat_name ?? c.chat_id.slice(-12);
  return `
    <div class="card chan-row ${dim} ${failedCls}">
      <div class="health-dot ${healthDot(c.status)}" title="${escapeHtml(c.status)}"></div>
      <div class="card-title chan-row-name" title="${escapeHtml(fullName)}">${escapeHtml(fullName)}</div>
      <div class="chan-row-meta" title="模型 · effort">
        ${escapeHtml(shortModel(c.model))}<span class="sep">·</span><span class="${effortClass(c.effort)}">${escapeHtml(c.effort)}</span>
      </div>
      <div class="chan-row-activity" data-ts="${c.last_activity_at ?? ''}" title="最后活动">${fmtRelTime(c.last_activity_at)}</div>
      ${pendingBadge}
      ${sleepBadge}
      ${fastBadge}
      ${standbyToggle(c)}
      <div class="chan-row-actions">${startedBtn}${compactBtn}${gearBtn}${restartBtn}${stopBtn}<button class="btn-rename" data-action="rename" data-chat-id="${c.chat_id}" title="改名">✎</button></div>
    </div>
  `;
}

// ── 频道设置弹窗 ──
let modalChatId: string | null = null;

/** fast 开关仅 Opus 5 / Opus 4.8 支持：其余模型 disabled + title 说明，且强制取消勾选（供 openChannelModal /
 *  modelSel change 两处复用，保持一致）。 */
function applyFastAvailability(modelValue: string): void {
  const fastInp = document.getElementById('modal-fast') as HTMLInputElement | null;
  if (!fastInp) return;
  const ok = supportsFast(modelValue);
  fastInp.disabled = !ok;
  fastInp.title = ok ? '' : '只有 Opus 5 / Opus 4.8 支持 fast';
  if (!ok && fastInp.checked) fastInp.checked = false;
}

/** 打开某频道的设置弹窗：填模型/effort/压缩/fast/上下文。运行中也可改——改完该频道会接着原对话续接重启生效
 *  （supervisor.applyChannelConfigLive，非"重启清零"），弹窗内不再 disabled，改用提示语说明。 */
function openChannelModal(chatId: string): void {
  const c = lastState.channels.find((x) => x.chat_id === chatId);
  if (!c) return;
  modalChatId = chatId;
  const isRunning = c.status === 'running' || c.status === 'starting';
  const overlay = document.getElementById('chan-modal');
  const title = document.getElementById('chan-modal-title');
  const modelSel = document.getElementById('modal-model') as HTMLSelectElement;
  const effortSel = document.getElementById('modal-effort') as HTMLSelectElement;
  const compactInp = document.getElementById('modal-compact') as HTMLInputElement;
  const fastInp = document.getElementById('modal-fast') as HTMLInputElement;
  const ctxEl = document.getElementById('modal-ctx');
  const lockHint = document.getElementById('modal-lock-hint');
  if (!overlay || !modelSel || !effortSel || !compactInp || !fastInp) return;

  if (title) title.textContent = `频道设置 · ${c.chat_name ?? c.chat_id.slice(-12)}`;
  modelSel.innerHTML = buildModelOptions(c.model);
  modelSel.value = c.model;
  // effort 选项单源 EFFORT_OPTIONS；当前值不在列表则补一项（兼容旧持久化值）
  const effortList = EFFORT_OPTIONS.includes(c.effort) || !c.effort ? EFFORT_OPTIONS : [c.effort, ...EFFORT_OPTIONS];
  effortSel.innerHTML = effortList.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('');
  effortSel.value = c.effort;
  compactInp.value = String(c.autoCompactPct ?? 25);
  fastInp.checked = !!c.fast;
  applyFastAvailability(c.model);
  if (ctxEl) { ctxEl.textContent = fmtCtxLine(c); ctxEl.className = `modal-ctx ${ctxPctClass(c.context_pct)}`; }

  if (lockHint) {
    lockHint.style.display = isRunning ? '' : 'none';
    lockHint.textContent = isRunning ? '改完这个频道会接着原对话重启，十几秒后恢复。' : '';
  }

  // 人物画像多选：每次打开实时扫目录（自动刷新最新人物）；运行中也可改（只写 json，重启生效）
  void renderPersonaGrid(chatId);

  overlay.style.display = '';
}

/** 拉可用人物 + 本频道当前选择，渲染勾选框。change → 收集勾选项写盘（全勾→'__ALL__'）。 */
async function renderPersonaGrid(chatId: string): Promise<void> {
  const grid = document.getElementById('modal-personas');
  if (!grid) return;
  grid.innerHTML = '<span class="settings-hint">加载中…</span>';
  let all: string[];
  let cur: string[] | '__ALL__';
  try {
    [all, cur] = await Promise.all([window.pinpin.personas.list(), window.pinpin.personas.get(chatId)]);
  } catch (e) {
    grid.innerHTML = '<span class="settings-hint">加载失败</span>';
    console.warn('[personas] 加载失败', e);
    return;
  }
  if (modalChatId !== chatId) return; // 弹窗已切换/关闭，丢弃过期结果
  if (all.length === 0) { grid.innerHTML = '<span class="settings-hint">无可用人物画像</span>'; return; }
  const allSelected = cur === '__ALL__';
  const want = allSelected ? new Set(all) : new Set(cur);
  grid.innerHTML = all
    .map((n) => `<label class="persona-item"><input type="checkbox" value="${escapeHtml(n)}"${want.has(n) ? ' checked' : ''}>${escapeHtml(n)}</label>`)
    .join('');
  grid.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) =>
    cb.addEventListener('change', () => {
      if (modalChatId !== chatId) return;
      const picked = [...grid.querySelectorAll<HTMLInputElement>('input:checked')].map((x) => x.value);
      // 全勾 → '__ALL__'（与映射表语义一致：全选不写死名单，新增人物自动跟随）
      const sel: string[] | '__ALL__' = picked.length === all.length ? '__ALL__' : picked;
      void window.pinpin.personas.set(chatId, sel);
    }),
  );
}

function closeChannelModal(): void {
  modalChatId = null;
  const overlay = document.getElementById('chan-modal');
  if (overlay) overlay.style.display = 'none';
}

/** 弹窗内控件 change → 走原有 setModel/setEffort/setCompactThreshold/setFast IPC（一次性 wire，靠 modalChatId 取目标）。 */
function wireChannelModal(): void {
  const overlay = document.getElementById('chan-modal');
  const card = document.getElementById('chan-modal-card');
  const modelSel = document.getElementById('modal-model') as HTMLSelectElement | null;
  const effortSel = document.getElementById('modal-effort') as HTMLSelectElement | null;
  const compactInp = document.getElementById('modal-compact') as HTMLInputElement | null;
  const fastInp = document.getElementById('modal-fast') as HTMLInputElement | null;

  document.getElementById('chan-modal-close')?.addEventListener('click', closeChannelModal);
  // 点遮罩关闭（点卡片内部不关）
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) closeChannelModal(); });
  card?.addEventListener('click', (e) => e.stopPropagation());
  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && overlay.style.display !== 'none') closeChannelModal();
  });

  modelSel?.addEventListener('change', () => {
    applyFastAvailability(modelSel.value); // 切到不支持 fast 的模型时本地即时取消勾选（main 侧同步 apply fast=false，只重启一次）
    if (modalChatId) void window.pinpin.channel.setModel(modalChatId, modelSel.value);
  });
  effortSel?.addEventListener('change', () => {
    if (modalChatId) void window.pinpin.channel.setEffort(modalChatId, effortSel.value);
  });
  compactInp?.addEventListener('change', () => {
    if (!modalChatId) return;
    let v = Math.round(Number(compactInp.value));
    if (!Number.isFinite(v)) v = 25;
    v = Math.max(20, Math.min(70, v));
    compactInp.value = String(v);
    void window.pinpin.channel.setCompactThreshold(modalChatId, v);
  });
  fastInp?.addEventListener('change', () => {
    if (modalChatId) void window.pinpin.channel.setFast(modalChatId, fastInp.checked);
  });
}

// ── 认识的人 / bot 映射面板 ──
/** 拉 pending + mapped，渲染设置 page 面板 + 刷新设置红点。 */
async function refreshNamesPanel(): Promise<void> {
  try {
    const [pending, mappings] = await Promise.all([
      window.pinpin.names.getPending(),
      window.pinpin.names.getMappings(),
    ]);
    renderPendingNames(pending);
    renderMappedNames(mappings);
    updateNamesBadge(pending.length);
  } catch (e) { console.warn('[names] 刷新映射面板失败', e); }
}

/** 仅刷红点（channel-state-changed 时轻量调，不一定在设置 page）。 */
async function refreshNamesBadge(): Promise<void> {
  try {
    const pending = await window.pinpin.names.getPending();
    updateNamesBadge(pending.length);
  } catch (e) { console.warn('[names] 刷新待命名红点失败', e); }
}

function updateNamesBadge(pendingCount: number): void {
  const badge = document.getElementById('names-badge');
  if (badge) badge.style.display = pendingCount > 0 ? '' : 'none';
  const pc = document.getElementById('names-pending-count');
  if (pc) {
    if (pendingCount > 0) { pc.style.display = ''; pc.textContent = `${pendingCount} 待命名`; }
    else pc.style.display = 'none';
  }
}

function nameRowHtml(type: 'human' | 'bot', id: string, value: string, meta: string): string {
  const typeLabel = type === 'human' ? '人' : 'bot';
  return `
    <div class="name-row" data-name-id="${escapeHtml(id)}" data-name-type="${type}">
      <span class="name-type-badge ${type}">${typeLabel}</span>
      <span class="name-id" title="${escapeHtml(id)}">…${escapeHtml(id.slice(-6))}</span>
      ${meta ? `<span class="name-meta">${meta}</span>` : '<span class="name-meta"></span>'}
      <input class="name-input" type="text" value="${escapeHtml(value)}" placeholder="起个名字">
      <button class="name-save">保存</button>
    </div>`;
}

function renderPendingNames(pending: PendingNameEntry[]): void {
  const section = document.getElementById('names-pending-section');
  const list = document.getElementById('names-pending-list');
  if (!section || !list) return;
  if (pending.length === 0) { section.style.display = 'none'; list.innerHTML = ''; return; }
  section.style.display = '';
  list.innerHTML = pending.map((p) => {
    const chatName = lastState.channels.find((c) => c.chat_id === p.chat_id)?.chat_name ?? p.chat_id.slice(-8);
    const meta = `${escapeHtml(chatName)}｜${escapeHtml(p.snippet || '')}`;
    return nameRowHtml(p.type, p.id, '', meta);
  }).join('');
  wireNameSaves(list);
}

function renderMappedNames(m: NameMappings): void {
  const list = document.getElementById('names-mapped-list');
  if (!list) return;
  const rows: string[] = [];
  for (const [id, name] of Object.entries(m.humans ?? {})) rows.push(nameRowHtml('human', id, name, ''));
  for (const [id, name] of Object.entries(m.bots ?? {})) rows.push(nameRowHtml('bot', id, name, ''));
  list.innerHTML = rows.length > 0 ? rows.join('') : '<div class="empty-hint" style="padding:8px;">暂无映射</div>';
  wireNameSaves(list);
}

/** 接线"保存"按钮 + Enter 提交（同走 names.set）。 */
function wireNameSaves(root: HTMLElement): void {
  root.querySelectorAll<HTMLDivElement>('.name-row').forEach((rowEl) => {
    const id = rowEl.getAttribute('data-name-id');
    const type = rowEl.getAttribute('data-name-type') as 'human' | 'bot' | null;
    const input = rowEl.querySelector('.name-input') as HTMLInputElement | null;
    const btn = rowEl.querySelector('.name-save') as HTMLButtonElement | null;
    if (!id || !type || !input || !btn) return;
    const save = async (): Promise<void> => {
      const name = input.value.trim();
      if (!name) return;
      await window.pinpin.names.set(type, id, name);
      btn.textContent = '已存';
      btn.classList.add('saved');
      // pending 保存后该条消失、mapped 区出现 → 重拉刷新（state 推送也会触发，这里立即给反馈）
      setTimeout(() => { void refreshNamesPanel(); }, 350);
    };
    btn.addEventListener('click', () => void save());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } });
  });
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
  for (const id of ['log-source-filter-full', 'log-source-filter-overview']) {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    if (!el) continue;
    const prev = el.value;
    el.innerHTML = options;
    // 保持当前选中项（若刷新后选项仍存在）
    if ([...el.options].some((o) => o.value === prev)) el.value = prev;
  }
}

function renderLogs(): void {
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
  if (fullList) {
    fullList.innerHTML = html;
    fullList.scrollTop = fullList.scrollHeight;
  }
  const overviewList = document.getElementById('log-list-overview');
  if (overviewList) {
    overviewList.innerHTML = html;
    overviewList.scrollTop = overviewList.scrollHeight;
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
  // 进设置 page 时刷新"认识的人/bot"面板（拉最新 pending + mapped）
  if (page === 'settings') void refreshNamesPanel();
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
  // log filter（频道页底部嵌入日志区 + 「日志流」全屏页，共享 filter 状态）
  const f1 = document.getElementById('log-filter-overview') as HTMLSelectElement | null;
  if (f1) f1.addEventListener('change', () => { currentLogFilter = f1.value as typeof currentLogFilter; renderLogs(); });
  const f2 = document.getElementById('log-filter-full') as HTMLSelectElement | null;
  if (f2) f2.addEventListener('change', () => { currentLogFilter = f2.value as typeof currentLogFilter; renderLogs(); });
  // 2026-05-28 source（频道）filter
  const sf1 = document.getElementById('log-source-filter-overview') as HTMLSelectElement | null;
  if (sf1) sf1.addEventListener('change', () => { currentSourceFilter = sf1.value; renderLogs(); });
  const sf2 = document.getElementById('log-source-filter-full') as HTMLSelectElement | null;
  if (sf2) sf2.addEventListener('change', () => { currentSourceFilter = sf2.value; renderLogs(); });
  document.getElementById('log-clear')?.addEventListener('click', () => { logs.length = 0; renderLogs(); });
  document.getElementById('errors-clear')?.addEventListener('click', () => { errors.length = 0; renderErrors(); });
  // settings
  document.getElementById('save-settings')?.addEventListener('click', async () => {
    const m = (document.getElementById('default-model') as HTMLSelectElement).value;
    const e = (document.getElementById('default-effort') as HTMLSelectElement).value;
    const df = (document.getElementById('default-fast') as HTMLInputElement | null)?.checked ?? false;
    let dc = Math.round(Number((document.getElementById('default-compact') as HTMLInputElement).value));
    if (!Number.isFinite(dc)) dc = 25;
    dc = Math.max(20, Math.min(70, dc));
    await window.pinpin.settings.set({ default_model: m, default_effort: e, default_fast: df, default_compact_pct: dc });
  });
  // footer btn
  // 确认对话框已移到 main process 的 ipcMain.handle('app.restart-bot') 里（dialog.showMessageBox），
  // renderer 不能用 window.confirm（Electron 默认禁用，静默返回 null）
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

  // 频道设置弹窗（一次性 wire；靠 modalChatId 取目标频道）
  wireChannelModal();

  // 频道列表：名字过滤 + 两个可叠加快捷筛（按下态高亮）
  const chanFilterInput = document.getElementById('chan-filter') as HTMLInputElement | null;
  chanFilterInput?.addEventListener('input', () => {
    chanFilterText = chanFilterInput.value.trim().toLowerCase();
    renderChannels();
  });
  const filterActiveBtn = document.getElementById('filter-active');
  filterActiveBtn?.addEventListener('click', () => {
    filterActiveOnly = !filterActiveOnly;
    filterActiveBtn.classList.toggle('active', filterActiveOnly);
    renderChannels();
  });
  const filterFreshBtn = document.getElementById('filter-fresh');
  filterFreshBtn?.addEventListener('click', () => {
    filterFreshOnly = !filterFreshOnly;
    filterFreshBtn.classList.toggle('active', filterFreshOnly);
    renderChannels();
  });
  setInterval(refreshActivityTimes, 60_000); // 只刷相对时间文本，不整页重渲染

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
    const de = document.getElementById('default-effort') as HTMLSelectElement;
    // 已存值不在 EFFORT_OPTIONS 里时补一项（兼容旧持久化值，避免保存时被静默改成清单第一项）
    const defaultEffortList = EFFORT_OPTIONS.includes(s.default_effort) || !s.default_effort
      ? EFFORT_OPTIONS
      : [s.default_effort, ...EFFORT_OPTIONS];
    de.innerHTML = defaultEffortList.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('');
    de.value = s.default_effort;
    const ndf = document.getElementById('default-fast') as HTMLInputElement | null;
    if (ndf) ndf.checked = !!s.default_fast;
    (document.getElementById('default-compact') as HTMLInputElement).value = String(s.default_compact_pct ?? 25);
  } catch { /* ignore */ }

  // 拉一次 state + 订阅
  lastState = await window.pinpin.getState();
  renderAll();
  document.getElementById('about-ipc')!.textContent = `IPC port: ${lastState.ipc_port}`;
  void refreshNamesBadge(); // 开局拉一次待命名红点

  window.pinpin.onState((s) => {
    lastState = s;
    renderAll();
    // state 推送（含 channel-state-changed，命名变化也走它）→ 刷红点；在设置 page 时连面板一起刷
    const onSettings = document.querySelector('.nav-item.active')?.getAttribute('data-page') === 'settings';
    if (onSettings) void refreshNamesPanel();
    else void refreshNamesBadge();
  });
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
  populateLogSourceFilters(); // 频道列表变动时刷新日志 source filter 选项
  document.getElementById('about-ipc')!.textContent = `IPC port: ${lastState.ipc_port}`;
  // 修内审 Optional #8 E7 本日消息统计 chip
  const msgChip = document.getElementById('quota-messages');
  if (msgChip) msgChip.textContent = String(lastState.today_messages);
  void refreshNamesBadge(); // 待命名红点跟随 state 推送实时刷新（非设置页也亮）
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
