// mood_get_current tool（MCP 版 v2 · 2026-05-29 同步新数据模型）
// 取当前心境快照——返回主导情绪 / 能量 / 独白 / 活跃 moodlet / 对他人关系
// 主 session 罕用——通常心境通过 instructions 段或人格.md 自然感知；本 tool 留作显式查询用

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getCurrentMood } from "../utils/mood-state.js";

export const moodGetCurrentTool: Tool = {
  name: "mood_get_current",
  description: "取当前心境快照——返回主导情绪、能量(0-100)、一行独白、活跃 moodlet 列表、对他人关系字典。罕用，常规心境读 vault\\记忆系统\\心境\\当前.md。",
  inputSchema: { type: "object", properties: {} },
};

export async function handleMoodGetCurrent() {
  const state = getCurrentMood();
  return {
    content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
  };
}
