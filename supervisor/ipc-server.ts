/**
 * IPC Server —— supervisor 暴露给各频道 stdio MCP server 子进程的 NDJSON TCP 通道。
 *
 * 协议：见 src/ipc/protocol.ts。
 *
 * 主要职责：
 *   - 接收子进程 hello → 注册 chat_id ↔ socket 映射
 *   - 提供 pushFeishuMessage(chat_id, message) / pushChatTrigger(chat_id, body, meta) 供 supervisor 调
 *   - 子进程 bye / 断连 → 清理映射 + emit 事件让 supervisor 知道
 *
 * 监听 127.0.0.1:0（OS 选可用端口），端口通过 PINPIN_SUPERVISOR_PORT env 注入给子进程。
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  IPC_METHODS,
  encodeFrame,
  type IpcEnvelope,
  type HelloParams,
  type ByeParams,
  type FeishuInboundMessagePayload,
  type WorkStoppedPush,
  type StatuslineUpdateParams,
  type WorkStopSignalParams,
} from '../src/ipc/protocol.js';

export type RequestHandler = (
  params: unknown,
  chatId: string,
) => Promise<unknown>;

interface ClientEntry {
  chatId: string;
  pid: number;
  socket: net.Socket;
  buffer: string;
}

export interface IpcServerOptions {
  port?: number;
}

export class IpcServer extends EventEmitter {
  private server: net.Server | null = null;
  private port = 0;
  /** chat_id → client（最新一个 hello 覆盖；同 chat_id 二次 spawn 时旧的应已断） */
  private clients = new Map<string, ClientEntry>();
  /** request method → handler */
  private requestHandlers = new Map<string, RequestHandler>();
  /** 方案A：主→子 request 的 pending 表（id → resolve/reject/timer）。30s 超时。 */
  private pendingRequests = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextRequestId = 1;

  /** 注册 request handler（supervisor 启动时调） */
  setRequestHandler(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  async start(opts: IpcServerOptions = {}): Promise<number> {
    return new Promise((resolvePort, reject) => {
      this.server = net.createServer((socket) => this.onConnection(socket));
      this.server.on('error', reject);
      this.server.listen(opts.port ?? 0, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          process.stderr.write(`[ipc-server] listening 127.0.0.1:${this.port}\n`);
          resolvePort(this.port);
        } else {
          reject(new Error('failed to obtain listen port'));
        }
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  async stop(): Promise<void> {
    for (const c of this.clients.values()) {
      try {
        c.socket.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    for (const p of this.pendingRequests.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('ipc-server stopped'));
    }
    this.pendingRequests.clear();
    if (!this.server) return;
    await new Promise<void>((res) => this.server?.close(() => res()));
    this.server = null;
    process.stderr.write('[ipc-server] stopped\n');
  }

  /** 列出已注册的子进程 */
  listClients(): Array<{ chat_id: string; pid: number }> {
    return [...this.clients.values()].map((c) => ({ chat_id: c.chatId, pid: c.pid }));
  }

  /** 推飞书消息给对应 chat_id 的子进程；找不到子进程返回 false */
  pushFeishuMessage(chatId: string, message: FeishuInboundMessagePayload): boolean {
    const c = this.clients.get(chatId);
    if (!c) return false;
    const env: IpcEnvelope = {
      method: IPC_METHODS.FEISHU_MESSAGE,
      params: { message },
    };
    try {
      c.socket.write(encodeFrame(env));
      return true;
    } catch (e) {
      process.stderr.write(
        `[ipc-server] pushFeishuMessage(${chatId}) write 失败: ${e instanceof Error ? e.message : e}\n`,
      );
      return false;
    }
  }

  /** 推 work session stop 给对应 chat_id 的子进程 */
  pushWorkStopped(chatId: string, payload: WorkStoppedPush): boolean {
    const c = this.clients.get(chatId);
    if (!c) return false;
    const env: IpcEnvelope = {
      method: IPC_METHODS.WORK_STOPPED,
      params: payload,
    };
    try {
      c.socket.write(encodeFrame(env));
      return true;
    } catch (e) {
      process.stderr.write(
        `[ipc-server] pushWorkStopped(${chatId}) write 失败: ${e instanceof Error ? e.message : e}\n`,
      );
      return false;
    }
  }

  /** 推 chat-trigger（cron / 手动）给对应 chat_id 的子进程 */
  pushChatTrigger(chatId: string, body: string, meta?: Record<string, string>): boolean {
    const c = this.clients.get(chatId);
    if (!c) return false;
    const env: IpcEnvelope = {
      method: IPC_METHODS.CHAT_TRIGGER,
      params: { body, meta },
    };
    try {
      c.socket.write(encodeFrame(env));
      return true;
    } catch (e) {
      process.stderr.write(
        `[ipc-server] pushChatTrigger(${chatId}) write 失败: ${e instanceof Error ? e.message : e}\n`,
      );
      return false;
    }
  }

  /** 通用：往指定已注册 client 推一条 notification（无 id）。管家终端流 TERMINAL_DATA 用。 */
  pushNotification(chatId: string, method: string, params: unknown): boolean {
    const c = this.clients.get(chatId);
    if (!c) return false;
    try {
      c.socket.write(encodeFrame({ method, params }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 方案A：主 → 子 request（往该 chat 的子进程发带 id 的请求帧，等响应帧配对）。30s 超时。
   * 找不到该 chat 的 client → reject（调用方负责离线兜底 spawn + 重试）。
   */
  async request<R = unknown>(chatId: string, method: string, params: unknown): Promise<R> {
    const c = this.clients.get(chatId);
    if (!c) throw new Error(`no IPC client for chat ${chatId}`);
    const id = `s${this.nextRequestId++}`;
    const env: IpcEnvelope = { id, method, params };
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`IPC request ${method} → ${chatId} timeout (30s)`));
      }, 30000);
      this.pendingRequests.set(id, {
        resolve: (r) => resolve(r as R),
        reject,
        timer,
      });
      try {
        c.socket.write(encodeFrame(env));
      } catch (e) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private onConnection(socket: net.Socket): void {
    process.stderr.write(
      `[ipc-server] client connected from ${socket.remoteAddress}:${socket.remotePort}\n`,
    );

    // entry 占位——hello 来了再填 chatId / pid
    const entry: ClientEntry = { chatId: '', pid: 0, socket, buffer: '' };

    socket.on('data', (chunk) => {
      entry.buffer += chunk.toString('utf8');
      const lines = entry.buffer.split('\n');
      entry.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        this.onLine(entry, line);
      }
    });

    socket.on('close', () => {
      if (entry.chatId) {
        // 只清掉 map 中 socket 是同一个的——避免 stale close 删掉重连后的新 entry
        const current = this.clients.get(entry.chatId);
        if (current && current.socket === socket) {
          this.clients.delete(entry.chatId);
          process.stderr.write(`[ipc-server] client ${entry.chatId} (pid=${entry.pid}) disconnected\n`);
          this.emit('client-disconnected', { chat_id: entry.chatId, pid: entry.pid });
        }
      }
      // 短连接 sink（statusline / work-stop notification）正常断开，无 hello 注册，静默不刷日志
    });

    socket.on('error', (err) => {
      process.stderr.write(
        `[ipc-server] socket error (chat=${entry.chatId || '?'}): ${err.message}\n`,
      );
    });
  }

  private onLine(entry: ClientEntry, line: string): void {
    let env: IpcEnvelope;
    try {
      env = JSON.parse(line) as IpcEnvelope;
    } catch (e) {
      process.stderr.write(
        `[ipc-server] parse failed: ${e instanceof Error ? e.message : e} line=${line.slice(0, 100)}\n`,
      );
      return;
    }

    // 方案A：子端对"主→子 request"的响应帧（带 id + result/error、**无 method**）。
    // ⚠️ 必须在"当作子→主 request"分支之前判：先看我方 pending 是否在等这个 id 的 response。
    if (env.id && (env.result !== undefined || env.error)) {
      const pending = this.pendingRequests.get(env.id);
      if (pending) {
        this.pendingRequests.delete(env.id);
        clearTimeout(pending.timer);
        if (env.error) pending.reject(new Error(env.error.message));
        else pending.resolve(env.result);
        return;
      }
      // id 命中失败（迟到/已超时）→ 落到下面逻辑（通常被忽略）
    }

    // Request 形式（带 id + method）→ 找 request handler，处理完写 response
    if (env.id && env.method) {
      void this.handleRequest(entry, env);
      return;
    }

    // 普通 notification（无 id）
    switch (env.method) {
      case IPC_METHODS.HELLO: {
        const p = env.params as HelloParams;
        entry.chatId = p.chat_id;
        entry.pid = p.pid;
        this.clients.set(p.chat_id, entry);
        process.stderr.write(`[ipc-server] hello chat=${p.chat_id} pid=${p.pid}\n`);
        this.emit('client-hello', { chat_id: p.chat_id, pid: p.pid });
        break;
      }
      case IPC_METHODS.BYE: {
        const p = env.params as ByeParams;
        process.stderr.write(`[ipc-server] bye chat=${p.chat_id}\n`);
        // close 事件会清 map
        break;
      }
      case IPC_METHODS.STATUSLINE_UPDATE: {
        // P1.3 sink fire-and-forget notification（短连接，无 hello 注册）
        const p = env.params as StatuslineUpdateParams;
        this.emit('statusline-update', p);
        break;
      }
      case IPC_METHODS.WORK_STOP_SIGNAL: {
        // 批2 work-stop-sink fire-and-forget notification（短连接，无 hello 注册）
        const p = env.params as WorkStopSignalParams;
        this.emit('worksession-stop-signal', p);
        break;
      }
      default:
        process.stderr.write(`[ipc-server] unknown method: ${env.method}\n`);
    }
  }

  private async handleRequest(entry: ClientEntry, env: IpcEnvelope): Promise<void> {
    if (!env.method || !env.id) return;
    const handler = this.requestHandlers.get(env.method);
    if (!handler) {
      const resp: IpcEnvelope = {
        id: env.id,
        error: { code: -32601, message: `unknown method: ${env.method}` },
      };
      try {
        entry.socket.write(encodeFrame(resp));
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      const result = await handler(env.params, entry.chatId);
      const resp: IpcEnvelope = { id: env.id, result };
      entry.socket.write(encodeFrame(resp));
    } catch (e) {
      const resp: IpcEnvelope = {
        id: env.id,
        error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
      };
      try {
        entry.socket.write(encodeFrame(resp));
      } catch {
        /* ignore */
      }
    }
  }
}
