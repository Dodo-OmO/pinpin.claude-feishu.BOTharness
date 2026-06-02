// 每日关注事项 cron（MCP 版）
// 阶段 4 批次 2 步骤 2.2：方案 A #21——10:00 daily 推 daily-briefing trigger

import { registerCron } from "./registry.js";
import { pushChannelTrigger } from "../utils/push-channel.js";
import { isOwnerOfCron } from "./cron-owner.js";

// 归属：Owner单聊 CLI（2026-05-28 Owner决策——关注事项是私人内容，不发茶水间）
const DAILY_BRIEFING_CHAT_ID = process.env.DAILY_BRIEFING_CHAT_ID ?? process.env.PINPIN_OWNER_CHAT_ID ?? "";

if (isOwnerOfCron("owner")) {
  registerCron("daily-briefing", { kind: "daily", h: 10, m: 0 }, async () => {
    if (!DAILY_BRIEFING_CHAT_ID) {
      process.stderr.write("[daily-briefing] 缺 .env DAILY_BRIEFING_CHAT_ID 或 PINPIN_OWNER_CHAT_ID，跳过推送\n");
      return;
    }
    await pushChannelTrigger({
      trigger: "daily-briefing",
      chat_id: DAILY_BRIEFING_CHAT_ID,
      body:
        "📋 每日关注事项触发（10:00）。请 Task 派 daily-briefing-agent，返结构化 items JSON 后调 send_briefing_card({chat_id, items}) tool 发卡片。",
    });
  });
}
