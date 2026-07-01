/**
 * pinpin_send_to_work_session —— 诉求 B "传话筒"续指令 tool。
 *
 * 品品给后台 work session 发新指令——写入 headless work CLI 的 stdin（stream-json user 消息）。
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getSupervisorClient } from '../../ipc/client-singleton.js';
import { IPC_METHODS, type WorkOkResult } from '../../ipc/protocol.js';

export const pinpinSendToWorkSessionTool: Tool = {
  name: 'pinpin_send_to_work_session',
  description:
    '【诉求 B 传话筒-续指令】给已启动的后台 work session 发新指令（写入 stdin，工人下一轮处理）。' +
    '常用于Owner更新工作要求时品品转给 work CLI。' +
    '工人是 headless 进程，不支持 TUI 斜杠命令（/compact、/model 等）——压上下文交给自动压缩，换模型/档位请重开 work session。',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'pinpin_spawn_work_session 返回的 session_id' },
      message: { type: 'string', description: '要写进后台 claude stdin 的指令文本' },
    },
    required: ['session_id', 'message'],
  },
};

interface Args {
  session_id: string;
  message: string;
}

export async function handlePinpinSendToWorkSession(args: Args): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  // 防 undefined 进 IPC：message 缺失会被 JSON.stringify 丢字段，到 supervisor 侧成 undefined，
  // 喂给 PTY write 触发 node-pty "chunk undefined" 崩。回明确错误（不静默吞成空消息丢Owner真需求）。
  if (
    typeof args.session_id !== 'string' || !args.session_id.trim() ||
    typeof args.message !== 'string' || !args.message.trim()
  ) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `pinpin_send_to_work_session 失败：session_id 和 message 都必填且非空（收到 session_id=${JSON.stringify(args.session_id)}, message=${JSON.stringify(args.message)}）`,
        },
      ],
    };
  }
  try {
    const client = getSupervisorClient();
    const result = await client.request<WorkOkResult>(IPC_METHODS.WORK_SEND, {
      session_id: args.session_id,
      message: args.message,
    });
    if (!result.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: `pinpin_send_to_work_session 失败：${result.error ?? 'unknown'}` }],
      };
    }
    return {
      content: [{ type: 'text', text: `已发送给 ${args.session_id}` }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: 'text', text: `pinpin_send_to_work_session 失败：${e instanceof Error ? e.message : String(e)}` }],
    };
  }
}
