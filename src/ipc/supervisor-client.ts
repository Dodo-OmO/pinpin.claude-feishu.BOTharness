/**
 * 子 stdio MCP server 进程端的 IPC client —— 连 supervisor 的本机 TCP，
 * 发 hello 注册自己服务的 chat_id，接收 supervisor 推过来的飞书消息 / chat-trigger。
 *
 * 启动流程：
 *   1. 从 env 读 PINPIN_CHAT_ID + PINPIN_SUPERVISOR_PORT
 *   2. connect 127.0.0.1:PORT
 *   3. send hello { chat_id, pid }
 *   4. 监听 inbound NDJSON 行 → 按 method 分发到注册的 listener
 *
 * 断连：socket 掉线（如 TCP 抖动 ECONNRESET）→ 指数退避自动重连同端口 + 重发 hello，让 supervisor
 * 重新注册 chat_id（其 client-hello→flushPendingInbound 机制自动补投断线期间缓冲的消息），全程不杀
 * 本 CLI、不丢上下文。重连 maxReconnectAttempts 次仍失败（= supervisor 真挂了、端口拒连）才 emit
 * 'disconnect'——此时 supervisor 重启会换端口并 tree-kill 重建本 CLI，故子进程不会对着死端口空转。
 * shutdown()（优雅退出）置 closedByShutdown 跳过重连。
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  IPC_METHODS,
  encodeFrame,
  type IpcEnvelope,
  type FeishuMessageParams,
  type ChatTriggerParams,
  type HelloParams,
  type WorkStoppedPush,
} from './protocol.js';

export interface SupervisorClientEvents {
  'feishu-message': (params: FeishuMessageParams) => void;
  'chat-trigger': (params: ChatTriggerParams) => void;
  disconnect: () => void;
}

export class SupervisorClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = '';
  private connected = false;
  private readonly chatId: string;
  private readonly port: number;
  private pendingRequests = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private nextRequestId = 1;
  /** 方案A：子端响应"主→子 request"的 handler 注册表（method → handler） */
  private requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
  /** 断线重连状态：连成功清零；close 时若 < max 走退避重连，达 max 才 emit 'disconnect' */
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private readonly reconnectBaseMs = 2000; // 退避 2/4/8/16/30s（上限 30s），5 次约 60s
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** shutdown() 主动关时置 true，让 close 回调跳过重连 */
  private closedByShutdown = false;

  /** 注册主端 request 的处理器（子端启动时调，如 POLL_VOTE） */
  setRequestHandler(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.requestHandlers.set(method, handler);
  }

  constructor(chatId: string, port: number) {
    super();
    this.chatId = chatId;
    this.port = port;
  }

  /** 发 request → 等 response（带 id 配对）。30s 超时。 */
  async request<R = unknown>(method: string, params: unknown): Promise<R> {
    if (!this.socket || !this.connected) {
      throw new Error('IPC client not connected');
    }
    const id = `r${this.nextRequestId++}`;
    const env: IpcEnvelope = { id, method, params };
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`IPC request ${method} timeout (30s)`));
      }, 30000);
      this.pendingRequests.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r as R);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket?.write(encodeFrame(env));
    });
  }

  async connect(): Promise<void> {
    return new Promise((resolveConnect, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: this.port }, () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.sendHello();
        process.stderr.write(`[ipc-client] connected ${this.chatId} → supervisor:${this.port}\n`);
        resolveConnect();
      });
      this.socket = socket;
      this.bindSocketHandlers(socket, reject); // reject 仅首连用（重连无 Promise）
    });
  }

  /** 发 hello 注册 chat_id（首连 + 每次重连成功都发，触发 supervisor 重新登记 + flush 缓冲消息） */
  private sendHello(): void {
    const hello: IpcEnvelope<HelloParams> = {
      method: IPC_METHODS.HELLO,
      params: { chat_id: this.chatId, pid: process.pid },
    };
    this.socket?.write(encodeFrame(hello));
  }

  /** 给 socket 绑 data/close/error。close 走重连退避链；error 仅在首连未连上时 reject。 */
  private bindSocketHandlers(socket: net.Socket, reject?: (err: Error) => void): void {
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => {
      if (this.socket !== socket) return; // 旧 socket 迟到的 close（已被新连接替换）→ 忽略，防误触发重连
      this.connected = false;
      // 断线时旧 socket 上 in-flight 的 request 必收不到响应了 → 立即 reject，调用方快速失败可重试，
      // 不必白等 30s 超时（重连成功后 supervisor 也不会重发断线前那批 request 的响应）。
      this.rejectAllPending('IPC socket closed');
      if (this.closedByShutdown) {
        process.stderr.write(`[ipc-client] disconnected ${this.chatId}（shutdown）\n`);
        return;
      }
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect();
      } else {
        process.stderr.write(
          `[ipc-client] ${this.chatId} 重连 ${this.maxReconnectAttempts} 次仍失败 → 彻底失联（supervisor 可能已挂）\n`,
        );
        this.emit('disconnect');
      }
    });
    socket.on('error', (err) => {
      process.stderr.write(`[ipc-client] socket error (${this.chatId}): ${err.message}\n`);
      if (!this.connected && reject) reject(err);
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectBaseMs * 2 ** (this.reconnectAttempts - 1), 30000);
    process.stderr.write(
      `[ipc-client] ${this.chatId} 断线，第 ${this.reconnectAttempts}/${this.maxReconnectAttempts} 次重连将在 ${delay}ms 后\n`,
    );
    this.reconnectTimer = setTimeout(() => this.tryReconnect(), delay);
  }

  private tryReconnect(): void {
    this.reconnectTimer = null;
    const socket = net.createConnection({ host: '127.0.0.1', port: this.port }, () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.buffer = ''; // 清断线前残留的半截帧，防重连后首帧拼接 parse 失败
      this.sendHello();
      process.stderr.write(`[ipc-client] ✅ reconnected ${this.chatId} → supervisor:${this.port}\n`);
    });
    this.socket = socket;
    this.bindSocketHandlers(socket); // 无 reject：重连失败靠 close 触发下一轮退避
  }

  /** reject 并清空所有等响应的 pending request（断线时调，避免调用方白等 30s 超时）。
   *  注：value.reject 是 request() 里包过的——会先 clearTimeout 再 reject。 */
  private rejectAllPending(reason: string): void {
    for (const p of this.pendingRequests.values()) {
      p.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let env: IpcEnvelope;
      try {
        env = JSON.parse(line) as IpcEnvelope;
      } catch (e) {
        process.stderr.write(
          `[ipc-client] parse failed: ${e instanceof Error ? e.message : e} line=${line.slice(0, 100)}\n`,
        );
        continue;
      }
      this.dispatch(env);
    }
  }

  private dispatch(env: IpcEnvelope): void {
    // Response (has id, has result/error)
    if (env.id && (env.result !== undefined || env.error)) {
      const pending = this.pendingRequests.get(env.id);
      if (pending) {
        this.pendingRequests.delete(env.id);
        if (env.error) pending.reject(new Error(env.error.message));
        else pending.resolve(env.result);
      }
      return;
    }
    // 方案A：主→子 request（带 id + method、无 result/error）→ 查 handler、执行、回响应帧（同 id）。
    // ⚠️ 必须排在上面"自己请求的 response"分支之后、下面 notification 分支之前。
    if (env.id && env.method) {
      void this.handleMainRequest(env);
      return;
    }
    // Notification (no id, has method)
    switch (env.method) {
      case IPC_METHODS.FEISHU_MESSAGE:
        this.emit('feishu-message', env.params as FeishuMessageParams);
        break;
      case IPC_METHODS.CHAT_TRIGGER:
        this.emit('chat-trigger', env.params as ChatTriggerParams);
        break;
      case IPC_METHODS.WORK_STOPPED:
        this.emit('work-stopped', env.params as WorkStoppedPush);
        break;
      default:
        process.stderr.write(`[ipc-client] unknown method: ${env.method}\n`);
    }
  }

  /** 方案A：处理主端 request → 查 handler、回响应帧（同 id + result 或 error） */
  private async handleMainRequest(env: IpcEnvelope): Promise<void> {
    if (!env.id || !env.method) return;
    const handler = this.requestHandlers.get(env.method);
    if (!handler) {
      this.socket?.write(
        encodeFrame({ id: env.id, error: { code: -32601, message: `unknown method: ${env.method}` } }),
      );
      return;
    }
    try {
      const result = await handler(env.params);
      this.socket?.write(encodeFrame({ id: env.id, result }));
    } catch (e) {
      this.socket?.write(
        encodeFrame({ id: env.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }),
      );
    }
  }

  /** 优雅退出 */
  shutdown(): void {
    this.closedByShutdown = true; // 让 close 回调跳过重连
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.socket) return;
    const bye: IpcEnvelope = {
      method: IPC_METHODS.BYE,
      params: { chat_id: this.chatId },
    };
    try {
      this.socket.write(encodeFrame(bye));
    } catch {
      /* ignore */
    }
    this.socket.end();
    this.socket = null;
  }
}
