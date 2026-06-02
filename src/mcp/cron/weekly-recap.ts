// 周回顾 cron（MCP 版）
// 阶段 4 批次 2 步骤 2.3：方案 A #22——周日 23:00 推 weekly-recap trigger

import { registerCron } from "./registry.js";
import { pushChannelTrigger } from "../utils/push-channel.js";
import { isOwnerOfCron } from "./cron-owner.js";

// 归属：茶水间 CLI（2026-05-28 Owner决策）
if (isOwnerOfCron("tea")) {
  registerCron("weekly-recap", { kind: "weekday", dow: 0, h: 23, m: 0 }, async () => {
    await pushChannelTrigger({
      trigger: "weekly-recap",
      chat_id: process.env.PINPIN_TEA_CHAT_ID,
      body:
        "📚 周对话回顾触发（周日 23:00）。请 Task 派 weekly-recap-agent。收集所有小结返主 session 后调 write_weekly_recap({yyyy_ww, markdown}) 写本地 + create_cloud_doc + send_private_message 给Owner。",
    });
  });
}
