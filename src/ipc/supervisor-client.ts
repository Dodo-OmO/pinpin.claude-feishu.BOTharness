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
 * 断连：supervisor 挂了 / 进程退出 → 子进程不主动重连（本设计假定 supervisor 是 single source of truth；
 * 它挂了所有 child 也无意义独自存活）。setOnDisconnect 让 server.ts 可以决定怎么处理。
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
      this.socket = net.createConnection({ host: '127.0.0.1', port: this.port }, () => {
        this.connected = true;
        const hello: IpcEnvelope<HelloParams> = {
          method: IPC_METHODS.HELLO,
          params: { chat_id: this.chatId, pid: process.pid },
        };
        this.socket?.write(encodeFrame(hello));
        process.stderr.write(`[ipc-client] connected ${this.chatId} → supervisor:${this.port}\n`);
        resolveConnect();
      });
      this.socket.on('data', (chunk) => this.onData(chunk));
      this.socket.on('close', () => {
        this.connected = false;
        process.stderr.write(`[ipc-client] disconnected ${this.chatId}\n`);
        this.emit('disconnect');
      });
      this.socket.on('error', (err) => {
        process.stderr.write(`[ipc-client] socket error: ${err.message}\n`);
        if (!this.connected) reject(err);
      });
    });
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
