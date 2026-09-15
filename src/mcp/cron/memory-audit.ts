// 永存记忆自检 cron（MCP 版）
// 周日 23:30 推 memory-audit trigger

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
        "🧠 永存记忆自检触发（周日 23:30）。请 Task 派 memory-audit-agent。sub-agent 返回摘要后主 session 写到 vault\\记忆系统\\记忆自检\\YYYY-MM\\YYYY-Www.md（如 2026-07\\2026-W30.md）。顺带让它把 vault\\记忆系统\\人物\\ 下超过 12000 字符的画像压到 12000 以内（先整份拷到 归档\\人物画像-压缩前-<日期>\\，再合并重复、删过程流水，稳定事实 / 偏好 / 关系定性 / 内梗一条不丢）。\n",
    });
  });
}
