/**
 * WorkSession —— 诉求 B "传话筒"的核心：品品 spawn 一个独立 claude code session
 * 在某 work_dir 干活，干完通过 stream-json 的 `result` 事件确定性回报。
 *
 * 关键设计（headless stream-json 管道驱动）：
 *   - 工人 = `claude -p --input-format stream-json --output-format stream-json` 子进程（标准管道，**非 PTY**）。
 *     以 `-p` 持久 stdin 跑多轮，进程常驻、上下文不丢。
 *   - cwd = work_dir；默认 `--strict-mcp-config`（不挂 MCP，最快最干净）。
 *   - 发指令：往 child.stdin 写一行 `{"type":"user","message":{"role":"user","content":text}}`。
 *     goal 在 start 末尾写一次；后续 sendMessage 续写。stdin 全程保持开着 = 同一进程多轮、上下文不丢。
 *   - 读进度：child.stdout 逐行 JSON（行缓冲拼半行）→ translate 落 eventLog（peek + 终端窗共用）+ usage 解析。
 *   - 自动司机：每轮 `type:"result"` = 工人结束一回合。回合制下 turn 何时收尾非确定，工人常半途停，故由 supervisor 当"司机"：
 *     result 字段含 `[[WORK_DONE]]`(完工)/`[[NEED_HUMAN]]`(卡住需Owner)/is_error → finalize 唤醒品品一次；
 *     否则 = 没干完 → 自动 writeTurn 催促继续、不唤醒品品，直到完工 / 封顶 MAX_DRIVE_ROUNDS 轮 / 连续2轮无进展(没调工具)兜底。
 *     品品视角：spawn 后只在"完工/需Owner/封顶/卡死"被唤醒一次（带 stop_reason）；中途可 peek 观察、send 介入(重置司机)。
 *   - 崩溃：child exit/error 且非主动 end → status='failed' + emit('stopped',is_error) 通知品品（不再黑屏僵尸）。
 *   - 终端窗：attachTerminal 喂"翻译后的事件文本行"（\r\n），launcher 侧透明（仍是字节 consumer）。
 *   - end() = tree-kill（taskkill /F /T /PID）连子孙干掉，决定性、不靠 EOF。
 *
 * **headless 说明**：工人走标准 `-p` stream-json 管道，进程常驻多轮、tree-kill 收尾。
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveClaudePath, claudeApiNetEnv } from './utils.js';

/** model name → context window size（用于上下文 % 计算）。未识别 model 返 null */
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

/** stream-json 事件（与旧 jsonl 事件同形：assistant/user/result/system…）。loose 形，函数内自行收窄。 */
interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

/** stream-json 事件 → 人类可读行（终端窗 + peek tool 共用）。无可读内容返 null 跳过 */
function translateEvent(ev: StreamEvent): string | null {
  const ts = new Date().toTimeString().slice(0, 8);
  if (ev.type === 'system' || ev.type === 'rate_limit_event') return null; // init/summary/thinking_tokens 等不显示
  if (ev.type === 'user') {
    const msg = (ev as { message?: { content?: unknown } }).message;
    const content = msg?.content;
    if (typeof content === 'string') return `[${ts}] 👤 ${content}`;
    if (Array.isArray(content)) {
      const lines: string[] = [];
      for (const part of content as Array<{ type: string; content?: unknown; is_error?: boolean }>) {
        if (part.type === 'tool_result') {
          const txt = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
          lines.push(`[${ts}] ${part.is_error ? '❌' : '✅'} 结果: ${txt}`);
        }
      }
      return lines.length > 0 ? lines.join('\n') : null;
    }
    return null;
  }
  if (ev.type === 'assistant') {
    const msg = (ev as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } }).message;
    const content = msg?.content;
    if (!Array.isArray(content)) return null;
    const lines: string[] = [];
    for (const part of content) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        lines.push(`[${ts}] 💬 ${part.text}`);
      } else if (part.type === 'tool_use') {
        lines.push(`[${ts}] 🔧 ${part.name ?? '?'}: ${JSON.stringify(part.input ?? {})}`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }
  if (ev.type === 'result') {
    const r = typeof ev['result'] === 'string' ? (ev['result'] as string) : '';
    return `[${ts}] ${ev['is_error'] ? '⚠️' : '✅'} 本轮进展: ${r}`;
  }
  return null;
}

/** 从 assistant 事件提取 usage（message.usage 含全 input/output/cache 拆分） */
function extractUsage(ev: StreamEvent, model: string): WorkUsage | null {
  if (ev.type !== 'assistant') return null;
  const u = (ev as { message?: { usage?: Record<string, unknown> } }).message?.usage;
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.input_tokens ?? 0);
  const cacheCreate = Number(u.cache_creation_input_tokens ?? 0);
  const cacheRead = Number(u.cache_read_input_tokens ?? 0);
  const contextTokens = input + cacheCreate + cacheRead;
  const cw = contextWindowSize(model);
  return {
    context_tokens: contextTokens,
    context_window_size: cw,
    context_pct: cw ? Math.round((contextTokens / cw) * 1000) / 10 : null,
    total_cost_usd: 0, // assistant 行不含 cost；result 行才有
    updated_at: Date.now(),
  };
}

const EVENT_LOG_LIMIT = 500;

/** 遥控护栏 system prompt（--append-system-prompt 注入）：work CLI 被品品远程驱动、这端无人能审批。
 *  防"模型自己会触发的交互卡点"(AskUserQuestion/计划审批/等 stdin 的交互命令) + 完工信号协议([[WORK_DONE]]/[[NEED_HUMAN]])。 */
const WORK_CLI_GUARD_PROMPT =
  '你是被品品（飞书 bot）远程驱动的后台 work CLI：你这一端没有任何人类能实时点选菜单或交互审批，' +
  '指令由品品转达、你的输出由品品转给Owner。务必遵守：' +
  '①绝不调用 AskUserQuestion，也不要进入需要人确认/选择的交互（如计划模式 ExitPlanMode 等待审批）——' +
  '遇到抉择分叉用最合理默认自主决策并继续推进，绝不停下等人选择。' +
  '②不要运行会等待 stdin 输入的交互式命令（改用非交互参数/管道，或换非交互方式）。' +
  '③确需Owner拍板的事，把问题清楚写进你的文字回复（品品会转达），然后继续完成其他能做的部分，不要停在等待输入上。' +
  '④每轮结束用 1-2 句话简述本轮进展（供品品观察）。【完工信号】只有当整个任务目标全部真正完成时，' +
  '才在回复最后单独一行输出 [[WORK_DONE]]；任务没全做完时绝不输出它。' +
  '若确实卡住、必须Owner补充信息或权限才能继续，在回复最后单独一行输出 [[NEED_HUMAN]] 并写清卡在哪、需要什么。' +
  '⑤【禁幻觉铁律】凡需改文件/跑命令/执行的任务，必须真实调用工具(Write/Edit/Bash 等)把它做完；' +
  '严禁只用文字声称"已建好/已完成/已删除/已修改"而不实际调用工具——没调用工具=没做=欺骗，绝不允许。';

/** 自动司机：工人一轮没输出完工标记 = 没干完，supervisor 自动推它继续，最多推这么多轮（封顶兜底）。 */
const MAX_DRIVE_ROUNDS = 15;
/** 自动司机催促语（极短，避免反复注入撑大工人上下文）。 */
const DRIVE_NUDGE =
  '你还没输出完工标记。若任务还没全部做完，请继续把剩余部分真正做完（该调用工具就真调用，不要只口头说）。' +
  '若你其实已全部完成，就在回复最后单独一行只输出 [[WORK_DONE]]。' +
  '若卡住、必须Owner补充信息或权限才能继续，最后单独一行输出 [[NEED_HUMAN]] 并写清卡在哪。';

/** 树杀子进程及其全部子孙（claude 顶层 → Bash/子 agent 等）。Windows 走 taskkill /F /T /PID 精确锁本 pid 树。 */
function treeKill(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000 });
    } catch {
      /* 进程/子进程可能已退出——忽略 */
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

export class WorkSession extends EventEmitter {
  readonly opts: WorkSessionOptions;
  readonly id: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private _status: WorkSessionStatus = 'stopped';
  private startedAt: number | null = null;
  /** stdout 行缓冲：claude stream-json 一行一个事件，但管道 data 块可能拆/粘行，留半行到下次 */
  private stdoutBuf = '';
  /** 翻译后的事件行 ring buffer（peek tool + 终端窗共用） */
  private eventLog: string[] = [];
  /** 终端窗单 consumer（同旧"终端单消费者"语义） */
  private terminalConsumer: ((data: string) => void) | null = null;
  /** 最新 usage（assistant.usage 解析）→ getStats 暴露给卡片 */
  private latestUsage: WorkUsage | null = null;
  /** claude 自报的 session_id（init 事件给）——仅作 stats 展示 */
  private claudeSessionId: string | null = null;
  /** child 已结束标记——防 error+exit 双触发导致向品品双推崩溃信号 */
  private childGone = false;
  /** 自动司机：已自动推进的轮数（达 MAX_DRIVE_ROUNDS 封顶回报品品）。品品手动 send 时清零开新周期。 */
  private driveRounds = 0;
  /** 自动司机：连续"无进展"轮数（一轮没调任何工具=无进展）；连续 2 轮判定卡死、提前回报。 */
  private noProgressStreak = 0;
  /** 本轮工人调用工具的次数（assistant.tool_use 计数）——result 时据此判断本轮有无进展，判完清零。 */
  private toolUsesThisTurn = 0;

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

    // fast 模式：合 fastMode:true 进 --settings（headless 下无 Stop hook，settings 只剩 fastMode）
    const settingsJson = JSON.stringify({ ...(this.opts.fast ? { fastMode: true } : {}) });

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      this.opts.model,
      '--effort',
      this.opts.effort,
      '--permission-mode',
      'bypassPermissions',
      '--settings',
      settingsJson,
      // 遥控护栏：禁 AskUserQuestion/计划审批/交互命令、完工信号 [[WORK_DONE]]/[[NEED_HUMAN]]
      '--append-system-prompt',
      WORK_CLI_GUARD_PROMPT,
      // 工具级硬禁 ask（后台无人应答会卡）
      '--disallowedTools',
      'AskUserQuestion',
      // 工人默认不挂 MCP（最快最干净，需要时再单配）
      '--strict-mcp-config',
    ];

    const claudePath = resolveClaudePath();
    try {
      this.child = spawn(claudePath, args, {
        cwd: this.opts.workDir,
        env: {
          ...(process.env as Record<string, string>),
          // 同 channel-cli 走对华网络，否则一发 API 即 403
          ...claudeApiNetEnv(),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
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
      `[work-session ${this.id}] spawned (pid=${this.child.pid}, cwd=${this.opts.workDir}, model=${this.opts.model}, effort=${this.opts.effort})\n`,
    );

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      const s = chunk.toString().trim();
      if (s) process.stderr.write(`[work-session ${this.id}] child-stderr: ${s.slice(0, 500)}\n`);
    });
    this.child.on('error', (err) => this.onChildGone(null, err));
    this.child.on('exit', (code, signal) => this.onChildGone(code, null, signal));

    // 注入 goal（首轮）
    this.writeTurn(this.opts.goal);
    this.emit('started');
  }

  /** 往工人 stdin 写一轮 user 消息（stream-json 帧）。stdin 全程保持开着=同进程多轮。 */
  private writeTurn(text: string): void {
    const child = this.child;
    if (!child || !child.stdin.writable) return;
    const frame = JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
    try {
      child.stdin.write(frame);
    } catch (e) {
      process.stderr.write(
        `[work-session ${this.id}] stdin write 失败: ${e instanceof Error ? e.message : e}\n`,
      );
    }
  }

  /** stdout 块 → 行缓冲拆行 → 逐条 JSON.parse → onEvent */
  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    const lines = this.stdoutBuf.split('\n');
    this.stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;
      let ev: StreamEvent;
      try {
        ev = JSON.parse(trimmed) as StreamEvent;
      } catch {
        continue;
      }
      this.onEvent(ev);
    }
  }

  private onEvent(ev: StreamEvent): void {
    // init 事件记 claude session_id（仅 stats 展示）
    if (ev.type === 'system' && (ev as { subtype?: string }).subtype === 'init') {
      const sid = (ev as { session_id?: string }).session_id;
      if (typeof sid === 'string') this.claudeSessionId = sid;
    }

    // 本轮工具调用计数（assistant.tool_use）——result 时判"本轮有无进展"，判完清零
    if (ev.type === 'assistant') {
      const content = (ev as { message?: { content?: Array<{ type: string }> } }).message?.content;
      if (Array.isArray(content)) {
        for (const part of content) if (part.type === 'tool_use') this.toolUsesThisTurn++;
      }
    }

    // 翻译落 eventLog（peek + 终端窗共用）
    const line = translateEvent(ev);
    if (line) {
      this.eventLog.push(line);
      if (this.eventLog.length > EVENT_LOG_LIMIT) {
        this.eventLog.splice(0, this.eventLog.length - EVENT_LOG_LIMIT);
      }
      this.terminalConsumer?.(line.replace(/\n/g, '\r\n') + '\r\n');
    }

    // usage（assistant 事件含 usage）
    const usage = extractUsage(ev, this.opts.model);
    if (usage) {
      this.latestUsage = { ...usage, total_cost_usd: this.latestUsage?.total_cost_usd ?? 0 };
    }

    // result 事件 = 工人结束一回合。自动司机据"完工标记/进展"决定：自动推下一轮 or 回报品品一次。
    if (ev.type === 'result') {
      if (this._status === 'stopped') return; // 已 end()/已 finalize → 吞掉在途 result，不重复处理
      const result = typeof ev['result'] === 'string' ? (ev['result'] as string) : '（工作 CLI 完成一轮，无文字输出）';
      const isError = ev['is_error'] === true;
      const cost = Number(ev['total_cost_usd'] ?? NaN);
      if (Number.isFinite(cost)) {
        this.latestUsage = {
          ...(this.latestUsage ?? {
            context_tokens: 0,
            context_window_size: contextWindowSize(this.opts.model),
            context_pct: null,
            total_cost_usd: 0,
            updated_at: Date.now(),
          }),
          total_cost_usd: cost,
          updated_at: Date.now(),
        };
      }
      const info: WorkSessionStopInfo = {
        result,
        is_error: isError,
        stop_reason: 'done',
        duration_ms: this.startedAt ? Date.now() - this.startedAt : undefined,
        total_cost_usd: Number.isFinite(cost) ? cost : this.latestUsage?.total_cost_usd,
      };

      // 完工标记只在 result 字段识别（不扫普通对话，防误判）
      const done = /\[\[WORK_DONE\]\]/.test(result);
      const needHuman = /\[\[NEED_HUMAN\]\]/.test(result);
      const madeProgress = this.toolUsesThisTurn > 0;
      this.toolUsesThisTurn = 0;

      // 终止态 → 回报品品一次
      if (isError || done || needHuman) {
        this.finalize(isError ? 'error' : done ? 'done' : 'need_human', info);
        return;
      }
      // 半途停：无进展兜底（连续 2 轮没调任何工具 = 卡死）
      this.noProgressStreak = madeProgress ? 0 : this.noProgressStreak + 1;
      if (this.noProgressStreak >= 2) {
        this.finalize('stuck', info);
        return;
      }
      // 轮数封顶
      if (this.driveRounds >= MAX_DRIVE_ROUNDS) {
        this.finalize('capped', info);
        return;
      }
      // 自动推它继续（不唤醒品品）
      this.driveRounds++;
      process.stderr.write(`[work-session ${this.id}] 自动司机推进 #${this.driveRounds}（本轮${madeProgress ? '有' : '无'}进展）\n`);
      this.writeTurn(DRIVE_NUDGE);
    }
  }

  /** 自动司机终结：回报品品一次。done/need_human 保活进程（留给品品 send/end）；capped/stuck 树杀防空转。 */
  private finalize(reason: 'done' | 'need_human' | 'capped' | 'stuck' | 'error', info: WorkSessionStopInfo): void {
    info.stop_reason = reason;
    if (reason === 'done' || reason === 'need_human') {
      // 剥掉标记行，给品品干净文本
      info.result = info.result.replace(/\[\[(WORK_DONE|NEED_HUMAN)\]\]/g, '').trim();
    } else if (reason === 'capped' || reason === 'stuck') {
      const why = reason === 'capped' ? `自动推进 ${this.driveRounds} 轮后仍未完工` : '连续多轮无进展，疑似卡死';
      info.result = `⚠️（${why}，需Owner介入）\n${info.result}`;
      info.is_error = true;
      // 先置已结束标记再树杀，避免 onChildGone 二次 emit('stopped')
      this.childGone = true;
      this._status = 'stopped';
      const child = this.child;
      this.child = null;
      if (child) treeKill(child.pid);
    }
    process.stderr.write(`[work-session ${this.id}] finalize(${reason})→唤醒品品（driveRounds=${this.driveRounds}）\n`);
    this.emit('stopped', info);
  }

  /** child 退出/出错（非主动 end）→ 标 failed + 通知品品，避免黑屏僵尸 */
  private onChildGone(code: number | null, err: Error | null, signal?: NodeJS.Signals | null): void {
    if (this._status === 'stopped' || this.childGone) return; // 主动 end() 已清理 / 已处理过（防 error+exit 双触发）
    this.childGone = true;
    this._status = 'failed';
    const reason = err
      ? `spawn/运行错误: ${err.message}`
      : `进程退出 code=${code} signal=${signal ?? 'none'}`;
    process.stderr.write(`[work-session ${this.id}] 异常结束（${reason}）→ 通知品品\n`);
    this.emit('stopped', {
      result: `工人进程异常结束（${reason}）`,
      is_error: true,
      stop_reason: 'crashed',
      duration_ms: this.startedAt ? Date.now() - this.startedAt : undefined,
    } as WorkSessionStopInfo);
  }

  sendMessage(text: string): boolean {
    if (this._status !== 'running' || !this.child) return false;
    // 品品手动介入 = 新一轮驱动周期，清零自动司机计数
    this.driveRounds = 0;
    this.noProgressStreak = 0;
    this.writeTurn(text);
    return true;
  }

  /** 终端窗 attach —— 喂"翻译后的事件文本行"（\r\n），不喂原始 ANSI。先回放 eventLog 再实时推。 */
  attachTerminal(consumer: (data: string) => void): void {
    this.terminalConsumer = consumer;
    if (this.eventLog.length) {
      consumer(this.eventLog.map((l) => l.replace(/\n/g, '\r\n')).join('\r\n') + '\r\n');
    }
  }

  detachTerminal(): void {
    this.terminalConsumer = null;
  }

  /** headless 无 PTY，无需 resize —— 保留空实现，兼容 launcher 调用 */
  resizeTerminal(_cols: number, _rows: number): void {
    /* no-op */
  }

  /** 品品 peek tool 用 —— 返最近 N 条翻译行 */
  peekHistory(limit = 100): string[] {
    return this.eventLog.slice(-limit);
  }

  end(): void {
    if (this._status === 'stopped') return;
    this._status = 'stopped';
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      treeKill(child.pid); // 立即树杀：work CLI + 子孙一起干掉，不留孤儿、不靠 EOF
    }
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
    claude_session_id: string;
    context_tokens?: number;
    context_window_size?: number | null;
    context_pct?: number | null;
  } {
    return {
      session_id: this.id,
      origin_chat_id: this.opts.originChatId,
      work_dir: this.opts.workDir,
      status: this._status,
      pid: this.child?.pid,
      uptime_ms: this.startedAt ? Date.now() - this.startedAt : 0,
      model: this.opts.model,
      effort: this.opts.effort,
      fast: this.opts.fast ?? false,
      claude_session_id: this.claudeSessionId ?? this.id,
      context_tokens: this.latestUsage?.context_tokens,
      context_window_size: this.latestUsage?.context_window_size,
      context_pct: this.latestUsage?.context_pct,
    };
  }
}
