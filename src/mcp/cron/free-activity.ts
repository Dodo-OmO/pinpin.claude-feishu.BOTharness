// 自由活动 cron（MCP 版）
// 阶段 4 批次 2 步骤 2.5：方案 A #10 + #31——每 4h 推 free-activity trigger
//
// **优雅清单 3 落实**：彻底砍 早期版本 isChatActive 守门员（Owner ⑥-3 决策）——
// cron 到点直接推 trigger 不查 chat 活跃度，副作用是品品正聊天时可能"突然走神去喝茶"
// （Owner已接受此行为，本就是品品自然性格的一部分）。
//
// 多 CLI 归属（2026-05-28 Owner决策）：仅茶水间 CLI 触发；茶水间主对话品品自决在茶水间响应
// 还是用 cross_chat_message tool 去其它白名单频道发活动结果（替代旧 PINPIN_SPONTANEOUS_CHAT_IDS
// loop 多频道推送的方式——多 CLI 物理隔离后 loop 推送语义混乱，统一收口给茶水间品品）。

import { registerCron } from "./registry.js";
import { pushChannelTrigger } from "../utils/push-channel.js";
import { isOwnerOfCron } from "./cron-owner.js";

const FREE_ACTIVITY_INTERVAL_MS = Number(
  process.env.PINPIN_FREE_ACTIVITY_INTERVAL_MS ?? 4 * 3600 * 1000
);

if (isOwnerOfCron("tea")) {
  registerCron(
    "free-activity",
    { kind: "interval", ms: FREE_ACTIVITY_INTERVAL_MS },
    async () => {
      await pushChannelTrigger({
        trigger: "free-activity",
        chat_id: process.env.PINPIN_TEA_CHAT_ID,
        body:
          "🌿 自由活动触发。请按 `.claude/skills/自由活动/SKILL.md` 走流程——8 选项里随心挑一个。" +
          "如选「外出学习/网上冲浪」。一定要 Task 派 journey-agent 干活。结束后派 write_journey_log 写台账。" +
          "活动完成后你**自主决定**是否用 cross_chat_message tool 去其它频道分享（看心情和场景，不强制；茶水间一处触发 + 你自决跨群）。",
      });
    }
  );
}
