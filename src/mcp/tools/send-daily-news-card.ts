// send_daily_news_card tool（MCP 版）
// 阶段 4 批次 2 步骤 2.1：主 session 拿 news-agent 返的 items 调本 tool，推卡片到群 + 写已推送.md
// **阶段 4 MVP**：用 text 消息推（不上飞书 interactive 卡片，卡片化阶段后续做 TODO）
// 阶段 5+ 升级路径：build daily-news-card.ts 飞书 card json + im.v1.message.create(msg_type: "interactive")

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { sendText } from "./feishu-send.js";
import { dateYYYYMMDD, getVaultRoot } from "../utils/helper.js";

const PUSHED_FILE = path.join(getVaultRoot(), "品品work", "早报", "已推送.md");

interface NewsItem {
  url: string;
  title: string;
  why?: string; // 一句话推荐理由
}

export const sendDailyNewsCardTool: Tool = {
  name: "send_daily_news_card",
  description:
    "推每日 GitHub 早报到指定 chat。items 是 news-agent 返的项目列表（url + title + 一句话推荐理由）。" +
    "本 tool 同时把推送过的 URL 写入 vault\\品品work\\早报\\已推送.md 供 30 天去重。",
  inputSchema: {
    type: "object",
    properties: {
      chat_id: { type: "string", description: "目标 chat_id" },
      items: {
        type: "array",
        description: "项目列表（每项含 url / title / why）",
        items: { type: "object" },
      },
    },
    required: ["chat_id", "items"],
  },
};

export async function handleSendDailyNewsCard(args: { chat_id: string; items: NewsItem[] }) {
  const { chat_id, items } = args;
  if (!items || items.length === 0) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ skipped: true, reason: "今日 items 为空，静默跳过" }) }],
    };
  }
  // MVP text 格式
  const today = dateYYYYMMDD();
  const lines = [`🌅 ${today} GitHub 精选 (${items.length} 项)`, ""];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    lines.push(`${i + 1}. ${it.title}`);
    lines.push(`   ${it.url}`);
    if (it.why) lines.push(`   💡 ${it.why}`);
    lines.push("");
  }
  const text = lines.join("\n");

  try {
    await sendText(chat_id, text);
    // 落已推送.md 供 30 天去重（写盘失败仅 stderr 留痕，不影响 delivered 状态）
    let dedupWriteFailed = false;
    try {
      const pushedDir = path.dirname(PUSHED_FILE);
      if (!fs.existsSync(pushedDir)) fs.mkdirSync(pushedDir, { recursive: true });
      const appendLines = items.map((it) => `${today} ${it.url}`).join("\n") + "\n";
      fs.appendFileSync(PUSHED_FILE, appendLines, "utf-8");
    } catch (writeErr) {
      dedupWriteFailed = true;
      process.stderr.write(`[send-daily-news-card] 已推送.md 写盘失败: ${writeErr instanceof Error ? writeErr.message : writeErr}\n`);
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ delivered: true, count: items.length, ...(dedupWriteFailed ? { dedup_write_failed: true } : {}) }) }],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `推早报失败：${msg}` }] };
  }
}
