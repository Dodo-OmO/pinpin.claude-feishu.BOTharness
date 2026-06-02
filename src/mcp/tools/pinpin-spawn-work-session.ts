/**
 * pinpin_spawn_work_session —— 诉求 B "传话筒"启动 tool。
 *
 * 品品在某个 chat 收到Owner"开个 work 改 bug"指令时，调本 tool：
 *   - work_dir: claude code 要工作的目录（绝对路径）
 *   - goal: 注入到新 session stdin 的第一段内容（任务目标）
 *   - model: 可选，默认 supervisor 配的 default（opus 4.6 [1m]）
 *   - effort: 可选，默认 high
 *
 * supervisor 通过 PTY spawn 一个独立 claude code 进程在 work_dir 跑 goal，
 * 用 --output-format stream-json 解析 type:"result" 作为 stop 信号。
 * stop 后 supervisor 通过 IPC push WORK_STOPPED 回**原 chat** 的 stdio MCP server，
 * server 转 channel notification 给本 CLI，品品收到后向飞书该 chat 汇报 result。
 *
 * **交互式 CLI 约束**：所有 work 由独立交互式 claude 进程承担。
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getSupervisorClient } from '../../ipc/client-singleton.js';
import { IPC_METHODS, type WorkSpawnResult } from '../../ipc/protocol.js';

export const pinpinSpawnWorkSessionTool: Tool = {
  name: 'pinpin_spawn_work_session',
  description:
    '【诉求 B 传话筒-启动】品品在某 chat 收到指令时，把一个独立任务派给后台 claude code session 去干。' +
    'work_dir = 任务目录绝对路径；goal = 给后台 session 的第一段指令；可选 model / effort。' +
    '后台跑完会自动把结果回报到本 chat（你不需要 polling，等 channel notification）。' +
    '禁止用此 tool 启动跟本 chat 同 cwd 的 work（撞文件锁）。' +
    '返回 session_id，后续 pinpin_send_to_work_session / pinpin_end_work_session 用到。',
  inputSchema: {
    type: 'object',
    properties: {
      work_dir: { type: 'string', description: '后台 session 的工作目录（绝对路径）' },
      goal: { type: 'string', description: '给后台 session 的第一段指令（任务目标 / prompt）' },
      model: { type: 'string', description: '可选模型。缺省走 supervisor default (opus 4.6 [1m])' },
      effort: { type: 'string', description: '可选 effort：low/medium/high/xhigh/max。缺省 high' },
    },
    required: ['work_dir', 'goal'],
  },
};

interface Args {
  work_dir: string;
  goal: string;
  model?: string;
  effort?: string;
}

export async function handlePinpinSpawnWorkSession(args: Args): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  const chatId = process.env.PINPIN_CHAT_ID;
  if (!chatId) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'pinpin_spawn_work_session 失败：本进程无 PINPIN_CHAT_ID env（degraded mode 不支持 work session）',
        },
      ],
    };
  }
  try {
    const client = getSupervisorClient();
    const result = await client.request<WorkSpawnResult>(IPC_METHODS.WORK_SPAWN, {
      origin_chat_id: chatId,
      work_dir: args.work_dir,
      goal: args.goal,
      model: args.model,
      effort: args.effort,
    });
    return {
      content: [
        {
          type: 'text',
          text: `work session 已启动：session_id=${result.session_id}（cwd=${args.work_dir}）。后台跑完会自动 channel notification 回报结果。`,
        },
      ],
    };
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `pinpin_spawn_work_session 失败：${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  }
}
