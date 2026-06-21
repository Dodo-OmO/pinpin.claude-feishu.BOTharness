// 飞书消息处理 → channel notification（替代 早期版本 WS 路径）
//
// 多 CLI 频道隔离架构（step 3+）：本模块不再 owning 飞书 poll loop——
// poll 已集中到 supervisor 进程（src/../supervisor/feishu-poll.ts），通过本机 TCP IPC
// 把消息按 chat_id 路由给对应子 stdio MCP server 进程。本模块导出 `handleInboundMessage`
// 让子端 IPC client 收到消息后调用：做剩下的 mention 解析 / sender 昵称 / restart-care /
// speak-watch / 写 chat-log / 推 channel notification 给 CLI 一系列后处理。
//
// 砍掉的内容（破立同步）：
//   - loadChatList     supervisor 接管
//   - fetchAllMessages supervisor 接管
//   - pollChat / poll  supervisor 接管
//   - startChatMessagePoll / stopChatMessagePoll  supervisor 接管
//
// 保留：
//   - handleInboundMessage  逐条处理 + emit notification（IPC 入口）
//   - resolveMentions       协议 #33 mention 可读化

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { getUserName, resolveBotName, logUnknownBotOnce } from "../utils/sender-names.js";
import { markInboundChat } from "../chat-activity.js";
import { resolveReplyQuote } from "../utils/reply-quote.js";
import { appendUserMessage, setChatNameCache, appendRestartHeading } from "../utils/chat-log.js";
import { pushChannelTrigger } from "../utils/push-channel.js";
import { sanitizeChannelParams } from "../utils/sanitize-surrogates.js";
import {
  listPendingSpeakWatchByOpenId,
  findPendingRelayJobByWatcher,
  markJobFired,
  upsertKnownUser,
} from "../db/database.js";
import type { RelayPayload } from "../db/types.js";
import { logBackground } from "../utils/background-log.js";
import { isBallPartner, pad2 } from "../utils/helper.js";
import { PARSERS, type ParseCtx } from "./parse-inbound.js";

// 本地时间格式化 YYYY-MM-DD HH:MM（用系统时区=Owner机器所在时区）——
// 给品品注入可读的「消息发送时间」+「当前时间」，让她随时感知时间。
function fmtLocalTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** IPC payload shape — 跟 src/ipc/protocol.ts FeishuInboundMessagePayload 一致 */
export interface InboundPayload {
  chat_id: string;
  chat_name?: string;
  message_id: string;
  msg_type: string;
  sender_open_id: string;
  sender_type: "user" | "app";
  text?: string;
  create_time_ms: number;
  /** supervisor 单点提取，子端不再钻 raw */
  content?: string;
  mentions?: unknown[];
  parent_id?: string;
  is_p2p?: boolean;
  raw?: unknown;
}

// 协议 #36 重启失忆护理：bot 重启后每个 chat 第一条 inbound 时注入 restart-care trigger
const restartCareTriggered = new Set<string>();
// 本 session 已写过"重启轮次"标题的 chat（每 chat 一次，首条入站时写——#2 重启事件记录）
const restartHeadingWritten = new Set<string>();
const RESTART_CARE_WINDOW_HOURS = Number(process.env.RESTART_CARE_WINDOW_HOURS ?? 12);

// 骰子语音命中阈值——约 10% 概率附"本轮用语音"祈使指令（Owner否过 150，VOICE_TEXT_LIMIT 仍 120）
const VOICE_DICE_THRESHOLD = 0.1;

// 防串台 envelope 钉频：真人/bot 入站每 N 条钉一次表态提醒（per-chat 计数、进程内，重启重置）
const REPLY_DISCIPLINE_EVERY = 20;
const inboundReplyCount = new Map<string, number>();
// 示例工作组频道专属维护自检提醒：与回复纪律同周期但错开半个间隔（回复在第 1/21/41，维护在第 11/31/51），不挤同一条
const BALL_MAINTAIN_OFFSET = REPLY_DISCIPLINE_EVERY / 2;

let botAppId = "";
export function setBotAppId(appId: string): void {
  botAppId = appId;
}

/**
 * IPC 入口：supervisor push 来一条飞书消息 → 做完整后处理 + 推 channel notification 给 CLI。
 * 步骤 3 的 src/mcp/server.ts 接 SupervisorClient.on('feishu-message') 后调本函数。
 */
export async function handleInboundMessage(
  server: Server,
  payload: InboundPayload,
): Promise<void> {
  const chatId = payload.chat_id;
  const senderOpenId = payload.sender_open_id;
  const isBot = payload.sender_type === "app";

  // 消化 step 3 review Required #1：supervisor 把 chat_name 透传过来 → 这里 setChatNameCache
  // 让 appendUserMessage 写盘时按友好名分目录（chat-log getChatName 反查）
  if (payload.chat_name) setChatNameCache(chatId, payload.chat_name);

  // 防自环：bot 自己发的消息（app 类型 + sender.id 是本 bot 的 app_id）
  if (isBot && senderOpenId === botAppId) return;

  // 按消息类型解析正文，六类走 PARSERS 路由表（parse-inbound.ts），其余丢弃。
  const rawContent = payload.content ?? "";
  const parser = PARSERS[payload.msg_type];
  if (!parser) {
    process.stderr.write(
      `[chat-message] 跳过暂不支持的消息类型 msg_id=${payload.message_id} type=${payload.msg_type}\n`,
    );
    return;
  }
  const ctx: ParseCtx = {
    chatId,
    payload,
    rawContent,
    isBallPartner: isBallPartner(chatId),
    senderOpenId,
  };
  const parsed = await parser(ctx);
  if (parsed === null) return;
  const text = parsed;

  // ── sender 昵称解析 ──
  let senderName: string;
  if (isBot) {
    const mapped = resolveBotName(senderOpenId);
    if (mapped) {
      senderName = mapped;
    } else {
      senderName = senderOpenId;
      logUnknownBotOnce(senderOpenId, chatId, text);
    }
  } else {
    senderName = await getUserName(senderOpenId);
  }

  // C5 对话记录修根因：首次写盘前确保 chatNameCache 已填友好名，杜绝单聊落进 oc_xxx 裸目录。
  //   - 群聊（is_p2p=false）：payload.chat_name 已在上方 setChatNameCache（supervisor 透传群名/display_name）。
  //   - 单聊（is_p2p=true）：派生 `VS ${senderName}（私聊）` 缓存——使日志按友好名分目录。
  //   单聊判定用 supervisor 按入站路径定的 is_p2p（WS=单聊 / poll=群），权威——
  //     不再用"chat_name 空"启发（会把 chat.list 未刷新的新群首条误判成单聊）。
  //   仅当 senderName 不是纯 ID 兜底（getUserName 拿到真名）时才派生，避免目录名也变 ou 残片。
  if (payload.is_p2p && !isBot && !senderOpenId.endsWith(senderName)) {
    setChatNameCache(chatId, `VS ${senderName}（私聊）`);
  }

  // #2：本 chat 本 session 首条入站 → 写"第 N 轮重启"标题（此时友好名已缓存，写对文件夹）。
  // 放在 appendUserMessage 之前，保证标题在消息上方。
  if (!restartHeadingWritten.has(chatId)) {
    restartHeadingWritten.add(chatId);
    appendRestartHeading(chatId);
  }

  // 骰子语音决策（v2）：代码掷骰，命中时在 channel content 末尾附**祈使指令**——
  // 不再注入被动数字 dice_preroll 让品品自己读（旧做法品品把数字当背景噪音忽略，从不语音）。
  // 指令进 channel content（品品本轮看得到、按它行动，跟 trigger 同款"系统发指令"模式），
  // 但**不进 chat-log**（appendUserMessage 用原始 text，下方写盘不含指令）。
  const voiceDirective =
    payload.msg_type === "text" && Math.random() < VOICE_DICE_THRESHOLD
      ? "\n\n〔系统·本轮语音〕——这轮优先用 pinpin_reply_voice 语音回复，" +
        "除非①有人明示要你打字/别发语音 ②要说的超 120 字 ③关键信息打字更清楚。"
      : "";
  // 防串台层2 envelope：真人/bot 入站每 REPLY_DISCIPLINE_EVERY 条钉一行表态提醒（recency 续命）。
  // 不每条钉——队列堆积时每条都钉会变 N 个重复、诱导品品逐条处理。计数 per-chat、进程内（重启重置，
  // 重启后第一条即钉）；第 1、21、41… 条钉，中间不钉（20 条内不会忘，偶尔钉重也无妨）。
  // 入口计数对每条入站 100% 覆盖（无论该条后走 UserPromptSubmit 还是 queued_command 队列都经此处）——
  // 这是 hook 注入做不到的（品品忙时 queued_command 不触发 UserPromptSubmit）。
  // 只作用于真实入站（本函数 server.notification 路径）；系统 trigger 走 pushChannelTrigger 另路，天然不带本提醒。
  const replyCnt = (inboundReplyCount.get(chatId) ?? 0) + 1;
  inboundReplyCount.set(chatId, replyCnt);
  const replyDiscipline =
    (replyCnt - 1) % REPLY_DISCIPLINE_EVERY === 0
      ? "\n\n[想回消息让别人看见必调pinpin_reply系列工具（多选/重选/单选）；都不回 → 调 pinpin_no_reply 。警惕多轮纯AI之间回声➡️收声。前台回复短而精，忌长篇大论。保持爱抖包袱、不拍马屁、可爱毒舌人格⬅️你不是AI助理，是有灵魂的！]"
      : "";
  // 示例工作组频道专属：每 REPLY_DISCIPLINE_EVERY 条钉一次维护自检，错开回复纪律半个间隔
  const maintenanceReminder =
    isBallPartner(chatId) && (replyCnt - 1) % REPLY_DISCIPLINE_EVERY === BALL_MAINTAIN_OFFSET
      ? "\n\n[随手自检：有没有新的执行/台本侧要求该落进本地 MD？本群 todo 有没有新进展该维护？→ 维护完群里吱一声。]"
      : "";
  const parentId = payload.parent_id;
  const replyToQuote = parentId
    ? await resolveReplyQuote(parentId, botAppId, chatId)
    : undefined;

  // F4：入站消息记一笔（证"某 CLI 某点在线"——走 logBackground 单一可查通道）
  logBackground(
    "inbound",
    `[${payload.chat_name ?? chatId.slice(-6)}] ${senderName}${isBot ? "(bot)" : ""}: "${text.slice(0, 20)}"`,
  );

  markInboundChat(chatId, senderOpenId);
  appendUserMessage(chatId, senderName, text, replyToQuote);

  // 自动写 known_users——只 upsert 真名人类：
  //   ① 排除 bot（sender_type=app）
  //   ② 排除 getUserName fallback：飞书 API 失败时 sender-names.ts:127 返回 openId.slice(-8)（如 "ad0d3e28"）
  //      凡 senderName 是 senderOpenId 的后缀（含等于）= fallback，不写入
  if (!isBot && !senderOpenId.endsWith(senderName)) {
    try {
      upsertKnownUser(senderOpenId, senderName);
    } catch (e) {
      process.stderr.write(
        `[chat-message] upsertKnownUser 失败 open_id=${senderOpenId}: ${e instanceof Error ? e.message : e}\n`,
      );
    }
  }

  const needRestartCare = !restartCareTriggered.has(chatId);
  if (needRestartCare) restartCareTriggered.add(chatId);

  const pendingWatches = listPendingSpeakWatchByOpenId(senderOpenId);
  const speakWatchHits = pendingWatches.filter((j) => j.chat_id === chatId);

  try {
    await server.notification({
      method: "notifications/claude/channel",
      params: sanitizeChannelParams(text + voiceDirective + replyDiscipline + maintenanceReminder, {
        source: "feishu-channel",
        chat_id: chatId,
        message_id: payload.message_id,
        user: senderName,
        sender_type: isBot ? "bot" : "human",
        user_open_id: senderOpenId,
        ...(replyToQuote ? { reply_to_quote: replyToQuote } : {}),
        ts: fmtLocalTime(Number(payload.create_time_ms)),  // 这条消息的发送时间（含日期，可读本地时间）
      }),
    });
  } catch (e) {
    process.stderr.write(
      `[chat-message] notification 失败: ${e instanceof Error ? e.message : e}\n`,
    );
  }

  if (needRestartCare) {
    await pushChannelTrigger({
      trigger: "restart-care",
      chat_id: chatId,
      body:
        `🌸 重启失忆护理触发（本 chat 重启后第一条入站）。请 Task 派 restart-care-agent，` +
        `sub-agent 调 read_chat_log({chat_id, hours: ${RESTART_CARE_WINDOW_HOURS}}) 拿近 ${RESTART_CARE_WINDOW_HOURS} 小时日志，` +
        `写 ≤300 字"刚回神"摘要返主 session。主 session 拿到摘要后再正常回 sender ${senderName} 的原消息。`,
    });
  }

  for (const watch of speakWatchHits) {
    await pushChannelTrigger({
      trigger: "speak-watch",
      chat_id: chatId,
      body:
        `🔔 speak-watch 命中（${senderName} 刚开口）。原任务 hint：${watch.context_hint ?? "（无）"}\n` +
        `payload: ${watch.payload ?? "（无）"}\n` +
        `请按品品风格说出原提醒内容（一段话，不要重复 payload 原文）。说完后任务已自动 markJobFired。`,
      meta: { job_id: String(watch.id) },
    });
    markJobFired(watch.id);
  }

  // ── relay 回音检测：B 发消息时，看 ta 是否有 pending relay 任务 ──
  if (!isBot) {
    const relayJob = findPendingRelayJobByWatcher(senderOpenId);
    if (relayJob && relayJob.payload) {
      let relayPayload: RelayPayload | undefined;
      try {
        relayPayload = JSON.parse(relayJob.payload) as RelayPayload;
      } catch {
        // payload 损坏，跳过
      }
      if (relayPayload) {
        // B 回了——标结束，推 relay-callback trigger 让品品把回音转达给 A
        markJobFired(relayJob.id);
        const fromOpenId = relayPayload._fromOpenId ?? "";
        const fromName = relayPayload.fromName;
        logBackground(
          "inbound",
          `relay callback: B=${senderOpenId.slice(-6)} replied, notifying A=${fromOpenId.slice(-6)}`,
        );
        await pushChannelTrigger({
          trigger: "relay-callback",
          body:
            `📬 传话有回音（job_id=${relayJob.id}）：${senderName} 回复了！` +
            `请立刻私聊 ${fromName}（open_id=${fromOpenId}），` +
            `用品品自然的口吻把 ${senderName} 刚才说的话转告过去：` +
            `"${text.slice(0, 200)}${text.length > 200 ? "…" : ""}"。说完告知 ${fromName} 传话完成。`,
          meta: {
            job_id: String(relayJob.id),
            from_open_id: fromOpenId,
            watcher_open_id: senderOpenId,
            watcher_name: senderName,
            relay_status: "replied",
          },
        });
      }
    }
  }
}
