// pinpin_memorize tool handler——阶段 3 批 2 永存记忆写盘语义化 tool
// 取代 早期版本 mempin 字符串协议（替换 NN / 并入 NN / 不记 + [mempin-content] 内容）
//
// 入参：decision（必填 enum["write","skip"]）/ index（write 时必填 1-50）/ content（write 时必填 ≤80字）/ skip_reason（可选）
// 行为：decision="write" → writeMemoryLine；decision="skip" → 仅打日志不写盘
// 设计简化：原 早期版本「替换/并入」二选一对 bot 端无区分（都是覆盖第 N 行），统一为 write
//
// 注：本 tool 不做 chat_id 错位检查——永存记忆是全局而非按 chat，任何活跃会话都能写

import { writeMemoryLine } from "../utils/memory.js";

export const PINPIN_MEMORIZE_TOOL = {
  name: "pinpin_memorize",
  description:
    "永存记忆 50 条写盘（只记希望不要被明天的品品忘记的难忘事件）。⚠️ 人物的稳定信息/偏好/内梗改走 Edit 记忆系统\\人物\\<人>.md 对应小节，不用本 tool。\n\n判断口径见 vault\\CLAUDE.md 永存记忆段：沾边即 write 合并到对应 NN，不另起炉灶（覆盖过时）/ 全新主题 write 到最弱 NN / 列表已满且不想替换 → skip。一个 turn 最多调 1 次。",
  inputSchema: {
    type: "object" as const,
    properties: {
      decision: {
        type: "string" as const,
        enum: ["write", "skip"],
        description: "write = 写盘到指定 NN（覆盖，必填 index + content）；skip = 这条不值得记 / 都更值得保留",
      },
      index: {
        type: "integer" as const,
        minimum: 1,
        maximum: 50,
        description: "永存记忆条号 1-50",
      },
      content: {
        type: "string" as const,
        maxLength: 80,
        description: "单条记忆，≤80字硬上限。不含日期前缀",
      },
      skip_reason: {
        type: "string" as const,
        description: "decision=skip 时可选填理由（仅 stderr 日志用，不写盘）",
      },
    },
    required: ["decision"],
  },
};

interface PinpinMemorizeArgs {
  decision: "write" | "skip";
  index?: number;
  content?: string;
  skip_reason?: string;
}

export async function handlePinpinMemorize(
  args: PinpinMemorizeArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { decision, index, content, skip_reason } = args;

  if (decision === "skip") {
    process.stderr.write(
      `[pinpin_memorize] skip${skip_reason ? `: ${skip_reason}` : ""}\n`,
    );
    return {
      content: [{ type: "text", text: JSON.stringify({ decision: "skip" }) }],
    };
  }

  if (decision !== "write") {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `decision 必须是 "write" 或 "skip"，收到: ${decision}`,
      }],
    };
  }

  // write 必填校验
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > 50) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `decision=write 时 index 必须是 1-50 整数，收到: ${index}`,
      }],
    };
  }
  if (!content || !content.trim()) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: "decision=write 时 content 必填非空",
      }],
    };
  }

  try {
    const ok = await writeMemoryLine(index, content);
    if (!ok) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: JSON.stringify({
            decision: "write",
            delivered: false,
            error: `mempin 写盘失败 index=${index}（见 server stderr 具体原因，可能是越界 / 空内容 / 文件锁）`,
          }),
        }],
      };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          decision: "write",
          delivered: true,
          index,
          content_preview: content.slice(0, 30),
        }),
      }],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[pinpin_memorize] 异常: ${msg}\n`);
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          decision: "write",
          delivered: false,
          error: `mempin 写盘异常: ${msg}`,
        }),
      }],
    };
  }
}
