/**
 * 管家 → supervisor 桥接客户端。
 *
 * 连 supervisor 固定端口(WARDEN_BRIDGE_PORT)，封装 request/response（NDJSON）。
 * 启动器没开 / 重启 → 连不上则自动重连；isConnected() 反映启动器在不在(R1 降级依据)。
 * 终端数据由 server 经 TERMINAL_DATA notification 推来 → onTerminalData 回调（步骤 3 用）。
 */
import net from 'node:net';
import {
  IPC_METHODS,
  WARDEN_BRIDGE_PORT,
  WARDEN_CLIENT_ID,
  encodeFrame,
  type IpcEnvelope,
  type WardenTerminalDataParams,
} from '../src/ipc/protocol.js';

interface Pending {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class SupervisorBridge {
  private socket: net.Socket | null = null;
  private connected = false;
  private buffer = '';
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** server push TERMINAL_DATA → 转此回调（步骤 3 终端流） */
  onTerminalData: ((chatId: string, data: string) => void) | null = null;
  /** 桥接（重）连成功回调——server 用它重订阅断线前在看的终端 */
  onReconnect: (() => void) | null = null;

  constructor(private port: number = WARDEN_BRIDGE_PORT) {}

  start(): void {
    this.connect();
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** 订阅某频道终端流（首个前端 ws 连入时调） */
  async subscribeTerminal(chatId: string): Promise<void> {
    await this.request(IPC_METHODS.WARDEN_SUB_TERMINAL, { chat_id: chatId });
  }

  /** 退订某频道终端流（最后一个前端 ws 断开时调） */
  async unsubscribeTerminal(chatId: string): Promise<void> {
    await this.request(IPC_METHODS.WARDEN_UNSUB_TERMINAL, { chat_id: chatId });
  }

  private sendNotification(method: string, params: unknown): void {
    try {
      this.socket?.write(encodeFrame({ method, params }));
    } catch {
      /* ignore */
    }
  }

  private connect(): void {
    const socket = net.connect(this.port, '127.0.0.1');
    this.socket = socket;
    socket.on('connect', () => {
      this.connected = true;
      // 注册为 __warden__，使 supervisor 能 push TERMINAL_DATA 回来
      this.sendNotification(IPC_METHODS.HELLO, { chat_id: WARDEN_CLIENT_ID, pid: process.pid });
      console.log('[warden] 已连上启动器桥接');
      this.onReconnect?.();
    });
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this.onLine(line);
      }
    });
    const drop = (): void => {
      if (this.connected) console.log('[warden] 启动器桥接断开，重连中…');
      this.connected = false;
      this.socket = null;
      // 断开时清掉等待中的请求，避免泄漏
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('启动器桥接断开'));
      }
      this.pending.clear();
      this.scheduleReconnect();
    };
    socket.on('close', drop);
    socket.on('error', () => {
      /* close 紧随其后触发 drop，这里静默避免未捕获异常 */
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  private onLine(line: string): void {
    let env: IpcEnvelope;
    try {
      env = JSON.parse(line) as IpcEnvelope;
    } catch {
      return;
    }
    // response（带 id + result/error）
    if (env.id && (env.result !== undefined || env.error)) {
      const p = this.pending.get(env.id);
      if (p) {
        this.pending.delete(env.id);
        clearTimeout(p.timer);
        if (env.error) p.reject(new Error(env.error.message));
        else p.resolve(env.result);
      }
      return;
    }
    // notification（终端数据 push 等）
    if (env.method === IPC_METHODS.WARDEN_TERMINAL_DATA) {
      const p = env.params as WardenTerminalDataParams;
      this.onTerminalData?.(p.chat_id, p.data);
    }
  }

  async request<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (!this.socket || !this.connected) throw new Error('启动器未连接');
    const id = `w${this.nextId++}`;
    const env: IpcEnvelope = { id, method, params };
    const sock = this.socket;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`桥接请求 ${method} 超时`));
      }, 15000);
      this.pending.set(id, { resolve: (r) => resolve(r as R), reject, timer });
      try {
        sock.write(encodeFrame(env));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}
