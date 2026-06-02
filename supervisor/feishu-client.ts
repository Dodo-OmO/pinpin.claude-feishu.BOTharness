/**
 * 飞书 Client 单例 —— supervisor 集中持有，频道 stdio MCP server 子进程不直连飞书。
 * 实际 send 调用走 IPC RPC 到 supervisor（限速 + 撞锁兜底），保证全局只有 1 个 Lark.Client 实例。
 */

import * as Lark from '@larksuiteoapi/node-sdk';

let _client: Lark.Client | null = null;

export function initFeishuClient(appId: string, appSecret: string): Lark.Client {
  if (_client) return _client;
  _client = new Lark.Client({ appId, appSecret, disableTokenCache: false });
  process.stderr.write(`[feishu-client] initialized (appId=${appId.slice(0, 8)}…)\n`);
  return _client;
}

export function getFeishuClient(): Lark.Client {
  if (!_client) {
    throw new Error('飞书 Client 未初始化——先调 initFeishuClient(appId, appSecret)');
  }
  return _client;
}
