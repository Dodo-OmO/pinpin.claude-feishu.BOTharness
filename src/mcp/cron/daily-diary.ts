// 日记 cron（MCP 版）
// 阶段 4 批次 2 步骤 2.5：方案 A #31——00:00 daily 推 daily-diary trigger
// 用 helper.ts 的 dateYYYYMM 算出昨天日期目录

import { registerCron } from "./registry.js";
import { pushChannelTrigger } from "../utils/push-channel.js";
import { dateYYYYMMDD } from "../utils/helper.js";
import { isOwnerOfCron } from "./cron-owner.js";
import { getMeta, setMeta } from "../db/database.js";

const DIARY_LAST_DATE_KEY = "daily-diary:last_for_date";

// 归属：茶水间 CLI（2026-05-28 Owner决策）
if (isOwnerOfCron("tea")) {
  registerCron("daily-diary", { kind: "daily", h: 0, m: 0 }, async () => {
    // cron 0:00 触发时是"今天 0 点"——给昨天写日记
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yyyymmdd = dateYYYYMMDD(yesterday);

    // 幂等闸：同一 for_date 只写一次。茶水间偶发两个并发 cron 计时器（重叠/僵尸进程各跑一个，
    // 与 IPC 断连僵尸同源），同一天 00:00 + 23:59 各触发一次、都给昨天写 → 日记重复追加。
    // 跨进程共享 DB app_meta 去重，无论双触发何来源都根治。
    if (getMeta(DIARY_LAST_DATE_KEY) === yyyymmdd) return;

    // throwOnError：push 失败则抛出 → runOnce 记 FAILED 且不刷 last_run_at、下方 setMeta 不执行，
    // 下次触发/重启 catch-up 可重试，避免"推失败却标记已写"导致日记永久漏写。
    await pushChannelTrigger(
      {
        trigger: "daily-diary",
        chat_id: process.env.PINPIN_TEA_CHAT_ID,
        body:
          `📔 给昨天 ${yyyymmdd} 写日记触发（0:00）。请 Task 派 daily-diary-agent 写日记，再调 write_diary({yyyy_mm_dd: "${yyyymmdd}", content}) 落盘。`,
        meta: { for_date: yyyymmdd },
      },
      { throwOnError: true },
    );
    // 推送成功才落标记（仅去重重复触发，不锁死失败重试）
    setMeta(DIARY_LAST_DATE_KEY, yyyymmdd);
  });
}
