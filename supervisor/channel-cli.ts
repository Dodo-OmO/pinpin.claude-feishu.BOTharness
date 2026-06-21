/**
 * ChannelCli —— 一个飞书 chat_id 对应的 claude CLI 进程实例。
 *
 * spawn claude CLI（交互式，不是 -p 模式）→ claude 通过 vault `.mcp.json` 自启动 dist/mcp/server.js
 * 子进程作为 stdio MCP server，子进程通过 env PINPIN_CHAT_ID + PINPIN_SUPERVISOR_PORT 连 supervisor IPC。
 *
 * supervisor 持有 ChannelCli 实例，控制其生命周期（start / stop / restart / compact / attachTerminal）。
 *
 * **交互式 CLI 约束**：本类绝不允许在 spawn args 里出现 `-p` / `--print`，必须**交互式 claude**。
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PtyManager } from './pty-manager.js';
import { buildInstructions } from '../src/mcp/instructions.js';
import { DEFAULT_AUTOCOMPACT_PCT } from './channel-config-store.js';
import { resolveClaudePath, stripAnsi, claudeApiNetEnv } from './utils.js';


export interface ChannelCliOptions {
  chatId: string;
  chatName?: string;
  vaultCwd: string;
  /** 模型——默认值见 supervisor/index.ts DEFAULT_MODEL；热切换需先关闭再启动 */
  model: string;
  /** effort：low / medium / high / max。默认 high（Owner 2026-05-28 实测反馈改） */
  effort: string;
  /** supervisor IPC server 端口 */
  supervisorPort: number;
  /** 共享 data.db 路径（让子 stdio MCP server 进程通过 PINPIN_DB_PATH env 指向 supervisor 同一个 db） */
  dbPath: string;
  /** 共享 name-mappings.json 路径（子进程经 PINPIN_NAME_MAP_PATH env 读同一文件，mtime 热重载=实时） */
  nameMapPath: string;
  /** P1.3: statusLine sink script 绝对路径（scripts/statusline-sink.cjs）。
   *  通过 claude --settings 内联 JSON 注入 statusLine 配置，sink 收 stdin JSON 推 supervisor。 */
  statusLineSinkPath: string;
  /** 自动压缩阈值（上下文用量百分比）。缺省走 DEFAULT_AUTOCOMPACT_PCT；注入子 CLI 的 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE。 */
  autoCompactPct?: number;
  /** fast 模式（Opus 加速输出）。true 时把 fastMode:true 合并进 --settings JSON（自动切 Opus、扣 usage credits）。 */
  fast?: boolean;
}

export type ChannelCliStatus = 'starting' | 'running' | 'stopped' | 'failed';

export class ChannelCli extends EventEmitter {
  readonly opts: ChannelCliOptions;
  private pty: PtyManager | null = null;
  private _status: ChannelCliStatus = 'stopped';
  private startedAt: number | null = null;
  private autoConfirmInterval: NodeJS.Timeout | null = null;
  /** 启动期 auto-confirm 的 PtyManager monitor 退订函数（走独立 monitor tap，不被终端窗 attach 顶掉） */
  private autoConfirmStopMonitor: (() => void) | null = null;
  /** 2026-05-28 多 CLI 兜底：区分用户主动 stop vs PTY 异常退出。
   *  仅当 userStopped=false 且 PTY 真退出时才发 'crashed' 事件让 supervisor 自动重启 */
  private userStopped = false;
  /** P1.3: 每次 spawn 生成新 UUID（Owner决策：重启 = 上下文清零）。
   *  传给 claude --session-id，让 supervisor 知道 transcript jsonl 路径。 */
  private _sessionId: string = '';

  constructor(opts: ChannelCliOptions) {
    super();
    this.opts = opts;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get status(): ChannelCliStatus {
    return this._status;
  }

  get uptimeMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  start(): void {
    if (this._status === 'running' || this._status === 'starting') {
      process.stderr.write(`[channel-cli ${this.opts.chatId}] already ${this._status}\n`);
      return;
    }
    this._status = 'starting';
    // P1.3: 每次 spawn 都新 UUID（Owner"重启清零"决策）
    this._sessionId = randomUUID();

    // P1.3: 内联 statusLine JSON 注入（--settings 接 file-or-JSON-string）
    // 不污染 vault settings.json；sink script 收 stdin JSON 通过 TCP 推 supervisor
    // fast 开时把 fastMode:true 合并进同一个 --settings JSON（与 statusLine 并存，不另加 --settings）。
    // fastMode 是唯一程序化开 fast 的途径（无 --fast flag/env）；fast 自动切 Opus、扣 usage credits。
    const statusLineCfg = JSON.stringify({
      statusLine: {
        type: 'command',
        command: `node "${this.opts.statusLineSinkPath}" --chat-id=${this.opts.chatId}`,
      },
      ...(this.opts.fast ? { fastMode: true } : {}),
    });

    // 开场白注入：生成完整人格/协议/记忆/画像/心境写临时文件，--append-system-prompt-file 注入。
    // 走真 system prompt（不限长、compact 后 unchanged），突破 MCP instructions 字段的 2KB 截断
    // （根因详见 src/mcp/instructions.ts 文件头）。生成失败则降级不传该 flag，靠 MCP server 兜底句。
    const safeChat = this.opts.chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const sysPromptFile = path.join(os.tmpdir(), `pinpin-sysprompt-${safeChat}.txt`);
    let sysPromptOk = false;
    try {
      fs.writeFileSync(
        sysPromptFile,
        buildInstructions(this.opts.vaultCwd, this.opts.chatId),
        'utf-8',
      );
      sysPromptOk = true;
    } catch (e) {
      process.stderr.write(
        `[channel-cli ${this.opts.chatId}] 生成 system-prompt 文件失败,降级: ${e instanceof Error ? e.message : e}\n`,
      );
    }

    // 红线检查：args 不许含 -p / --print（交互式 CLI 约束）
    const args = [
      '--dangerously-load-development-channels',
      'server:feishu-channel',
      '--model',
      this.opts.model,
      '--effort',
      this.opts.effort,
      '--session-id',
      this._sessionId,
      '--settings',
      statusLineCfg,
      ...(sysPromptOk ? ['--append-system-prompt-file', sysPromptFile] : []),
      '--permission-mode',
      'bypassPermissions',
      '--tools',
      'Bash,Edit,Read,Write,Glob,Grep,Task,WebFetch,WebSearch,TodoWrite,Skill,AskUserQuestion,NotebookEdit,ToolSearch',
    ];
    for (const a of args) {
      if (a === '-p' || a === '--print') {
        throw new Error(`[channel-cli] 红线：不允许 -p/--print spawn 参数（${a}）`);
      }
    }

    // 注入子 MCP server 进程能读到的 env
    const childEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PINPIN_CHAT_ID: this.opts.chatId,
      PINPIN_SUPERVISOR_PORT: String(this.opts.supervisorPort),
      PINPIN_DB_PATH: this.opts.dbPath,
      // 子 MCP 进程读同一份人名/bot名映射（sender-names / bot-roster 解析最前优先），mtime 热重载
      PINPIN_NAME_MAP_PATH: this.opts.nameMapPath,
      // MCP tool search：强制所有 MCP tool 折叠（按需 ToolSearch 发现），仅 server ListTools 标
      // app/alwaysLoad 的核心/自动触发工具常驻。省每轮固定 MCP 开销（~40k→~10k）。
      // true=强制开启（跳过走网络时的 fallback；网络 透传 tool_reference 块）。
      ENABLE_TOOL_SEARCH: 'true',
      // 关闭 Claude Code 自动记忆（AutoMem）：品品已有永久记忆50条 + 日记/人物/心境整套记忆系统，
      // AutoMem 与之重复并行，关掉省启动注入 + 统一到 vault 一套记忆。
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      // 自动压缩走 CLI 原生 auto-compact：把触发阈值从默认 ~83% 调低到 25%（只能调低不能调高）。
      // CLI 到 25% 就地原生压缩（自动留摘要 + system prompt/人格/CLAUDE.md 从磁盘重注入不丢），
      // 无需 supervisor 监测用量阈值（D-6 手工摘要机制已回滚）。
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(this.opts.autoCompactPct ?? DEFAULT_AUTOCOMPACT_PCT),
      // API 失败重试加固（单源 utils.claudeApiNetEnv）。
      ...claudeApiNetEnv(),
    };

    const claudePath = resolveClaudePath();
    try {
      this.pty = new PtyManager({
        shell: claudePath,
        args,
        cwd: this.opts.vaultCwd,
        env: childEnv,
        cols: 120,
        rows: 36,
      });
    } catch (e) {
      this._status = 'failed';
      process.stderr.write(
        `[channel-cli ${this.opts.chatId}] spawn 失败: ${e instanceof Error ? e.message : e}\n`,
      );
      this.emit('failed', e);
      return;
    }

    this.startedAt = Date.now();
    this._status = 'running';
    this.userStopped = false;
    process.stderr.write(
      `[channel-cli ${this.opts.chatId}] spawned (pid=${this.pty.getStats().pid}, exec=${claudePath}, model=${this.opts.model}, effort=${this.opts.effort})\n`,
    );

    // 2026-05-28 多 CLI 兜底：PTY 异常退出 → emit 'crashed'（supervisor 监听后自动重启）
    // 用户主动 stop 时 userStopped=true，stop() 已 emit 'stopped'——此 callback 跳过避免重复
    // 2026-06-03 修重启竞态：restart() = stop() + 500ms 后 start()，但被 kill 的旧进程 PTY ~1s 后才真死。
    //   届时 start() 已把 userStopped 重置为 false，旧 PtyManager 仍持有自己那个 onExit 闭包（引用本实例），
    //   失去保护 → 把刚建好的新 pty 置 null + emit 'crashed' → supervisor 自动重启 → 同频道多僵尸进程抢消息
    //   （间歇连不上根因）。闭包捕获本次 PtyManager 引用 ownPty：若 this.pty 已被新 start() 替换，本回调来自旧进程→跳过。
    const ownPty = this.pty;
    this.pty.onExit((info) => {
      if (this.pty !== ownPty) return; // 旧进程的延迟退出回调（this.pty 已被新 start 替换）→ 不当崩溃处理
      if (this.userStopped) return; // stop() 路径已经处理完
      if (this.autoConfirmInterval) {
        clearInterval(this.autoConfirmInterval);
        this.autoConfirmInterval = null;
      }
      this.autoConfirmStopMonitor?.();
      this.autoConfirmStopMonitor = null;
      this.pty = null;
      this._status = 'failed';
      this.startedAt = null;
      process.stderr.write(
        `[channel-cli ${this.opts.chatId}] crashed (exitCode=${info.exitCode}, signal=${info.signal ?? 'none'})\n`,
      );
      this.emit('crashed', info);
    });

    // 启动期 claude 弹多个"Enter to confirm"提示（dev channel / settings / project trust 等），
    // 逐个 auto-press Enter 接受 default；启动结束（IPC hello）后停。ANSI cursor-forward 把
    // "Enter to confirm" 拆成 "Enter\x1b[1Cto\x1b[1Cconfirm" — strip + \s* 兼容。
    let lastAutoEnterAt = 0;
    let autoConfirmDone = false;
    let promptBuffer = '';

    const tryAutoConfirm = (): void => {
      if (autoConfirmDone) return;
      const clean = stripAnsi(promptBuffer);
      const now = Date.now();
      if (/Enter\s*to\s*confirm/.test(clean) && now - lastAutoEnterAt > 1500) {
        lastAutoEnterAt = now;
        this.pty?.write('\r');
        process.stderr.write(
          `[channel-cli ${this.opts.chatId.slice(-8)}] auto-confirmed startup prompt\n`,
        );
        promptBuffer = ''; // 清掉，等下个 prompt 重新累积
      }
    };

    // IPC client 上线后停止 auto-confirm（启动期结束）
    // start() 可被崩溃重启多次调用，先清掉旧 listener 防累积
    this.removeAllListeners('ipc-ready');
    this.on('ipc-ready', () => {
      autoConfirmDone = true;
      if (this.autoConfirmInterval) {
        clearInterval(this.autoConfirmInterval);
        this.autoConfirmInterval = null;
      }
      this.autoConfirmStopMonitor?.();
      this.autoConfirmStopMonitor = null;
    });

    // auto-confirm 走独立 monitor tap（非 attach）——终端窗 attachTerminal 走 PtyManager.attach 拿数据时
    // 不会把 auto-confirm 顶掉（修"启动头几秒开终端窗→auto-confirm 失灵"竞争）。ipc-ready 时退订。
    this.autoConfirmStopMonitor = this.pty.addMonitor((data) => {
      if (autoConfirmDone) return;
      promptBuffer = (promptBuffer + data).slice(-8192);
      tryAutoConfirm();
    });

    // 周期复查：上一个 prompt 处理完后，claude 渲染下个 prompt 不一定再触发 onData（数据停了），
    // 用 1s tick 让 debounce 窗口过后能 catch 仍在屏幕上的"Enter to confirm"
    this.autoConfirmInterval = setInterval(tryAutoConfirm, 1000);

    this.emit('started');
  }

  stop(): void {
    if (this._status === 'stopped') return;
    // 2026-05-28 多 CLI 兜底：标 userStopped=true，让 PtyManager.onExit callback 区分这是
    // 用户主动 stop 而不是异常崩溃（崩溃情况触发 supervisor 自动重启逻辑）
    this.userStopped = true;
    if (this.autoConfirmInterval) {
      clearInterval(this.autoConfirmInterval);
      this.autoConfirmInterval = null;
    }
    this.autoConfirmStopMonitor?.();
    this.autoConfirmStopMonitor = null;
    this.pty?.kill(); // 立即树杀：连 MCP server / cmd 子进程一起干掉，决定性、无延迟竞态、不留孤儿
    this.pty = null;
    this._status = 'stopped';
    this.startedAt = null;
    this.emit('stopped');
    process.stderr.write(`[channel-cli ${this.opts.chatId}] stopped (user-initiated)\n`);
  }

  restart(): void {
    // 仅启动器 [↻] 手动重启走这里（自动重启走 supervisor 直调 start()）。
    // 发 manual-restart 让 supervisor 重置崩溃熔断计数——人工介入视为"从头算"。
    this.emit('manual-restart');
    this.stop();
    setTimeout(() => this.start(), 500);
  }

  /** 往本频道 CLI 的 PTY 透传任意字符串（compact_chat tool 经 IPC 调，写 `/compact\n` 触发原生压缩）。
   *  ⚠️ 非官方手段：CLI 原生 /compact 无官方程序化接口（research preview channels 也没暴露），
   *  唯一办法是往交互式 claude 的 PTY 写入命令行字符串模拟键盘——跟启动期 auto-confirm 写 '\r' 同源。
   *  CLI 升级若改 TUI 行为（如 slash 命令触发方式 / 输入回车协议变化）需复查本路径是否仍生效。
   *  返回 false = PTY 不在 running 态写不进去（调用方据此回报失败）。 */
  writeToPty(data: string): boolean {
    if (this._status !== 'running' || !this.pty) {
      process.stderr.write(
        `[channel-cli ${this.opts.chatId}] writeToPty 跳过 (status=${this._status})\n`,
      );
      return false;
    }
    this.pty.write(data);
    return true;
  }

  /** 启动器 [🧹] 按钮触发本频道原生 /压缩（走 writeToPty 统一路径，跟 compact_chat tool 同机制）。 */
  compact(): void {
    if (this.writeToPty('/compact\n')) {
      process.stderr.write(`[channel-cli ${this.opts.chatId}] /compact 已注入（启动器触发）\n`);
    }
  }

  /** 用户在终端窗口输入文字 → 通过 PTY 写进 claude stdin。
   *  走 submitLine（双段静默门：文本与 \r 分两次发），不一次性 text+'\r\n'——
   *  否则 Ink TUI 把整坨当粘贴内容、\r 被吞、文字留框不提交（与 work 终端同机制）。 */
  sendInput(text: string): void {
    if (!this.pty || this._status !== 'running') return;
    this.pty.submitLine(text);
  }

  /** xterm FitAddon fit 之后，把实际终端尺寸同步回 PTY（修复 ANSI 排版错位） */
  resizeTerminal(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  /** 切换 model；只改 opts.model，不主动 restart——调用方决定何时 restart（CLI 不支持热切换） */
  setModel(model: string): void {
    this.opts.model = model;
  }

  /** 切换 effort；只改 opts.effort，不主动 restart——调用方决定何时 restart */
  setEffort(effort: string): void {
    this.opts.effort = effort;
  }

  /** P4.Q3 续：自定义卡片显示名（getStats 返回的 chat_name 用此） */
  setChatName(name: string | undefined): void {
    this.opts.chatName = name;
  }

  setAutoCompactPct(pct: number): void {
    this.opts.autoCompactPct = pct;
  }

  /** 切换 fast；只改 opts.fast，下次 spawn/restart 生效（fast 仅 spawn 时经 --settings 注入） */
  setFast(fast: boolean): void {
    this.opts.fast = fast;
  }

  /** 启动器终端窗口 attach：consumer 收 PTY ring buffer 全量 + 实时 onData */
  attachTerminal(consumer: (data: string) => void): void {
    this.pty?.attach(consumer);
  }

  detachTerminal(): void {
    this.pty?.detach();
  }

  getStats(): {
    chat_id: string;
    chat_name?: string;
    status: ChannelCliStatus;
    pid?: number;
    uptime_ms: number;
    started_at: number | null;
    model: string;
    effort: string;
    autoCompactPct: number;
    fast: boolean;
    session_id?: string;
    /** 待机标记（实际值由 supervisor.getDisplayChannels 从 configStore 盖戳；ChannelCli 不持有此态） */
    standby?: boolean;
  } {
    const ptyStats = this.pty?.getStats();
    return {
      chat_id: this.opts.chatId,
      chat_name: this.opts.chatName,
      status: this._status,
      pid: ptyStats?.pid,
      uptime_ms: this.uptimeMs,
      started_at: this.startedAt,
      model: this.opts.model,
      effort: this.opts.effort,
      autoCompactPct: this.opts.autoCompactPct ?? DEFAULT_AUTOCOMPACT_PCT,
      fast: this.opts.fast ?? false,
      session_id: this._sessionId || undefined,
    };
  }
}
