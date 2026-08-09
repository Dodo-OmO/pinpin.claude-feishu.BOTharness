// 永存记忆自检 cron（MCP 版）
// 阶段 4 批次 2 步骤 2.4：方案 A #23——周日 23:30 推 memory-audit trigger（错峰周回顾 23:00）

import { registerCron } from "./registry.js";
import { pushChannelTrigger } from "../utils/push-channel.js";
import { isOwnerOfCron } from "./cron-owner.js";

// 归属：Owner单聊 CLI（2026-05-28 Owner决策——记忆自检涉及私密内容）
if (isOwnerOfCron("owner")) {
  registerCron("memory-audit", { kind: "weekday", dow: 0, h: 23, m: 30 }, async () => {
    await pushChannelTrigger({
      trigger: "memory-audit",
      chat_id: process.env.PINPIN_OWNER_CHAT_ID,
      body:
        "🧠 永存记忆自检触发（周日 23:30）。请 Task 派 memory-audit-agent。sub-agent 返回摘要后主 session 写到 vault\\记忆系统\\记忆自检\\YYYY-MM\\YYYY-Www.md（如 2026-07\\2026-W30.md）。\n",
    });
  });
}
