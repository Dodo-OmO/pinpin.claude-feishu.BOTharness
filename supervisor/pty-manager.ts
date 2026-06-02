/**
 * PTY 管理器 —— 包装 node-pty + ring buffer + attach/detach 抽象
 *
 * 用于诉求 A "启动器终端窗口可见/隐藏切换" 和 诉求 B "传话筒遥控开关终端窗口"。
 * 核心机制：
 *   - PTY 进程的 stdout 由 manager 持续吸收（无论有无消费者）
 *   - ring buffer 累积输出（detach 期间不丢）
 *   - attach(consumer) 时回放 ring buffer 全部 + 后续实时推
 *   - detach() 暂停推送，但 PTY 继续跑、ring buffer 继续累积
 *
 * 关键点：消化 devil-advocate Required #6 修正——必须有 ring buffer，否则 OS pipe
 * buffer（Windows ConPTY 4-64KB）满了会阻塞 PTY 进程，这正是 issue #56268 的另一触发路径。
 */

import * as pty from 'node-pty';

// === 向 Claude TUI 提交一行的"双段静默门"参数（频道终端 + work 终端共用，真机验证过）===
/** 写完文本后多久首次检查能否发 \r。Claude Ink TUI 把"文本+回车"一坨到达当输入内容不提交，
 *  必须文本与 \r 分两次写、中间留间隔，让 \r 作为独立"按键"触发提交。 */
const SUBMIT_DELAY_MS = 120;
/** 固定延迟在重负载真机太早（TUI 还在启动/渲染时 \r 被吞）→ 改等 PTY 连续静默达此值
 *  (=渲染/启动 settled、输入框 ready) 再发 \r。需 > 实测失败时的 105ms。 */
const SUBMIT_QUIET_MS = 350;
/** 未达静默时的轮询间隔。 */
const SUBMIT_POLL_MS = 100;
/** 兜底上限：等再久也得发 \r（防 TUI 永不静默时永不提交）。 */
const SUBMIT_MAX_WAIT_MS = 5000;

export interface PtyExitInfo {
  exitCode: number;
  signal?: number;
}

// === Ring Buffer 实现 ===
class RingBuffer {
  private chunks: string[] = [];
  private totalSize = 0;

  constructor(private maxSize: number) {}

  push(data: string): void {
    this.chunks.push(data);
    this.totalSize += data.length;
    // 超 limit 时丢最旧的，但保留至少 1 块
    while (this.totalSize > this.maxSize && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped) this.totalSize -= dropped.length;
    }
  }

  getAll(): string {
    return this.chunks.join('');
  }

  clear(): void {
    this.chunks = [];
    this.totalSize = 0;
  }

  size(): number {
    return this.totalSize;
  }
}

// === PTY Manager ===
export interface PtyManagerOptions {
  shell: string;
  args: string[];
  cwd?: string;
  /** 覆盖 process.env；不传则用 process.env */
  env?: Record<string, string>;
  bufferSize?: number; // ring buffer 字节限（默认 4MB）
  cols?: number;
  rows?: number;
}

export interface PtyStats {
  totalBytes: number; // PTY 自启动以来产生的总字节数
  bufferBytes: number; // ring buffer 当前累积字节数
  pid: number;
  alive: boolean;
  /** 距最近一次 onData 毫秒数 —— heartbeat 监控用（任务 MD §风险 #3） */
  msSinceLastData: number;
  /** 距最近一次 write 毫秒数 */
  msSinceLastWrite: number;
}

export class PtyManager {
  private ptyProc: pty.IPty;
  private ringBuffer: RingBuffer;
  private consumer: ((data: string) => void) | null = null;
  /** 内部 monitor tap（与 user-facing 单 consumer 平行、独立）——onData 总是广播给所有 monitor，
   *  不受 attach/detach 影响。用于启动期 auto-confirm 等内部监听：终端窗 attach 时不会把它顶掉。 */
  private monitors = new Set<(data: string) => void>();
  private totalDataBytes = 0;
  private alive = true;
  private lastDataMs = Date.now();
  private lastWriteMs = Date.now();
  /** 2026-05-28 多 CLI 兜底：PTY 退出 callback（含异常退出 / 用户主动 shutdown） */
  private exitCallback: ((info: PtyExitInfo) => void) | null = null;

  constructor(opts: PtyManagerOptions) {
    this.ringBuffer = new RingBuffer(opts.bufferSize ?? 4 * 1024 * 1024);
    this.ptyProc = pty.spawn(opts.shell, opts.args, {
      name: 'xterm-color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? (process.env as { [key: string]: string }),
    });

    // 关键：无论有无 consumer，都吸收 stdout，避免 OS pipe buffer 满
    this.ptyProc.onData((data) => {
      this.totalDataBytes += data.length;
      this.lastDataMs = Date.now();
      this.ringBuffer.push(data);
      // 先广播给内部 monitor（auto-confirm 等）——独立于 user consumer，attach/detach 不影响
      for (const m of this.monitors) {
        try {
          m(data);
        } catch (e) {
          process.stderr.write(
            `[PtyManager] monitor threw: ${e instanceof Error ? e.message : e}\n`,
          );
        }
      }
      if (this.consumer) {
        try {
          this.consumer(data);
        } catch (e) {
          // consumer 抛错不能干扰 PTY 主路径
          process.stderr.write(
            `[PtyManager] consumer threw: ${e instanceof Error ? e.message : e}\n`,
          );
        }
      }
    });

    this.ptyProc.onExit(({ exitCode, signal }) => {
      this.alive = false;
      process.stderr.write(
        `[PtyManager] pty exited code=${exitCode} signal=${signal ?? 'none'}\n`,
      );
      if (this.exitCallback) {
        try {
          this.exitCallback({ exitCode, signal: signal ?? undefined });
        } catch (e) {
          process.stderr.write(
            `[PtyManager] exitCallback threw: ${e instanceof Error ? e.message : e}\n`,
          );
        }
      }
    });
  }

  /** 2026-05-28 多 CLI 兜底：注册 PTY 退出 callback（仅支持一个 callback；后注册的覆盖前者） */
  onExit(cb: (info: PtyExitInfo) => void): void {
    this.exitCallback = cb;
  }

  /**
   * attach 一个消费者：立刻回放 ring buffer 全部内容 + 后续实时推
   */
  attach(callback: (data: string) => void): void {
    const replay = this.ringBuffer.getAll();
    if (replay.length > 0) {
      try {
        callback(replay);
      } catch (e) {
        process.stderr.write(
          `[PtyManager] replay callback threw: ${e instanceof Error ? e.message : e}\n`,
        );
      }
    }
    this.consumer = callback;
  }

  /**
   * 暂停推送，但 PTY 继续跑、ring buffer 继续累积
   */
  detach(): void {
    this.consumer = null;
  }

  /**
   * 注册内部 monitor tap（与 user-facing consumer 独立；attach/detach 不影响它）。
   * 返回退订函数——监听完（如 auto-confirm 结束）调它移除，避免泄漏。
   * 无 ring buffer replay：monitor 用于 spawn 后同步注册的实时监听（启动期数据不会先于注册到达）。
   */
  addMonitor(cb: (data: string) => void): () => void {
    this.monitors.add(cb);
    return () => this.monitors.delete(cb);
  }

  /**
   * 同步 PTY 终端尺寸（xterm FitAddon fit 之后调，让 claude TUI 按实际容器列数排版）
   */
  resize(cols: number, rows: number): void {
    if (!this.alive) return;
    try {
      this.ptyProc.resize(cols, rows);
    } catch (e) {
      process.stderr.write(
        `[PtyManager] resize(${cols},${rows}) 失败: ${e instanceof Error ? e.message : e}\n`,
      );
    }
  }

  /**
   * 向 PTY stdin 写
   */
  write(data: string): void {
    if (!this.alive) {
      process.stderr.write('[PtyManager] write to dead pty ignored\n');
      return;
    }
    this.lastWriteMs = Date.now();
    this.ptyProc.write(data);
  }

  /** 向 Claude TUI 提交一行：分两段、各等 PTY 输出静默——先等就绪再打字、再等回显稳才单独发 \r，
   *  让 \r 作为独立"按键"触发提交（一坨 text+'\r\n' 在 TUI 未就绪时 \r 被吞，文字留框不提交）。
   *  频道终端输入框 + work 终端遥控键入共用此机制。调用方负责入口的运行态守卫。
   *  注：回合制串行使用，不存在窗口内连发两条；若将来程序自动批量连发需加队列防 \r 与下条文本交错。 */
  submitLine(text: string): void {
    if (!this.alive) return;
    this.waitForQuiet('pre-text', () => {
      if (!this.alive) return;
      this.write(text);
      setTimeout(() => {
        this.waitForQuiet('pre-cr', () => {
          if (!this.alive) return;
          this.write('\r');
        });
      }, SUBMIT_DELAY_MS);
    });
  }

  /** 轮询等 PTY 连续静默 SUBMIT_QUIET_MS（渲染/启动 settled = TUI 就绪）后执行 cb；
   *  到 SUBMIT_MAX_WAIT_MS 上限也执行（防永不静默时卡住）。pty 死则中止。 */
  private waitForQuiet(label: string, cb: () => void, started: number = Date.now()): void {
    if (!this.alive) return;
    const quietMs = Date.now() - this.lastDataMs;
    const waited = Date.now() - started;
    if (quietMs >= SUBMIT_QUIET_MS || waited >= SUBMIT_MAX_WAIT_MS) {
      if (waited >= SUBMIT_MAX_WAIT_MS) {
        process.stderr.write(
          `[PtyManager] submitLine(${label}) 等静默超 ${SUBMIT_MAX_WAIT_MS}ms 仍未达 ${SUBMIT_QUIET_MS}ms 静默，强制继续\n`,
        );
      }
      cb();
      return;
    }
    setTimeout(() => this.waitForQuiet(label, cb, started), SUBMIT_POLL_MS);
  }

  /**
   * 优雅退出（不强 kill）—— 给 PTY 时间清理 conpty 资源
   */
  shutdown(): void {
    if (!this.alive) return;
    this.ptyProc.write('\x03'); // Ctrl+C
    setTimeout(() => {
      if (this.alive) {
        try {
          this.ptyProc.kill();
        } catch {
          /* ignore */
        }
      }
    }, 1000).unref();
  }

  /** 立即 kill */
  kill(): void {
    if (!this.alive) return;
    try {
      this.ptyProc.kill();
    } catch {
      /* ignore */
    }
  }

  getStats(): PtyStats {
    const now = Date.now();
    return {
      totalBytes: this.totalDataBytes,
      bufferBytes: this.ringBuffer.size(),
      pid: this.ptyProc.pid,
      alive: this.alive,
      msSinceLastData: now - this.lastDataMs,
      msSinceLastWrite: now - this.lastWriteMs,
    };
  }
}
