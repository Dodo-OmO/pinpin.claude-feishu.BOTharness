/**
 * 子 stdio MCP server 进程内部单例的 SupervisorClient getter。
 * server.ts main() 启动时调 setSupervisorClient(ipcClient)，
 * tools 通过 getSupervisorClient() 拿来调 .request()。
 */

import type { SupervisorClient } from './supervisor-client.js';

let _client: SupervisorClient | null = null;

export function setSupervisorClient(client: SupervisorClient): void {
  _client = client;
}

export function getSupervisorClient(): SupervisorClient {
  if (!_client) {
    throw new Error(
      'SupervisorClient 未初始化——本进程在 degraded mode（无 IPC，可能是缺 PINPIN_SUPERVISOR_PORT env）',
    );
  }
  return _client;
}
