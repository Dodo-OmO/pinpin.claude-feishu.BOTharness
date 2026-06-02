// 每日早报 cron（MCP 版）
// 阶段 4 批次 2 步骤 2.1：方案 A #20——9:00 daily 推 daily-news trigger 给主 session

import { registerCron } from "./registry.js";
import { pushChannelTrigger } from "../utils/push-channel.js";
import { isOwnerOfCron } from "./cron-owner.js";

// 归属：茶水间 CLI（2026-05-28 Owner决策）。非茶水间 CLI import 本文件时 skip registerCron。
const DAILY_NEWS_CHAT_ID = process.env.DAILY_NEWS_CHAT_ID ?? process.env.PINPIN_TEA_CHAT_ID ?? "";

if (isOwnerOfCron("tea")) {
  registerCron("daily-news", { kind: "daily", h: 9, m: 0 }, async () => {
    if (!DAILY_NEWS_CHAT_ID) {
      process.stderr.write("[daily-news] 缺 .env DAILY_NEWS_CHAT_ID 或 PINPIN_TEA_CHAT_ID，跳过推送\n");
      return;
    }
    await pushChannelTrigger({
      trigger: "daily-news",
      chat_id: DAILY_NEWS_CHAT_ID,
      body:
        "🌅 每日早报触发（9:00）。请 Task 派 news-agent 拿 5 个 GitHub Trending + 4 主题精选项目，" +
        "拿到 sub-agent 返回的 items JSON 后调 send_daily_news_card({chat_id, items}) tool 把内容用卡片形式推送到群里，" +
        "并把已推送 URL 记到 vault\\品品work\\早报\\已推送.md。",
    });
  });
}
