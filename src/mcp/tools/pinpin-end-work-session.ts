/**
 * pinpin_end_work_session —— 诉求 B "传话筒"主动结束 tool。
 *
 * 品品判断 work session 不需要继续了（Owner说"结束这个 work"）→ 调本 tool 强制结束。
 * 与 work session 自然 stop（type:"result"）不同：本 tool 是主动 kill。
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getSupervisorClient } from '../../ipc/client-singleton.js';
import { IPC_METHODS, type WorkOkResult } from '../../ipc/protocol.js';

export const pinpinEndWorkSessionTool: Tool = {
  name: 'pinpin_end_work_session',
  description:
    '【诉求 B 传话筒-主动结束】强制结束某 work session（PTY shutdown）。' +
    '区别于 session 自然 stop（type:"result"），本 tool 是品品主动 kill。',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'pinpin_spawn_work_session 返回的 session_id' },
    },
    required: ['session_id'],
  },
};

interface Args {
  session_id: string;
}

export async function handlePinpinEndWorkSession(args: Args): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  try {
    const client = getSupervisorClient();
    const result = await client.request<WorkOkResult>(IPC_METHODS.WORK_END, {
      session_id: args.session_id,
    });
    if (!result.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: `pinpin_end_work_session 失败：${result.error ?? 'unknown'}` }],
      };
    }
    return {
      content: [{ type: 'text', text: `work session ${args.session_id} 已主动结束` }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: 'text', text: `pinpin_end_work_session 失败：${e instanceof Error ? e.message : String(e)}` }],
    };
  }
}
