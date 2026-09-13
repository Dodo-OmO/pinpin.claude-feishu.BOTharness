/**
 * 飞书 Client 多应用 Map —— supervisor 集中持有每个飞书自建应用的 Lark.Client 实例。
 * 频道 stdio MCP server 子进程不直连飞书，跨应用能力（LIST_CHATS / PEER_MESSAGE 频道间捎话）经 IPC 转发到 supervisor。
 */

import * as Lark from '@larksuiteoapi/node-sdk';

const clients = new Map<string, Lark.Client>();

/** 幂等：同 appId 二次调用返回已有实例 */
export function initFeishuClient(appId: string, appSecret: string): Lark.Client {
  const existing = clients.get(appId);
  if (existing) return existing;
  const client = new Lark.Client({ appId, appSecret, disableTokenCache: false });
  clients.set(appId, client);
  process.stderr.write(`[feishu-client] initialized (appId=${appId.slice(0, 8)}…)\n`);
  return client;
}

export function getFeishuClient(appId: string): Lark.Client {
  const client = clients.get(appId);
  if (!client) {
    throw new Error('未初始化的飞书应用 ' + appId.slice(0, 8));
  }
  return client;
}

/** 列出全部已初始化的应用 client（sender-resolver 跨应用逐个试用户接口时用） */
export function listFeishuClients(): Array<{ appId: string; client: Lark.Client }> {
  return [...clients.entries()].map(([appId, client]) => ({ appId, client }));
}
