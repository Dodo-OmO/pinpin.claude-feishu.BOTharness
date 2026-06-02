/**
 * pinpin_peek_work_session —— 诉求 B 传话筒-观察 tool（P3.Q7）
 *
 * 品品在 work session 跑期间想"瞄一眼后台 work 在干啥"时调本 tool。
 * supervisor 返最近 N 条人类可读翻译行（stream-json 事件已被翻译成 🚀/💬/🔧/✅/✨ 等条目）。
 *
 * 用途：
 *   - Owner问"work 跑到哪儿了？" → 品品 peek 后向Owner汇报
 *   - work 长时间无 stop 通知 → 品品 peek 判断卡在哪
 *   - debug：判断 work 是否在死循环 / 卡权限 / 等输入
 *
 * **不会触发副作用**：peek 不影响 work 进程，纯读取 ring buffer。
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getSupervisorClient } from '../../ipc/client-singleton.js';
import { IPC_METHODS, type WorkPeekResult } from '../../ipc/protocol.js';

export const pinpinPeekWorkSessionTool: Tool = {
  name: 'pinpin_peek_work_session',
  description:
    '【诉求 B 传话筒-观察】瞄一眼后台 work session 的工作实况，看它跑到哪一步了。返品品口吻、已进行归纳总结、可读性高的翻译行（如 🔧 用工具 X / 💬 说了 Y / ✅ 拿到结果 Z / ✨ 完成）。' +
    '常用场景：Owner问"work 怎么样了" / work 长时间没回报你想看看 / 判断 work 是否卡死。' +
    '纯读取不影响 work 进程。',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'pinpin_spawn_work_session 返回的 session_id' },
      limit: { type: 'number', description: '返回最近多少条翻译行（默认 50，上限 500）' },
    },
    required: ['session_id'],
  },
};

interface Args {
  session_id: string;
  limit?: number;
}

export async function handlePinpinPeekWorkSession(args: Args): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  try {
    const client = getSupervisorClient();
    const result = await client.request<WorkPeekResult>(IPC_METHODS.WORK_PEEK, {
      session_id: args.session_id,
      limit: args.limit,
    });
    if (!result.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: `pinpin_peek_work_session 失败：${result.error ?? 'unknown'}` }],
      };
    }
    const body = result.lines.length > 0
      ? result.lines.join('\n')
      : '(暂无翻译事件——work 可能刚启动还没产出，或已 stop)';
    return {
      content: [
        {
          type: 'text',
          text: `work session ${args.session_id} 当前状态：${result.status ?? 'unknown'}\n最近 ${result.lines.length} 条事件：\n${body}`,
        },
      ],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: 'text', text: `pinpin_peek_work_session 失败：${e instanceof Error ? e.message : String(e)}` }],
    };
  }
}
