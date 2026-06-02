// 日记 cron（MCP 版）
// 阶段 4 批次 2 步骤 2.5：方案 A #31——00:00 daily 推 daily-diary trigger
// 用 helper.ts 的 dateYYYYMM 算出昨天日期目录

import { registerCron } from "./registry.js";
import { pushChannelTrigger } from "../utils/push-channel.js";
import { dateYYYYMMDD } from "../utils/helper.js";
import { isOwnerOfCron } from "./cron-owner.js";

// 归属：茶水间 CLI（2026-05-28 Owner决策）
if (isOwnerOfCron("tea")) {
  registerCron("daily-diary", { kind: "daily", h: 0, m: 0 }, async () => {
    // cron 0:00 触发时是"今天 0 点"——给昨天写日记
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yyyymmdd = dateYYYYMMDD(yesterday);

    await pushChannelTrigger({
      trigger: "daily-diary",
      chat_id: process.env.PINPIN_TEA_CHAT_ID,
      body:
        `📔 给昨天 ${yyyymmdd} 写日记触发（0:00）。请 Task 派 daily-diary-agent 写日记，再调 write_diary({yyyy_mm_dd: "${yyyymmdd}", content}) 落盘。`,
      meta: { for_date: yyyymmdd },
    });
  });
}
