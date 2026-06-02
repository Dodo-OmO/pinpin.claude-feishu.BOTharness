/**
 * pinpin_send_to_work_session —— 诉求 B "传话筒"续指令 tool。
 *
 * 品品给后台 work session 发新指令——直接通过 PTY write 进 claude stdin。
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getSupervisorClient } from '../../ipc/client-singleton.js';
import { IPC_METHODS, type WorkOkResult } from '../../ipc/protocol.js';

export const pinpinSendToWorkSessionTool: Tool = {
  name: 'pinpin_send_to_work_session',
  description:
    '【诉求 B 传话筒-续指令】给已启动的后台 work session 发新指令（PTY 键入 stdin）。' +
    '常用于Owner更新工作要求时品品转给 work CLI。' +
    '也可发斜杠命令遥控 work CLI（如 /compact 压上下文、/model <模型名> 换模型、/context 看用量、/cost 看花费）——' +
    '但务必用「带参数/立即执行」形式，绝不发会弹选择菜单的裸命令（如裸 /model），' +
    'work CLI 那端无人能点菜单、会卡住。换 effort 暂无斜杠命令，需重开 work session。',
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
