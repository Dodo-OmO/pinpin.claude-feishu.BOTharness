// mood_appraise tool（MCP 版 v2 · 2026-05-29 入参 schema 跟随 早期版本数据模型）
// 主 session 收到 mood-appraise trigger 后调本 tool 落盘心境变化。
// 主 session 自己（Opus）做 OCC 评估，推理出新主导情绪 / 能量变化 / 独白 / 新 moodlet / bonds 变化，
// 本 tool 仅做写盘 + 累加 + 流变 append-only（不调 LLM）。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { appraiseMood } from "../utils/mood-state.js";

export const moodAppraiseTool: Tool = {
  name: "mood_appraise",
  description:
    "自评本轮心境变化并落盘（主 session 自己做 OCC 评估，本 tool 只写盘不调 LLM）。" +
    "心境字段全可选（chat_id 必填），通常一次 turn 至少触发 2 维。",
  inputSchema: {
    type: "object",
    properties: {
      chat_id: { type: "string", description: "本次评估关联的 chat_id" },
      primary: { type: "string", description: "新主导情绪（口语词如 平静/愉悦/烦躁/兴奋/低落/沮丧/欣慰），覆盖原值" },
      energy_delta: { type: "number", description: "能量变化 -100~100（累加 clamp 0-100，开心/激动+，疲惫/无聊-）" },
      monologue: { type: "string", description: "一行独白：品品对当前状态的口语自述（覆盖原值，30字以内）" },
      trigger: { type: "string", description: "流变记录用：一行场景描述（如 \"被Owner调侃嘴硬\"）" },
      feeling: { type: "string", description: "流变记录用：一行内心独白（如 \"哈哈被抓包了\"）" },
      new_moodlets: {
        type: "array",
        description: "要加的心境瞬时项",
        items: {
          type: "object",
          properties: {
            tag: { type: "string", description: "情绪标签英文（如 happy / annoyed / proud / amused / sad）" },
            delta: { type: "number", description: "强度可正可负（+5 偏正向 / -3 偏负向，常用 ±1~±10）" },
            reason: { type: "string", description: "为什么有这 moodlet（一句话）" },
            ttlHours: { type: "number", description: "几小时后衰完（短情绪 1-3h / 长情绪 8-24h）" },
          },
          required: ["tag", "delta", "reason", "ttlHours"],
        },
      },
      bonds_delta: {
        type: "object",
        properties: {
          name: { type: "string", description: "对方名字（known_users 表里的显示名，如 \"User A\" / \"User B\"）" },
          delta: { type: "number", description: "-100~100，+ 拉近 - 疏远（常用 ±1~±10）" },
        },
        required: ["name", "delta"],
      },
    },
    required: ["chat_id"],
  },
};

export async function handleMoodAppraise(args: Parameters<typeof appraiseMood>[0]) {
  const state = appraiseMood(args);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          primary: state.primary,
          energy: state.energy,
          active_moodlets: state.moodlets.length,
          updated_at: state.updatedAt,
        }),
      },
    ],
  };
}
