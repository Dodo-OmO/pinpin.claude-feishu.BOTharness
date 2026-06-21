/**
 * WorkSession —— 诉求 B "传话筒"的核心：品品 spawn 一个独立 claude code session
 * 在某 work_dir 干活，干完通过监听 jsonl 文件的 stop_reason 信号回报。
 *
 * 关键设计（P3.Q5 重写——Owner P3 实测反馈 "work 黑盒 + 终端空白"）：
 *   - 普通交互式 PTY（无 --output-format stream-json；stream-json 仅 -p 模式输出，
 *     交互式 PTY 模式下 stdout 不出 JSON 行——这是终端空白根因）
 *   - cwd = work_dir
 *   - 启动后 PTY write goal\n 进 stdin
 *   - claude code 自动写 jsonl 到 `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`
 *   - JsonlWatcher 监听该文件 + 增量读 → 翻译事件 → 落 translatedHistory（peek tool 用）+ usage 解析
 *   - 终端窗（Q5 v3）走 PtyManager.attach raw ANSI 字节 + xterm 渲染，不走翻译路径
 *   - stop signal：jsonl 出现 assistant.message.stop_reason === 'end_turn' 视为完成
 *   - 品品下新指令 → sendMessage(text) → PTY write
 *   - end() → PTY shutdown + JsonlWatcher stop
 *
 * **交互式 CLI 约束**：spawn args 绝不能用 `-p` / `--print`，必须**交互式 claude**。
 */

import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PtyManager } from './pty-manager.js';
import { JsonlWatcher, type JsonlEvent } from './jsonl-watcher.js';
import { resolveClaudePath, stripAnsi, claudeApiNetEnv } from './utils.js';

/** model name → context window size（用于上下文 % 计算）。未识别 model 返 null（UI 显示 tokens 不显 %） */
function contextWindowSize(model: string): number | null {
  const lower = model.toLowerCase();
  if (lower.includes('[1m]') || lower.includes('1m')) return 1_000_000;
  if (lower.includes('opus') || lower.includes('sonnet') || lower.includes('haiku')) return 200_000;
  return null;
}

export interface WorkSessionOptions {
  /** 谁发起的——supervisor 通过这个把 stop 信号 push 回原频道 CLI */
  originChatId: string;
  workDir: string;
  goal: string;
  model: string;
  effort: string;
  /** 批2: supervisor IPC server 端口——注入 work CLI env，让其 Stop hook(work-stop-sink) 能 TCP 回连。
   *  ⚠️ work CLI cwd=work_dir 非 vault，必须显式注入（不能靠 process.env 继承，supervisor 没写回 process.env）。 */
  supervisorPort: number;
  /** 批2: work-stop-sink.cjs 绝对路径（spawn 时经 --settings hooks.Stop 注入完工信号 hook） */
  stopSinkPath: string;
  /** fast 模式（Opus 加速输出）。true 时把 fastMode:true 合并进 work CLI 的 --settings JSON。 */
  fast?: boolean;
}

export type WorkSessionStatus = 'starting' | 'running' | 'stopped' | 'failed';

export interface WorkSessionStopInfo {
  result: string;
  is_error: boolean;
  stop_reason?: string;
  duration_ms?: number;
  total_cost_usd?: number;
}

export interface WorkUsage {
  context_tokens: number;
  context_window_size: number | null;
  context_pct: number | null;
  total_cost_usd: number;
  /** 最后一次更新时间 ms */
  updated_at: number;
}

/** Q5: jsonl 事件 → 人类可读行（终端窗口 + peek tool 共用）。无可读内容返 null 跳过 */
function translateJsonlEvent(ev: JsonlEvent): string | null {
  const ts = new Date().toTimeString().slice(0, 8);
  if (ev.type === 'mode' || ev.type === 'permission-mode' || ev.type === 'file-history-snapshot') {
    return null; // setup 事件不显示
  }
  if (ev.type === 'user') {
    const msg = (ev as { message?: { content?: unknown } }).message;
    const content = msg?.content;
    if (typeof content === 'string') {
      return `[${ts}] 👤 ${content}`;
    }
    if (Array.isArray(content)) {
      const lines: string[] = [];
      for (const part of content as Array<{ type: string; content?: unknown; is_error?: boolean }>) {
        if (part.type === 'tool_result') {
          const txt = typeof part.content === 'string'
            ? part.content
            : JSON.stringify(part.content);
          const icon = part.is_error ? '❌' : '✅';
          lines.push(`[${ts}] ${icon} 结果: ${txt}`);
        }
      }
      return lines.length > 0 ? lines.join('\n') : null;
    }
    return null;
  }
  if (ev.type === 'assistant') {
    const msg = (ev as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>; stop_reason?: string } }).message;
    const content = msg?.content;
    if (!Array.isArray(content)) return null;
    const lines: string[] = [];
    for (const part of content) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        lines.push(`[${ts}] 💬 ${part.text}`);
      } else if (part.type === 'tool_use') {
        const name = part.name ?? '?';
        const input = JSON.stringify(part.input ?? {});
        lines.push(`[${ts}] 🔧 ${name}: ${input}`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }
  return null;
}

/** 从 assistant 事件提取 usage（jsonl message.usage 含全 input/output/cache 拆分） */
function extractUsage(ev: JsonlEvent, model: string): WorkUsage | null {
  if (ev.type !== 'assistant') return null;
  const msg = (ev as { message?: { usage?: Record<string, unknown> } }).message;
  const u = msg?.usage;
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.input_tokens ?? 0);
  const cacheCreate = Number(u.cache_creation_input_tokens ?? 0);
  const cacheRead = Number(u.cache_read_input_tokens ?? 0);
  const contextTokens = input + cacheCreate + cacheRead;
  const cw = contextWindowSize(model);
  // 口径统一（与 statusline-sink.cjs 一致）：context_pct = 已用 input 总量 / 上下文窗口。
  // 分子 contextTokens = input + cache_creation + cache_read，等同 CLI statusLine 的 total_input_tokens；
  // 优先用 CLI 给的 used_percentage——但 work CLI 是 PTY 遥控、无 statusLine 回传，只能从 jsonl 自算兜底。
  return {
    context_tokens: contextTokens,
    context_window_size: cw,
    context_pct: cw ? Math.round((contextTokens / cw) * 1000) / 10 : null,
    total_cost_usd: 0, // jsonl assistant 行不直接含 cost；result 行才有
    updated_at: Date.now(),
  };
}

const TRANSLATED_HISTORY_LIMIT = 500;

/** 遥控修复 Bug2: idle 判停轮询间隔。 */
const IDLE_TICK_MS = 2000;
/** 遥控修复 Bug2: 连续无 PTY 输出多久判"真停下等指示"（Owner拍板 6s；tmux 同款输出静默判停）。 */
const QUIESCE_MS = 6000;

/** 遥控护栏 system prompt（--append-system-prompt 注入）：work CLI 被品品远程键入遥控，这端无人能点菜单/审批。
 *  防住"模型自己会触发的交互卡点"(AskUserQuestion/计划审批/等 stdin 的交互命令) + 要求每轮出【本轮总结】。 */
const WORK_CLI_GUARD_PROMPT =
  '你是被品品（飞书 bot）远程遥控的后台 work CLI：你这一端没有任何人类能实时点选菜单或交互审批，' +
  '指令由品品键入转达、你的输出由品品转给Owner。务必遵守：' +
  '①绝不调用 AskUserQuestion，也不要进入需要人确认/选择的交互（如计划模式 ExitPlanMode 等待审批）——' +
  '遇到抉择分叉用最合理默认自主决策并继续推进，绝不停下等人选择。' +
  '②不要运行会等待 stdin 输入的交互式命令（改用非交互参数/管道，或换非交互方式）。' +
  '③确需Owner拍板的事，把问题清楚写进你的文字回复（品品会转达），然后继续完成其他能做的部分，不要停在等待输入上。' +
  '④每一轮结束时在回复末尾给出【本轮总结】：完成了哪些、遇到哪些困难及如何自主解决、还有哪些遗留或需Owner拍板的问题' +
  '（按实际写，没有的项可省）。';

/** D3: cwd → Claude Code jsonl 目录名编码。照搬 CLI 规则：非字母数字字符（盘符冒号/反/正斜杠/点/
 *  空格/CJK 等）逐个替换为 '-'，不折叠连续 '-'（实测 `C:\Users\user` → `C--Users-user`）。
 *  jsonl 落于 `~/.claude/projects/<编码后cwd>/<sessionId>.jsonl`。 */
function jsonlPathForSession(cwd: string, sessionId: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

export class WorkSession extends EventEmitter {
  readonly opts: WorkSessionOptions;
  readonly id: string;
  private pty: PtyManager | null = null;
  private jsonlWatcher: JsonlWatcher | null = null;
  private _status: WorkSessionStatus = 'stopped';
  private startedAt: number | null = null;
  private goalSent = false;
  /** Q7: 翻译后的人类可读行 ring buffer（仅 peek tool 用——给品品看结构化事件比 ANSI 字节流更人话）
   *  终端窗口不再用此路径（v2 改走 PtyManager raw bytes + xterm 渲染，跟 channel CLI 同款） */
  private translatedHistory: string[] = [];
  /** Q5: jsonl scan 重试计时器（spawn 后 jsonl 文件可能延迟创建） */
  private jsonlScanTimer: NodeJS.Timeout | null = null;
  /** Q4 续: 最新 usage（jsonl assistant.usage 解析）→ getStats 暴露给卡片 */
  private latestUsage: WorkUsage | null = null;
  /** 遥控修复: 最近一条 assistant text（idle 判停时作 result 推回品品；jsonl 路径只存不 emit） */
  private lastAssistantText: string | null = null;
  /** 遥控修复: idle 静默判停轮询计时器（tmux 同款"输出静默 N 秒=真停"） */
  private idleTimer: NodeJS.Timeout | null = null;
  /** 遥控修复 Bug2 v2: 上次已通知品品的 assistant 文本。判停去重的锚——
   *  "每条不同的最终 assistant 回复，静默后只通知品品一次"。
   *  ⚠️ 关键：用文本身份去重，**不**用"输出增长就重新武装"——Claude TUI 干完停在 prompt 仍周期性
   *  重绘（状态栏/输入框/计时器），重绘只长 totalBytes 不产生新 assistant 消息；若靠输出增长重置闸会
   *  每个 6s 静默窗反复 emit、把品品淹死（live 实测：21 条同批重复通知冲垮品品、卡死 10min）。
   *  文本身份去重天然只认"真有新回复"，重绘冲不动它；工作 CLI 自己多步推进产出新回复时又能再通知。 */
  private lastNotifiedText: string | null = null;
  /** 遥控修复: jsonl 未 attach 导致 idle 唤醒禁用的 WARN 已打过（防刷屏，只打一次） */
  private jsonlWarned = false;
  /** D3: spawn 时传 claude --session-id 的 UUID（照 channel-cli.ts）。jsonl 路径由此 + cwd 精确推出，
   *  替掉旧 snapshot-diff 定位（并发 spawn 会互相污染、都不匹配时 mtime fallback 选错文件）。 */
  private readonly sessionId: string = randomUUID();

  constructor(opts: WorkSessionOptions) {
    super();
    this.opts = opts;
    this.id = `ws_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  }

  get status(): WorkSessionStatus {
    return this._status;
  }

  start(): void {
    if (this._status !== 'stopped') return;
    this._status = 'starting';

    // 批2: 注入 work CLI 完工信号 Stop hook（work-stop-sink.cjs）。inline --settings 吃 hooks
    // 字段（U2 smoke 实测确认：Stop hook 真触发、stdin 拿得到 transcript_path）。
    // 正斜杠路径避反斜杠的 JSON 转义坑（node 在 Win 认正斜杠），空格靠引号，整体 JSON.stringify 转义引号。
    const stopHookCmd = `node "${this.opts.stopSinkPath.replace(/\\/g, '/')}" --ws-id=${this.id}`;
    const settingsJson = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: stopHookCmd }] }] },
      ...(this.opts.fast ? { fastMode: true } : {}),
    });

    const args = [
      '--model',
      this.opts.model,
      '--effort',
      this.opts.effort,
      // D3: 精确锁定本 session 的 jsonl（照 channel-cli.ts），替掉旧 snapshot-diff 定位
      '--session-id',
      this.sessionId,
      '--permission-mode',
      'bypassPermissions',
      '--settings',
      settingsJson,
      // 遥控护栏：work CLI 这端无人能点菜单/审批——禁 AskUserQuestion/计划审批/交互命令、每轮出【本轮总结】
      '--append-system-prompt',
      WORK_CLI_GUARD_PROMPT,
    ];
    for (const a of args) {
      if (a === '-p' || a === '--print') {
        throw new Error(`[work-session] 红线：不允许 -p/--print spawn 参数（${a}）`);
      }
    }

    const claudePath = resolveClaudePath();
    try {
      this.pty = new PtyManager({
        shell: claudePath,
        args,
        cwd: this.opts.workDir,
        // 批2: 显式注入 supervisor 端口，让 work CLI 的 Stop hook(work-stop-sink) 能 TCP 回连
        env: {
          ...(process.env as Record<string, string>),
          // 修 745f1a9 回归：work CLI 同 channel-cli 必须走对华网络，否则一发 API 即 403「Request not allowed」→ 提示 /login
          ...claudeApiNetEnv(),
          PINPIN_SUPERVISOR_PORT: String(this.opts.supervisorPort),
        },
        cols: 120,
        rows: 36,
      });
    } catch (e) {
      this._status = 'failed';
      this.emit('failed', e);
      process.stderr.write(
        `[work-session ${this.id}] spawn 失败: ${e instanceof Error ? e.message : e}\n`,
      );
      return;
    }

    this.startedAt = Date.now();
    this._status = 'running';
    process.stderr.write(
      `[work-session ${this.id}] spawned (pid=${this.pty.getStats().pid}, cwd=${this.opts.workDir}, model=${this.opts.model}, effort=${this.opts.effort})\n`,
    );

    // 不预 attach consumer——PtyManager 内部 onData 自动 push ring buffer，
    // 终端窗 attachTerminal 时再 PtyManager.attach(consumer) 拿 replay + 实时流（同 channel-cli）

    // 遥控修复 Bug2: PTY 异常退出 → 停 idle watch + 标 failed，避免 idleTimer 继续对死 PTY
    // 轮询把 msSinceLastData 一路增大误报"真停"。
    this.pty.onExit((info) => {
      if (this._status === 'stopped') return; // end() 已走过清理路径
      this._status = 'failed';
      if (this.idleTimer) {
        clearInterval(this.idleTimer);
        this.idleTimer = null;
      }
      process.stderr.write(
        `[work-session ${this.id}] PTY 退出 (code=${info.exitCode}, signal=${info.signal ?? 'none'})，停 idle watch\n`,
      );
    });

    // 启动期 auto-confirm：work_dir 若是 claude 从未访问的新目录，会弹"Do you trust this folder?"
    // 确认框（Enter to confirm）。若 goal 注入时屏幕卡在确认框，goal 文本会被框当成菜单选择键吃掉
    // ——这是 Bug3 根因（PTY probe 实测：3s 时 hasEnterConfirm=true，goal 未被执行）。
    // 修复：仿 channel-cli.ts 的 auto-confirm 机制，监听 PTY 输出，检测到 "Enter to confirm" 自动按 \r。
    // 停止锚点：检测到 TUI 主界面就绪特征（bypassPermissions 状态栏 = claude 已过所有启动确认），
    // 最长兜底 15s 后无论如何停 auto-confirm、再等 500ms 注入 goal。
    {
      let promptBuf = '';
      let lastAutoEnterAt = 0;
      let autoConfirmDone = false;
      let stopMonitor: (() => void) | null = null;

      const doInjectGoal = (): void => {
        if (this.goalSent || this._status !== 'running') return;
        this.submitToPty(this.opts.goal);
        this.goalSent = true;
        process.stderr.write(`[work-session ${this.id}] goal 已注入 (TUI 就绪后)\n`);
        // jsonl 和 idleWatch 在 goal 注入后启动（同原逻辑，延迟让工作 CLI 先跑起来）
        setTimeout(() => this.tryAttachJsonl(0), 500);
        setTimeout(() => this.startIdleWatch(), 1500);
      };

      const tryAutoConfirm = (): void => {
        if (autoConfirmDone) return;
        const clean = stripAnsi(promptBuf);
        const now = Date.now();
        if (/Enter\s*to\s*confirm/i.test(clean) && now - lastAutoEnterAt > 1500) {
          lastAutoEnterAt = now;
          this.pty?.write('\r');
          promptBuf = '';
          process.stderr.write(`[work-session ${this.id}] auto-confirmed startup prompt\n`);
        }
        // TUI 就绪锚点：出现 bypassPermissions 状态栏 = 所有启动确认已通过
        if (/bypassPermissions/i.test(clean) && !this.goalSent) {
          autoConfirmDone = true;
          clearInterval(autoConfirmInterval);
          stopMonitor?.();
          process.stderr.write(`[work-session ${this.id}] TUI ready (bypassPermissions detected)，注入 goal\n`);
          doInjectGoal();
        }
      };

      const autoConfirmInterval = setInterval(tryAutoConfirm, 500);

      // 兜底：15s 后 TUI 就绪特征仍未出现（极端情况），强制停 auto-confirm 并注入 goal
      setTimeout(() => {
        if (!autoConfirmDone) {
          autoConfirmDone = true;
          clearInterval(autoConfirmInterval);
          stopMonitor?.();
          process.stderr.write(`[work-session ${this.id}] auto-confirm 15s 兜底：强制注入 goal\n`);
          doInjectGoal();
        }
      }, 15000);

      // auto-confirm 走独立 monitor tap（非 attach）——终端窗 attachTerminal 时不会把它顶掉，
      // 修了"启动头几秒开终端窗→auto-confirm 失灵→goal 又发不进去"的竞争。done 时 stopMonitor() 退订。
      stopMonitor = this.pty.addMonitor((data) => {
        if (autoConfirmDone) return;
        promptBuf = (promptBuf + data).slice(-8192);
        tryAutoConfirm();
      });
    }

    // jsonl 和 idleWatch 现在由 doInjectGoal 内部在 goal 注入后延迟启动，不再在此固定 setTimeout。

    this.emit('started');
  }

  /** 提交文本给工作 CLI 的 TUI。走 PtyManager.submitLine 的"双段静默门"（文本与 \r 分两次发、
   *  各等 TUI 静默再写），让 \r 作为独立"按键"触发提交——一坨 text+'\r\n' 在 TUI 未就绪时 \r 被吞、
   *  文本留框不提交（真机实测根因）。频道终端输入框共用同一机制。 */
  private submitToPty(text: string): void {
    if (this._status !== 'running' || !this.pty) return;
    this.pty.submitLine(text);
  }

  /** 批2: work CLI 的 Stop hook(work-stop-sink) 经 supervisor 转来的「完工」信号——确定性主路径，替 idle 猜停。
   *  与 idle-watch 共用去重锚 lastNotifiedText：hook 先到就 set 了锚，idle 静默到点见"已通知"自动跳过——
   *  即 hook 工作时 idle 不会重复唤醒；hook 万一没触发（崩溃/被忽略）idle 仍兜底，品品不失声。
   *  同步 set lastAssistantText，让 idle-watch 的比较也认这条已处理。 */
  notifyStopFromHook(transcriptPath: string, lastText: string): void {
    if (this._status !== 'running') return;
    const text = lastText || '（工作 CLI 完成一轮）';
    if (text === this.lastNotifiedText) return; // 这条最终回复已通知过 → 不重复
    this.lastNotifiedText = text;
    this.lastAssistantText = text;
    const info: WorkSessionStopInfo = {
      result: text,
      is_error: false,
      stop_reason: 'hook',
      duration_ms: this.startedAt ? Date.now() - this.startedAt : undefined,
      total_cost_usd: this.latestUsage?.total_cost_usd,
    };
    this.emit('stopped', info);
    process.stderr.write(
      `[work-session ${this.id}] 完工信号(Stop hook)→唤醒品品（transcript=${transcriptPath}）\n`,
    );
  }

  /** 遥控修复 Bug2: 每 IDLE_TICK_MS 轮询 PTY 输出静默；连续静默 QUIESCE_MS 后，
   *  若有"尚未通知过的新最终回复"（lastAssistantText 与 lastNotifiedText 不同）→ 判"真停"emit 一次。
   *  去重锚是 assistant 文本身份（见 lastNotifiedText 注释），重绘冲不动、自动回合制、不会洪水。
   *  批2 起本路径降级为「兜底」——主路径是 notifyStopFromHook 的 Stop hook 完工信号（确定性、更快）；
   *  hook 工作时本轮询因共用 lastNotifiedText 去重而自然静默，仅 hook 失效时兜底唤醒。 */
  private startIdleWatch(): void {
    if (this.idleTimer || this._status !== 'running') return;
    this.idleTimer = setInterval(() => {
      if (this._status !== 'running' || !this.pty) return;
      const stats = this.pty.getStats();
      // 静默不够久 → 工作 CLI 还在动（thinking 时 spinner/token 计数持续刷 PTY，msSinceLastData 一直小），不判停
      if (stats.msSinceLastData < QUIESCE_MS) return;
      // 漏报诊断（code-review Optional #4）：已静默够久但 lastAssistantText 仍 null
      // = jsonl 没 attach 成功（文件未按推算路径出现）→ idle 唤醒永久禁用。打一次 WARN 便于定位。
      if (!this.lastAssistantText) {
        if (!this.jsonlWarned && stats.totalBytes > 0) {
          this.jsonlWarned = true;
          process.stderr.write(
            `[work-session ${this.id}] WARN: 工作 CLI 已静默但无 jsonl 解析结果（jsonl 未 attach）→ ` +
              `idle 自动唤醒已禁用，品品需Owner主动 peek 才知进展\n`,
          );
        }
        return;
      }
      // 这条最终回复已通知过 → 不重复（重绘只长 totalBytes 不换 text，天然被挡）
      if (this.lastAssistantText === this.lastNotifiedText) return;
      // 真停 + 有新回复没通知过 → 通知品品一次
      this.lastNotifiedText = this.lastAssistantText;
      const info: WorkSessionStopInfo = {
        result: this.lastAssistantText,
        is_error: false,
        stop_reason: 'idle',
        duration_ms: this.startedAt ? Date.now() - this.startedAt : undefined,
        total_cost_usd: this.latestUsage?.total_cost_usd,
      };
      this.emit('stopped', info);
      process.stderr.write(
        `[work-session ${this.id}] 判定真停（静默 ${Math.round(stats.msSinceLastData / 1000)}s）→ 唤醒品品确认\n`,
      );
    }, IDLE_TICK_MS);
  }

  /** D3: jsonl 路径由 sessionId + cwd 直接推出（不再 snapshot-diff 定位）。文件由 claude 启动后异步
   *  创建，故仍轮询等其出现再 attach watcher（避免 fs.watch ENOENT 噪声）；watcher 逻辑本身不变。 */
  private tryAttachJsonl(attempt: number): void {
    if (this._status !== 'running' || this.jsonlWatcher) return;
    // 兜底：workDir 非法时 jsonlPathForSession 会对 undefined 调 .replace() 崩（timer 回调里=主进程弹框）。
    // 正常路径已由 spawn tool（MCP 层）校验挡住 undefined work_dir，这里是精确栈的最后防线。
    if (typeof this.opts.workDir !== 'string' || !this.opts.workDir) {
      process.stderr.write(`[work-session ${this.id}] tryAttachJsonl: workDir 非法(${JSON.stringify(this.opts.workDir)})，跳过 jsonl 监听\n`);
      return;
    }
    const filePath = jsonlPathForSession(this.opts.workDir, this.sessionId);
    if (fs.existsSync(filePath)) {
      process.stderr.write(`[work-session ${this.id}] jsonl attach: ${filePath} (attempt ${attempt})\n`);
      this.jsonlWatcher = new JsonlWatcher(filePath);
      this.jsonlWatcher.on('event', (ev: JsonlEvent) => this.onJsonlEvent(ev));
      this.jsonlWatcher.start();
      return;
    }
    if (attempt >= 150) {
      // 150 次 × 2s = 5min 文件仍未出现 → 放弃（极少出现，可能 claude code 不写或路径权限问题）
      process.stderr.write(
        `[work-session ${this.id}] jsonl 5 分钟内未出现（${filePath}），放弃监听（work 仍在跑，但 usage/peek/stop signal 全废）\n`,
      );
      return;
    }
    this.jsonlScanTimer = setTimeout(() => this.tryAttachJsonl(attempt + 1), 2000);
  }

  private onJsonlEvent(ev: JsonlEvent): void {
    // 翻译 + 落 history（仅 peek tool 用；终端窗走 PtyManager raw 不依赖此路径）
    const line = translateJsonlEvent(ev);
    if (line) {
      this.translatedHistory.push(line);
      if (this.translatedHistory.length > TRANSLATED_HISTORY_LIMIT) {
        this.translatedHistory.splice(0, this.translatedHistory.length - TRANSLATED_HISTORY_LIMIT);
      }
    }
    // usage 提取（assistant 事件含 usage 字段，更新最新值）
    const usage = extractUsage(ev, this.opts.model);
    if (usage) {
      // 保留 prev cost 累加（assistant 行不含 cost，留给 result 行覆盖）
      this.latestUsage = {
        ...usage,
        total_cost_usd: this.latestUsage?.total_cost_usd ?? 0,
      };
    }
    // result 事件含本次 run 的 total_cost_usd —— 补上 assistant 行拿不到的 cost
    if ((ev as { type?: string }).type === 'result' && this.latestUsage) {
      const cost = Number((ev as { total_cost_usd?: unknown }).total_cost_usd ?? NaN);
      if (Number.isFinite(cost)) {
        this.latestUsage = { ...this.latestUsage, total_cost_usd: cost, updated_at: Date.now() };
      }
    }
    // 遥控修复 Bug2: jsonl 路径不再 per-turn emit 'stopped'（每轮 end_turn 都触发=过度通知 + 脆弱）。
    // 改为只缓存最近 assistant text；"真停"判定统一交给 startIdleWatch 的输出静默轮询（tmux 同款）。
    if (ev.type === 'assistant') {
      const text = this.extractAssistantText(ev);
      if (text) this.lastAssistantText = text;
    }
  }

  private extractAssistantText(ev: JsonlEvent): string | null {
    const content = (ev as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const p of content) {
      if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  sendMessage(text: string): boolean {
    if (this._status !== 'running' || !this.pty) return false;
    // 遥控修复 Bug1: 走 submitToPty（文本 + 延迟独立 \r），不再一次性 text+'\r\n'。
    // 注：不需手动重置判停闸——新指令会让工作 CLI 产出**新的**最终回复，
    // idle watch 用文本身份去重（lastNotifiedText），新回复天然能再唤醒品品一次。
    this.submitToPty(text);
    return true;
  }

  /** Q5 v2: 终端窗口 attach —— 直接走 PtyManager 的 ring buffer + 实时 PTY 字节流
   *  （跟 channel-cli.attachTerminal 同款。jsonl 翻译路径太慢，Owner P3 反馈"4 分钟还没字"）
   *  PtyManager.attach 自带 replay：用 PTY 原始 ANSI 流让 xterm 渲染 claude code 原生 UI */
  attachTerminal(consumer: (data: string) => void): void {
    this.pty?.attach(consumer);
  }

  /** Q5: 关窗 detach（PTY 继续跑、ring buffer 继续累积） */
  detachTerminal(): void {
    this.pty?.detach();
  }

  /** xterm FitAddon fit 之后，把实际终端尺寸同步回 PTY（修复 ANSI 排版错位） */
  resizeTerminal(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  /** Q7: 品品 peek tool 用 —— 返最近 N 条翻译行 */
  peekHistory(limit = 100): string[] {
    return this.translatedHistory.slice(-limit);
  }

  end(): void {
    if (this._status === 'stopped') return;
    if (this.jsonlScanTimer) {
      clearTimeout(this.jsonlScanTimer);
      this.jsonlScanTimer = null;
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.jsonlWatcher?.stop();
    this.jsonlWatcher = null;
    this.pty?.kill(); // 立即树杀：work CLI + 其子进程一起干掉，不留孤儿
    this.pty = null;
    this._status = 'stopped';
    this.emit('ended');
    process.stderr.write(`[work-session ${this.id}] ended\n`);
  }

  getStats(): {
    session_id: string;
    origin_chat_id: string;
    work_dir: string;
    status: WorkSessionStatus;
    pid?: number;
    uptime_ms: number;
    model: string;
    effort: string;
    fast: boolean;
    /** D3: claude --session-id 的 UUID（jsonl 文件名 = <claude_session_id>.jsonl） */
    claude_session_id: string;
    /** Q4 续: 上下文用量（jsonl assistant.usage 实时解析） */
    context_tokens?: number;
    context_window_size?: number | null;
    context_pct?: number | null;
  } {
    return {
      session_id: this.id,
      origin_chat_id: this.opts.originChatId,
      work_dir: this.opts.workDir,
      status: this._status,
      pid: this.pty?.getStats().pid,
      uptime_ms: this.startedAt ? Date.now() - this.startedAt : 0,
      model: this.opts.model,
      effort: this.opts.effort,
      fast: this.opts.fast ?? false,
      claude_session_id: this.sessionId,
      context_tokens: this.latestUsage?.context_tokens,
      context_window_size: this.latestUsage?.context_window_size,
      context_pct: this.latestUsage?.context_pct,
    };
  }
}
