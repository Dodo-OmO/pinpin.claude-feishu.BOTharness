// 周回顾 cron（MCP 版）
// 阶段 4 批次 2 步骤 2.3：方案 A #22——周日 22:00 推 weekly-recap trigger

import { registerCron } from "./registry.js";
import { pushChannelTrigger } from "../utils/push-channel.js";
import { isOwnerOfCron } from "./cron-owner.js";

// 归属：Owner私聊 CLI——建文档用 DM 的用户身份，文档直接归Owner，无需 member-add
if (isOwnerOfCron("owner")) {
  registerCron("weekly-recap", { kind: "weekday", dow: 0, h: 22, m: 0 }, async () => {
    await pushChannelTrigger({
      trigger: "weekly-recap",
      chat_id: process.env.PINPIN_OWNER_CHAT_ID,
      body:
        "📚 周对话回顾触发（周日 22:00）。请 Task 派 weekly-recap-agent。收集所有小结返主 session 后调 write_weekly_recap({yyyy_ww, markdown}) 写本地 → `lark-cli docs +create --doc-format markdown --title <标题> --content @<本地文件>` 建云文档（当前频道就是Owner私聊，用本频道身份建的文档直接归Owner，不需要 member-add 开权限）→ 用 pinpin_reply_text 把链接直接回在本频道。",
    });
  });
}
