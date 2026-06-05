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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getUserName, resolveBotName, logUnknownBotOnce } from "../utils/sender-names.js";
import { markInboundChat } from "../chat-activity.js";
import { resolveReplyQuote } from "../utils/reply-quote.js";
import { appendUserMessage, setChatNameCache, appendRestartHeading } from "../utils/chat-log.js";
import { pushChannelTrigger } from "../utils/push-channel.js";
import {
  listPendingSpeakWatchByOpenId,
  findPendingRelayJobByWatcher,
  markJobFired,
  upsertKnownUser,
} from "../db/database.js";
import type { RelayPayload } from "../db/types.js";
import { logBackground } from "../utils/background-log.js";
import { saveInboundImage, saveInboundFile } from "../utils/media-attachments.js";
import { isBallPartner } from "../utils/helper.js";
import { downloadMessageResource } from "../tools/feishu-send.js";
import { transcribeAudio } from "../utils/stt.js";

// 本地时间格式化 YYYY-MM-DD HH:MM（用系统时区=Owner机器所在时区）——
// 给品品注入可读的「消息发送时间」+「当前时间」，让她随时感知时间。
function fmtLocalTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface FeishuMention {
  key: string;
  // poll 路径 id 是 string；WSClient 事件路径 id 是 {open_id/user_id/union_id} 对象。
  // resolveMentions 只用 key+name 不碰 id，此处类型如实声明两形态即可。
  id: string | { open_id?: string; user_id?: string; union_id?: string };
  id_type?: string;
  name: string;
  tenant_key?: string;
}

interface FeishuRawMessage {
  message_id: string;
  msg_type: string;
  create_time: string;
  parent_id?: string;
  sender: { id: string; id_type: string; sender_type: string };
  body: { content: string };
  mentions?: FeishuMention[];
  deleted?: boolean;
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

/** text 消息的 body.content 是 JSON 字符串 {"text": "..."}——解析失败留空 */
function parseTextContent(raw: string): string {
  try {
    return (JSON.parse(raw ?? "{}") as { text?: string }).text ?? "";
  } catch {
    return "";
  }
}

/** 协议 #33：mention 可读化——把 text 里的 @_user_N 占位符替换为 @<真实姓名> */
function resolveMentions(text: string, mentions: FeishuMention[] | undefined): string {
  if (!text || !mentions || mentions.length === 0) return text;
  let out = text;
  for (const m of mentions) {
    if (!m.key || !m.name) continue;
    out = out.split(m.key).join(`@${m.name}`);
  }
  return out;
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

  // #2：本 chat 本 session 首条入站 → 先写"第 N 轮重启"标题（此时 chat_name 已缓存，写对文件夹）。
  // 放在 appendUserMessage 之前，保证标题在消息上方。
  if (!restartHeadingWritten.has(chatId)) {
    restartHeadingWritten.add(chatId);
    appendRestartHeading(chatId);
  }

  // 按消息类型解析正文：
  //   text  → 直取（含 mention 可读化）
  //   image → 下载 + sharp 压缩存盘 → 注入"图片附件 + 本地路径"（品品可 Read 看，已压缩省 token）
  //   file  → 下载存盘 → 注入"已备份未读 + 本地路径"（默认不读，需要时再 Read）
  //   其它（audio/post/sticker 等）→ 跳过（voice STT 不在 D 范围）
  const raw = payload.raw as FeishuRawMessage | undefined;
  // 入站 raw 两种形态：poll 路径=message.list item（内容在 body.content）；
  // WSClient/P2P 路径=飞书 v2 事件体——SDK EventDispatcher.parse 把 header/event 字段摊平到顶层
  // （Object.assign({}, rest, header, event)），所以内容在 raw.message.content，无 .event 这层。
  // 文字消息靠 payload.text 兜底两种都行，但图片/文件的 image_key/file_key 只能从 content JSON 取，
  // 故必须同时认这两种形态——否则 P2P 单聊发的图/文件 image_key 取不到被丢弃。
  const wsContent = (payload.raw as { message?: { content?: string } } | undefined)
    ?.message?.content;
  const rawContent = raw?.body?.content ?? wsContent ?? "";
  let text: string;
  if (payload.msg_type === "text") {
    const rawText = parseTextContent(rawContent) || payload.text || "";
    if (!rawText) return;
    // mentions 两种形态：poll 路径在 raw.mentions（顶层），WSClient 路径在 raw.message.mentions
    // （SDK EventDispatcher.parse 把 header/event 摊平到顶层，event.message 变成 raw.message，
    //  event.message.mentions 变成 raw.message.mentions，不在 raw.mentions）
    const mentions =
      raw?.mentions ??
      (raw as { message?: { mentions?: FeishuMention[] } } | undefined)?.message?.mentions;
    text = resolveMentions(rawText, mentions);
  } else if (payload.msg_type === "image") {
    try {
      const imageKey = (JSON.parse(rawContent || "{}") as { image_key?: string }).image_key;
      if (!imageKey) return;
      const localPath = await saveInboundImage(payload.message_id, imageKey, chatId);
      text = isBallPartner(chatId)
        ? `[图片] 有人发了图片，已存本地原图——**这轮先用 Read 工具读这张图、看清内容再回应**：${localPath}`
        : `[图片] 有人发了图片，已压缩存本地——**这轮先用 Read 工具读这张图、看清内容再回应**：${localPath}`;
    } catch (e) {
      process.stderr.write(
        `[chat-message] 图片处理失败 msg_id=${payload.message_id}: ${e instanceof Error ? e.message : e}\n`,
      );
      return;
    }
  } else if (payload.msg_type === "file") {
    try {
      const parsed = JSON.parse(rawContent || "{}") as { file_key?: string; file_name?: string };
      if (!parsed.file_key) return;
      const localPath = await saveInboundFile(payload.message_id, parsed.file_key, parsed.file_name ?? "file", chatId);
      text = isBallPartner(chatId)
        ? `[文件附件「${parsed.file_name ?? "未命名"}」] 已存本地——需要看内容就用 read_attachment 工具读（xlsx/docx 都能读），或 Read：${localPath}`
        : `[文件附件「${parsed.file_name ?? "未命名"}」] 已备份到本地，默认不读——需要时再 Read：${localPath}`;
    } catch (e) {
      process.stderr.write(
        `[chat-message] 文件处理失败 msg_id=${payload.message_id}: ${e instanceof Error ? e.message : e}\n`,
      );
      return;
    }
  } else if (payload.msg_type === "audio") {
    // 飞书语音消息：下载 OGG Opus → ElevenLabs Scribe v2 转写 → 注入 [语音] 前缀文字
    const parsed = JSON.parse(rawContent || "{}") as { file_key?: string };
    if (!parsed.file_key) {
      // audio 消息但拿不到 file_key，回退到错误引导
      text = "[语音转写失败] 收到一条语音但找不到音频附件，可请对方打字发送";
    } else {
      // 下载到临时文件 → 读 buffer → 转写 → 删临时文件
      const tmpPath = path.join(os.tmpdir(), `pinpin_audio_${payload.message_id}.ogg`);
      try {
        // 飞书语音附件走 "file" 类型下载——messageResource.get 的 type 只认 "image"|"file"，
        // 传 "audio" 会下载失败/拿到坏数据（SDK 退役版踩过的坑，注释留此防再犯）。
        await downloadMessageResource(payload.message_id, parsed.file_key, "file", tmpPath);
        const audioBuffer = fs.readFileSync(tmpPath);
        const transcribed = await transcribeAudio(audioBuffer, "audio.ogg");
        if (transcribed.trim()) {
          text = `[语音] ${transcribed.trim()}`;
        } else {
          text = "[语音转写失败] 收到一条语音没听清内容，可请对方打字";
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[chat-message] 语音转写失败 msg_id=${payload.message_id}: ${detail}\n`);
        // 落 background log 便于排查（stderr 不进可查日志）——真实报错(statusCode/网络等)看这里
        logBackground("stt-error", `语音转写失败 [${chatId.slice(-6)}]: ${detail.slice(0, 200)}`);
        text = "[语音转写失败] 收到一条语音没听清，可请对方打字";
      } finally {
        try {
          fs.rmSync(tmpPath, { force: true });
        } catch {
          /* 删临时文件失败不影响主流程 */
        }
      }
    }
  } else if (payload.msg_type === "post") {
    // 飞书富文本（post）= 图文混合消息，同一条含文字段落 + 可选图片。
    // 图片来源优先级（双保险）：
    //   ① _sdk_resources（feishu-event-subscriber 从 SDK NormalizedMessage.resources 注入，
    //      WSClient 路径专有；SDK convertPost 已正确提取内嵌图片 key 进此数组）
    //   ② rawContent 手动解析（poll 路径 raw.body.content / WSClient 路径 raw.message.content；
    //      解析 post JSON 遍历 tag='img' 元素提取 image_key）
    // 文字提取走 rawContent 手动解析（优先），fallback SDK 归一化 payload.text。
    // 结构：{"zh_cn":{"title":"...","content":[[{"tag":"text","text":"..."},{"tag":"img","image_key":"..."},...],...]}}
    let parsed = "";
    try {
      // ── 文字提取（rawContent 手动解析）──
      const postJson = JSON.parse(rawContent || "{}") as {
        [locale: string]: {
          title?: string;
          content?: Array<Array<{ tag: string; text?: string; image_key?: string; href?: string }>>;
        };
      };
      // 取第一个 locale（zh_cn 优先，否则取第一个）
      const localeKeys = Object.keys(postJson);
      const body = postJson["zh_cn"] ?? (localeKeys.length > 0 ? postJson[localeKeys[0]] : undefined);

      // ── 图片 key 提取（双保险）──
      // ① 优先用 SDK 已解析的 _sdk_resources（WSClient 路径，最可靠）
      const sdkResources = (payload.raw as { _sdk_resources?: Array<{ type: string; fileKey: string }> } | undefined)
        ?._sdk_resources;
      const sdkImageKeys: string[] = (sdkResources ?? [])
        .filter((r) => r.type === "image")
        .map((r) => r.fileKey);

      if (body) {
        const parts: string[] = [];
        if (body.title) parts.push(`**${body.title}**`);
        const jsonImageKeys: string[] = [];
        for (const para of body.content ?? []) {
          if (!Array.isArray(para)) continue;
          let line = "";
          for (const el of para) {
            if (el.tag === "text") {
              line += el.text ?? "";
            } else if (el.tag === "a") {
              line += el.text ?? el.href ?? "";
            } else if (el.tag === "img" && el.image_key) {
              jsonImageKeys.push(el.image_key);
            }
          }
          if (line.trim()) parts.push(line);
        }
        // ② rawContent 解析补充（poll 路径 + WSClient 兜底）
        // 合并两来源，去重（两路径都有时避免重复下载）
        const allImageKeys = [...new Set([...sdkImageKeys, ...jsonImageKeys])];
        process.stderr.write(
          `[chat-message] post msg_id=${payload.message_id} rawContent_len=${rawContent.length} sdk_imgs=${sdkImageKeys.length} json_imgs=${jsonImageKeys.length} total=${allImageKeys.length}\n`,
        );
        // 下载 post 内嵌图片（复用现有 saveInboundImage 逻辑）
        const imagePaths: string[] = [];
        for (const imgKey of allImageKeys) {
          try {
            imagePaths.push(await saveInboundImage(payload.message_id, imgKey, chatId));
          } catch (imgErr) {
            process.stderr.write(
              `[chat-message] post 内嵌图片下载失败 key=${imgKey}: ${imgErr instanceof Error ? imgErr.message : imgErr}\n`,
            );
          }
        }
        if (imagePaths.length > 0) {
          parts.push(`[图片×${imagePaths.length}] 已存本地，用 Read 工具查看：${imagePaths.join(" | ")}`);
        }
        parsed = parts.join("\n").trim();
      } else if (sdkImageKeys.length > 0) {
        // rawContent 解析不出 body（JSON 结构异常），但 SDK resources 里有图片——纯图 post 兜底
        process.stderr.write(
          `[chat-message] post body 解析失败但 SDK resources 有 ${sdkImageKeys.length} 张图，尝试下载\n`,
        );
        const imagePaths: string[] = [];
        for (const imgKey of sdkImageKeys) {
          try {
            imagePaths.push(await saveInboundImage(payload.message_id, imgKey, chatId));
          } catch (imgErr) {
            process.stderr.write(
              `[chat-message] post 内嵌图片下载失败 key=${imgKey}: ${imgErr instanceof Error ? imgErr.message : imgErr}\n`,
            );
          }
        }
        if (imagePaths.length > 0) {
          parsed = `[图片×${imagePaths.length}] 已存本地，用 Read 工具查看：${imagePaths.join(" | ")}`;
        }
      }
    } catch (e) {
      process.stderr.write(
        `[chat-message] post 解析失败 msg_id=${payload.message_id}: ${e instanceof Error ? e.message : e}\n`,
      );
    }
    // rawContent 解析出内容优先；解析不出再 fallback SDK 归一化的 payload.text；都没有给兜底（不 DROP）
    text = parsed || payload.text || "[富文本] 收到一条富文本消息（内容解析失败）";
  } else if (payload.msg_type === "interactive") {
    // 飞书卡片（interactive）。
    // WSClient 路径：SDK normalize 的 convertInteractive 已提取卡片文本，填入 payload.text。
    // poll 路径：payload.text = undefined；卡片 JSON 结构复杂不在此深解析，给可读兜底提示。
    if (payload.text) {
      // WSClient 路径：SDK 已归一化
      text = payload.text;
    } else {
      // poll 路径兜底（卡片内容以 WSClient 实时推送为主，poll 补漏时通知品品有卡片即可）
      text = "[卡片消息] 收到一张飞书卡片（内容通过实时推送读取，此为 poll 补漏提示）";
    }
  } else {
    process.stderr.write(
      `[chat-message] 跳过暂不支持的消息类型 msg_id=${payload.message_id} type=${payload.msg_type}\n`,
    );
    return;
  }

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
      ? "\n\n[开启每轮新消息回应时，可直接打 text 当内思锚点（用户看不到）。每轮至少调一个表态工具：要回 → pinpin_reply_text / pinpin_reply_voice / pinpin_react（支持多选/重选/单选）；都不回 → 调 pinpin_no_reply 。]"
      : "";
  // 示例工作组频道专属：每 REPLY_DISCIPLINE_EVERY 条钉一次维护自检，错开回复纪律半个间隔
  const maintenanceReminder =
    isBallPartner(chatId) && (replyCnt - 1) % REPLY_DISCIPLINE_EVERY === BALL_MAINTAIN_OFFSET
      ? "\n\n[随手自检：有没有新的执行/台本侧要求该落进本地 MD？本群 todo 有没有新进展该维护？→ 维护完群里吱一声。]"
      : "";
  // parent_id 两种形态：poll 路径在 raw.parent_id（顶层），WSClient 路径在 raw.message.parent_id
  const parentId =
    raw?.parent_id ??
    (raw as { message?: { parent_id?: string } } | undefined)?.message?.parent_id;
  const replyToQuote = parentId
    ? await resolveReplyQuote(parentId, botAppId)
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
      params: {
        content: text + voiceDirective + replyDiscipline + maintenanceReminder,
        meta: {
          source: "feishu-channel",
          chat_id: chatId,
          message_id: payload.message_id,
          user: senderName,
          sender_type: isBot ? "bot" : "human",
          user_open_id: senderOpenId,
          ...(replyToQuote ? { reply_to_quote: replyToQuote } : {}),
          ts: fmtLocalTime(Number(payload.create_time_ms)),  // 这条消息的发送时间（含日期，可读本地时间）
        },
      },
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
