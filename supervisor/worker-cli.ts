/**
 * WorkerCli —— 常驻工人（医生 / 工程师 / 顺子等）托管的 claude CLI 进程实例。
 *
 * 与 ChannelCli 同源思路（PtyManager 树杀 / ring buffer / attach）但更轻量：无 MCP 飞书频道、
 * 无 statusLine/sysprompt 注入，只是"品品 wake_worker → PTY 拉起交互式 claude --resume 该工人会话"。
 * 生命周期由 supervisor/index.ts 持有的 Map 管理（wakeWorker / stopWorker / 60s 空闲巡检）。
 *
 * **交互式 CLI 约束**：本类绝不允许在 spawn args 里出现 `-p` / `--print`，必须**交互式 claude**。
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PtyManager } from './pty-manager.js';
import { resolveClaudePath, stripAnsi, claudeApiNetEnv } from './utils.js';

const execFileAsync = promisify(execFile);

/** 启动期自动回车确认的上限时长（无就绪信号可判时的唯一停止条件）。 */
const AUTO_CONFIRM_TIMEOUT_MS = 20_000;

export interface WorkerConfig {
  /** --name 传给 claude CLI 的值，同时是 ListAgents / wake_worker(name) 里认的名字。 */
  name: string;
  /** CLI 会话 ID；空字符串 = 首次拉起时生成新 UUID 并写回 workers.json（--session-id）。
   *  非空 = 续接已有会话（--resume）。 */
  sessionId: string;
  cwd: string;
  model: string;
  effort: string;
  /** 新会话已生成 ID 但还没写出 transcript（CLI 首条消息后才落盘）→ 下次仍用 --session-id，不当"记录丢失" */
  pendingNew?: boolean;
}

interface WorkersFile {
  workers: WorkerConfig[];
}

export interface WorkerStatus {
  name: string;
  status: 'awake' | 'asleep' | 'broken';
  pid?: number;
  last_output_at?: number;
  error?: string;
}

/** 现有会话对应表（2026-09-17 核对，详见任务 MD 步骤 8）。文件不存在时用它写出默认 workers.json。 */
const DEFAULT_WORKERS: WorkerConfig[] = [
  {
    name: '品品Client-私人医生',
    sessionId: 'ef9d59c2-8e32-49dd-82be-99ec13462f90',
    cwd: '/path/to\\Claude\\workspace\\CODE-BASE\\品品-飞书MCP-to-code',
    model: 'claude-fable-5-1 [1m]',
    effort: 'high',
  },
  {
    name: 'ClientAI短剧工作站-维护工程师',
    sessionId: '03af52ce-ccf9-4bed-9469-f09b4f6b38c7',
    cwd: '/path/to\\Claude\\workspace\\CODE-BASE\\ClientAI短剧工作站',
    model: 'claude-fable-5-1 [1m]',
    effort: 'high',
  },
  {
    name: '顺子',
    sessionId: '',
    cwd: '/path/to\\Claude\\workspace\\CODE-BASE\\通用',
    model: 'claude-opus-5 [1m]',
    effort: 'high',
  },
];

export function workersConfigPath(dataDir: string): string {
  return path.join(dataDir, 'workers.json');
}

/** 启动时调一次：文件不存在则用默认三条写出并返回；解析失败同样回退默认（不写坏文件）。 */
export function loadWorkersConfig(dataDir: string): WorkerConfig[] {
  const file = workersConfigPath(dataDir);
  if (!fs.existsSync(file)) {
    const defaults = DEFAULT_WORKERS.map((w) => ({ ...w }));
    saveWorkersConfig(dataDir, defaults);
    return defaults;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkersFile;
    if (raw && Array.isArray(raw.workers)) return raw.workers;
    throw new Error('workers.json root 缺少 workers 数组');
  } catch (e) {
    process.stderr.write(
      `[worker-cli] workers.json 解析失败，回退默认三条（不覆盖原文件）: ${e instanceof Error ? e.message : e}\n`,
    );
    return DEFAULT_WORKERS.map((w) => ({ ...w }));
  }
}

/** 原子写（tmp + rename），跟 channel-config-store 同风格。 */
export function saveWorkersConfig(dataDir: string, workers: WorkerConfig[]): void {
  const file = workersConfigPath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ workers } satisfies WorkersFile, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export class WorkerCli extends EventEmitter {
  /** 注意：sessionId 字段会在首次成功拉起（原为空）时被就地改写——调用方（supervisor）
   *  持有同一份数组引用，拉起成功后需自行 saveWorkersConfig 落盘。 */
  readonly cfg: WorkerConfig;
  private pty: PtyManager | null = null;
  private _status: 'awake' | 'asleep' | 'broken' = 'asleep';
  private _error: string | undefined;
  private userStopped = false;
  private startedAt = 0;
  private autoConfirmInterval: NodeJS.Timeout | null = null;
  private autoConfirmStopMonitor: (() => void) | null = null;

  constructor(cfg: WorkerConfig) {
    super();
    this.cfg = cfg;
  }

  get name(): string {
    return this.cfg.name;
  }

  get status(): 'awake' | 'asleep' | 'broken' {
    return this._status;
  }

  private transcriptPathFor(sessionId: string): string {
    return path.join(
      os.homedir(),
      '.claude',
      'projects',
      this.cfg.cwd.replace(/[^a-zA-Z0-9]/g, '-'),
      `${sessionId}.jsonl`,
    );
  }

  private transcriptExists(sessionId: string): boolean {
    try {
      return fs.existsSync(this.transcriptPathFor(sessionId));
    } catch {
      return false;
    }
  }

  private transcriptMtimeMs(sessionId: string): number | null {
    try {
      return fs.statSync(this.transcriptPathFor(sessionId)).mtimeMs;
    } catch {
      return null;
    }
  }

  /** 防双开：查本机 claude.exe 进程命令行是否已含该 sessionId（Desktop 窗口 / 其它进程占用）。
   *  PowerShell 查询本身失败（非"查到冲突"）时放行——避免因偶发 PS 报错把工人锁死。 */
  private async findClaudeProcessesWithSession(sessionId: string): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { timeout: 5000 },
      );
      const trimmed = stdout.trim();
      if (!trimmed) return [];
      const parsed: unknown = JSON.parse(trimmed);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list
        .filter(
          (p): p is { ProcessId: number; CommandLine: string } =>
            !!p && typeof (p as { CommandLine?: unknown }).CommandLine === 'string' &&
            (p as { CommandLine: string }).CommandLine.includes(sessionId),
        )
        .map((p) => Number(p.ProcessId))
        .filter((n) => Number.isFinite(n));
    } catch (e) {
      process.stderr.write(
        `[worker-cli ${this.cfg.name}] 双开检查失败（放行）: ${e instanceof Error ? e.message : e}\n`,
      );
      return [];
    }
  }

  /** 拉起该工人 CLI。sessionId 为空 → 新会话（--session-id，生成后写进 this.cfg.sessionId，
   *  调用方需自行落盘）；非空 → 续接（--resume），续接前查 transcript 是否存在 + 防双开。 */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this._status === 'awake' && this.pty) return { ok: true };
    this._error = undefined;

    if (this.cfg.pendingNew && this.cfg.sessionId && this.transcriptExists(this.cfg.sessionId)) {
      delete this.cfg.pendingNew;
    }
    const hadSessionId = !!this.cfg.sessionId && !this.cfg.pendingNew;
    let sessionId = this.cfg.sessionId;
    if (hadSessionId) {
      if (!this.transcriptExists(sessionId)) {
        this._status = 'broken';
        this._error = '会话记录不存在';
        return { ok: false, error: this._error };
      }
      const busyPids = await this.findClaudeProcessesWithSession(sessionId);
      if (busyPids.length > 0) {
        this._status = 'broken';
        this._error = '该会话已在别处打开（可能是 Desktop 窗口），请先关掉';
        return { ok: false, error: this._error };
      }
    } else if (!sessionId) {
      sessionId = randomUUID();
      this.cfg.sessionId = sessionId;
      this.cfg.pendingNew = true;
    }

    if (!fs.existsSync(this.cfg.cwd)) {
      this._status = 'broken';
      this._error = `cwd 不存在：${this.cfg.cwd}`;
      return { ok: false, error: this._error };
    }

    // 红线检查：args 不许含 -p / --print（交互式 CLI 约束，同 channel-cli）
    const args = [
      ...(hadSessionId ? ['--resume', sessionId] : ['--session-id', sessionId]),
      '--name',
      this.cfg.name,
      '--model',
      this.cfg.model,
      '--effort',
      this.cfg.effort,
      '--permission-mode',
      'bypassPermissions',
    ];
    for (const a of args) {
      if (a === '-p' || a === '--print') {
        throw new Error(`[worker-cli] 红线：不允许 -p/--print spawn 参数（${a}）`);
      }
    }

    // 不带 channel / sysprompt / statusLine / --tools / PINPIN_* / FEISHU_* / LARKSUITE_* env——
    // 工人是普通交互式 claude 会话，不是品品频道。
    const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const k of Object.keys(childEnv)) {
      if (k.startsWith('PINPIN_') || k.startsWith('FEISHU_') || k.startsWith('LARKSUITE_')) delete childEnv[k];
    }
    Object.assign(childEnv, claudeApiNetEnv());

    const claudePath = resolveClaudePath();
    try {
      this.pty = new PtyManager({
        shell: claudePath,
        args,
        cwd: this.cfg.cwd,
        env: childEnv,
        cols: 120,
        rows: 36,
      });
    } catch (e) {
      this._status = 'broken';
      this._error = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[worker-cli ${this.cfg.name}] spawn 失败: ${this._error}\n`);
      return { ok: false, error: this._error };
    }

    this._status = 'awake';
    this.userStopped = false;
    this.startedAt = Date.now();
    process.stderr.write(
      `[worker-cli ${this.cfg.name}] spawned (pid=${this.pty.getStats().pid}, exec=${claudePath}, model=${this.cfg.model}, effort=${this.cfg.effort})\n`,
    );

    const ownPty = this.pty;
    this.pty.onExit((info) => {
      if (this.pty !== ownPty) return; // 旧进程延迟退出回调（已被新 start 替换）
      this.stopAutoConfirm();
      this.pty = null;
      if (this.userStopped) {
        this._status = 'asleep';
      } else {
        this._status = 'broken';
        this._error = '进程意外退出';
        process.stderr.write(
          `[worker-cli ${this.cfg.name}] crashed (exitCode=${info.exitCode}, signal=${info.signal ?? 'none'})\n`,
        );
        this.emit('crashed', info);
      }
    });

    this.startAutoConfirm();
    this.emit('started');
    return { ok: true };
  }

  /** 启动期"Enter to confirm"自动回车（dev channel / trust 提示等）。无可靠"就绪信号"可判（工人无 MCP
   *  hello 事件），停止条件退化为 20s 超时——同 channel-cli 机制，仅停止条件不同。 */
  private startAutoConfirm(): void {
    let promptBuffer = '';
    let lastAutoEnterAt = 0;
    const tryAutoConfirm = (): void => {
      const clean = stripAnsi(promptBuffer);
      const now = Date.now();
      if (/Enter\s*to\s*confirm/.test(clean) && now - lastAutoEnterAt > 1500) {
        lastAutoEnterAt = now;
        this.pty?.write('\r');
        process.stderr.write(`[worker-cli ${this.cfg.name}] auto-confirmed startup prompt\n`);
        promptBuffer = '';
      }
    };
    this.autoConfirmStopMonitor = this.pty?.addMonitor((data) => {
      promptBuffer = (promptBuffer + data).slice(-8192);
      tryAutoConfirm();
    }) ?? null;
    this.autoConfirmInterval = setInterval(tryAutoConfirm, 1000);
    setTimeout(() => this.stopAutoConfirm(), AUTO_CONFIRM_TIMEOUT_MS);
  }

  private stopAutoConfirm(): void {
    if (this.autoConfirmInterval) {
      clearInterval(this.autoConfirmInterval);
      this.autoConfirmInterval = null;
    }
    this.autoConfirmStopMonitor?.();
    this.autoConfirmStopMonitor = null;
  }

  stop(): void {
    if (!this.pty) {
      if (this._status === 'awake') this._status = 'asleep';
      return;
    }
    this.userStopped = true;
    this.stopAutoConfirm();
    this.pty.kill(); // 立即树杀，同 channel-cli
    this.pty = null;
    this._status = 'asleep';
    process.stderr.write(`[worker-cli ${this.cfg.name}] stopped\n`);
    this.emit('stopped');
  }

  /** 签名与 ChannelCli.restart 一致；工人恒续接（sessionId 落盘后不再清零），opts.resume 忽略不影响行为。 */
  restart(opts?: { resume?: boolean }): void {
    void opts;
    this.stop();
    setTimeout(() => {
      void this.start();
    }, 500);
  }

  sendInput(text: string): void {
    if (!this.pty || this._status !== 'awake') return;
    this.pty.submitLine(text);
  }

  resizeTerminal(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  attachTerminal(consumer: (data: string) => void): void {
    this.pty?.attach(consumer);
  }

  detachTerminal(): void {
    this.pty?.detach();
  }

  /** wakeWorker 判定"就绪"用：启动已满 minUptimeMs、PTY 连续静默达 ms 且进程仍活着。 */
  isQuietFor(ms: number, minUptimeMs = 0): boolean {
    const s = this.pty?.getStats();
    return !!s && s.alive && s.msSinceLastData >= ms && Date.now() - this.startedAt >= minUptimeMs;
  }

  /** 空闲巡检用：awake 且 PTY 静默 + transcript mtime 都早于 thresholdMs 才判定空闲。 */
  isIdleFor(thresholdMs: number): boolean {
    if (this._status !== 'awake' || !this.pty) return false;
    const stats = this.pty.getStats();
    if (stats.msSinceLastData < thresholdMs) return false;
    const mtime = this.transcriptMtimeMs(this.cfg.sessionId);
    if (mtime === null) return true; // 无 transcript 信息可查，信 PTY 静默
    return Date.now() - mtime >= thresholdMs;
  }

  /** 终端窗口顶栏用（与 ChannelCli.getStats 同名字段）：awake→running、asleep→stopped、broken→failed */
  getMeta(): { chat_name: string; model: string; effort: string; status: 'running' | 'stopped' | 'failed' } {
    const status = this._status === 'awake' ? 'running' : this._status === 'broken' ? 'failed' : 'stopped';
    return { chat_name: this.cfg.name, model: this.cfg.model, effort: this.cfg.effort, status };
  }

  getStats(): WorkerStatus {
    const ptyStats = this.pty?.getStats();
    return {
      name: this.cfg.name,
      status: this._status,
      pid: ptyStats?.pid,
      last_output_at: ptyStats ? Date.now() - ptyStats.msSinceLastData : undefined,
      error: this._error,
    };
  }
}
