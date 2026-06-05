// 示例工作群每日任务提醒 cron：每天 10:00 / 21:00 推 trigger，
// 让品品盘点《每日安排》云文档未完成待办、在群里 @所有人 提醒。只在示例工作组 CLI 注册（isOwnerOfCron 兜底防多进程重复）。

import { registerCron } from "./registry.js";
import { pushChannelTrigger } from "../utils/push-channel.js";
import { isOwnerOfCron } from "./cron-owner.js";

const BALL_CHAT = process.env.BALL_PARTNER_CHAT_ID ?? "";

const SLOTS: { h: number; label: string }[] = [
  { h: 10, label: "上午 10 点" },
  { h: 21, label: "晚上 9 点" },
];

if (isOwnerOfCron("ballpartner")) {
  for (const { h, label } of SLOTS) {
    registerCron(`ball-tasks-${h}`, { kind: "daily", h, m: 0 }, async () => {
      if (!BALL_CHAT) return;
      await pushChannelTrigger({
        trigger: "ball-tasks-reminder",
        chat_id: BALL_CHAT,
        body:
          `⏰ 示例工作组任务提醒（${label}）。调 read_doc_todos 读《每日安排》云文档（doc_token 见本群必读规则）盘点未完成待办（done=false），` +
          `在群里 @所有人（文本写 <at user_id="all">所有人</at>）列出今天还没做完的任务并催一下；` +
          `若全做完了就报喜一句，别空喊。`,
      });
    });
  }
}
