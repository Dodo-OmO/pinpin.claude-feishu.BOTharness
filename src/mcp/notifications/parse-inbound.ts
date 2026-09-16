// 入站消息类型分支解析器——A3 重构产物。
// 从 handleInboundMessage 抽出六类消息解析逻辑，零行为变化（日志/路径/文案逐字不变）。
// chat-message.ts 主干通过 PARSERS 路由表调用，返回 null 表示丢弃。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FeishuInboundMessagePayload } from "../../ipc/protocol.js";
import { resolveMentions } from "../../shared/sender-shared.js";
import { saveInboundImage, saveInboundFile } from "../utils/media-attachments.js";
import { setPendingSaveFile } from "../utils/save-target.js";
import { downloadMessageResource, getFeishuClient } from "../tools/feishu-send.js";
import { transcribeAudio } from "../utils/stt.js";
import { logBackground } from "../utils/background-log.js";
import { getUserName, resolveBotName } from "../utils/sender-names.js";
import { getKnownUserName } from "../db/database.js";
import { pad2 } from "../utils/helper.js";

// ── ParseCtx 契约（定死不许改）──

export interface ParseCtx {
  chatId: string;
  payload: FeishuInboundMessagePayload;
  rawContent: string;
  senderOpenId: string;
}

export type Parser = (ctx: ParseCtx) => Promise<string | null>;

// ── 内部解析 helpers（从 chat-message.ts 移入）──

interface FeishuMention {
  key: string;
  id: string | { open_id?: string; user_id?: string; union_id?: string };
  id_type?: string;
  name: string;
  tenant_key?: string;
}

/** text 消息的 body.content 是 JSON 字符串 {"text": "..."}——解析失败留空 */
function parseTextContent(raw: string): string {
  try {
    return (JSON.parse(raw ?? "{}") as { text?: string }).text ?? "";
  } catch {
    return "";
  }
}

/** 拼接卡片一个段落/元素的可读文字（同段落元素不换行，text 内 \n 自带换行） */
function cardLineText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) return node.map(cardLineText).join("");
  if (typeof node !== "object") return "";
  const obj = node as Record<string, unknown>;
  const tag = obj.tag;
  if (tag === "text" || tag === "a") return typeof obj.text === "string" ? obj.text : "";
  if (tag === "plain_text" || tag === "lark_md" || tag === "md" || tag === "markdown") {
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.text === "string") return obj.text;
    return "";
  }
  if (tag === "hr") return "";
  if (tag === "img") {
    const alt = cardLineText(obj.alt).trim();
    return alt ? `[图：${alt}]` : "[图]";
  }
  // 卡片 2.0 表格：rows = 按列名键值的对象数组，每行 " | " 拼
  if (tag === "table" && Array.isArray(obj.rows)) {
    return (obj.rows as unknown[])
      .map((r) => (r && typeof r === "object" ? Object.values(r as Record<string, unknown>).map(cardLineText).join(" | ") : ""))
      .filter(Boolean)
      .join("\n");
  }
  // 容器（div / note / column_set / collapsible_panel / interactive_container / form / button…）：
  // 标题 + 自身 text + 子元素依次拼；1.0 段落内联数组走上面 Array 分支无缝拼接
  const parts: string[] = [];
  if (obj.header && typeof obj.header === "object") parts.push(cardLineText((obj.header as Record<string, unknown>).title));
  if (obj.text && typeof obj.text === "object") parts.push(cardLineText(obj.text));
  const sep = tag === "note" ? "" : "\n"; // note = 同行内联小字（图标+时间+说明），保持飞书原生同行观感
  for (const key of ["elements", "fields", "columns"]) {
    if (Array.isArray(obj[key])) parts.push((obj[key] as unknown[]).map(cardLineText).filter((s) => s.trim()).join(sep));
  }
  return parts.filter((s) => s.trim()).join("\n");
}

/**
 * 飞书 interactive 卡片正文提取——发卡方多为 app/bot（走 poll，raw.body.content 含完整卡片 JSON）。
 * 真实结构：{title, elements:[[{tag:"text",text},{tag:"a",text,href},{tag:"hr"},{tag:"note",elements:[...]}]]}
 *   - 顶层 title / header.title 成行（加粗）；elements 二维数组：外层=段落、内层=同段落元素
 *   - 段落内元素拼接（text 字段自带 \n），段落间换行；递归覆盖 note/column 等嵌套容器
 * 注：SDK 的 convertInteractive/walkCard 只认 tag:plain_text+content 字段，认不出 tag:text+text 字段
 *     的卡片（飞书最常见发卡格式），故此处自解析。
 */
function extractCardText(rawContent: string): string {
  let card: Record<string, unknown>;
  try {
    card = JSON.parse(rawContent || "{}") as Record<string, unknown>;
  } catch {
    return "";
  }
  const lines: string[] = [];
  if (typeof card.title === "string" && card.title.trim()) lines.push(`**${card.title.trim()}**`);
  if (card.header && typeof card.header === "object") {
    const ht = cardLineText((card.header as Record<string, unknown>).title);
    if (ht.trim()) lines.push(`**${ht.trim()}**`);
  }
  // 1.0 元素在顶层 elements；2.0（schema:"2.0"）在 body.elements
  const elements = card.elements ?? (card.body as Record<string, unknown> | undefined)?.elements;
  if (Array.isArray(elements)) {
    for (const para of elements) {
      const line = cardLineText(para);
      if (line.trim()) lines.push(line);
    }
  } else if (elements) {
    const line = cardLineText(elements);
    if (line.trim()) lines.push(line);
  }
  return lines.join("\n").trim();
}

type PostBody = {
  title?: string;
  content?: Array<Array<{ tag: string; text?: string; image_key?: string; href?: string }>>;
};
/** post 剥壳（同飞书 SDK unwrapLocale）：扁平 {title,content}（poll 路径 / todo.summary）优先，否则取语言壳 zh_cn / 首个。 */
function unwrapPost(json: unknown): PostBody | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as Record<string, unknown>;
  if ("title" in o || "content" in o) return o as PostBody;
  return (o["zh_cn"] ?? Object.values(o)[0]) as PostBody | undefined;
}

// ── 六个 Parser 函数 ──

export async function parseText(ctx: ParseCtx): Promise<string | null> {
  const { payload, rawContent } = ctx;
  const rawText = parseTextContent(rawContent) || payload.text || "";
  if (!rawText) return null;
  const mentions = payload.mentions as FeishuMention[] | undefined;
  return resolveMentions(rawText, mentions);
}

export async function parseImage(ctx: ParseCtx): Promise<string | null> {
  const { payload, rawContent } = ctx;
  try {
    const imageKey = (JSON.parse(rawContent || "{}") as { image_key?: string }).image_key;
    if (!imageKey) return null;
    const localPath = await saveInboundImage(payload.message_id, imageKey);
    return `[图片] 有人发了图片，原图已存本地——**这轮先用 Read 工具读这张图、看清内容再回应**：${localPath}`;
  } catch (e) {
    process.stderr.write(
      `[chat-message] 图片处理失败 msg_id=${payload.message_id}: ${e instanceof Error ? e.message : e}\n`,
    );
    return null;
  }
}

export async function parseFile(ctx: ParseCtx): Promise<string | null> {
  const { payload, rawContent, chatId, senderOpenId } = ctx;
  try {
    const parsed = JSON.parse(rawContent || "{}") as { file_key?: string; file_name?: string };
    if (!parsed.file_key) return null;
    // Owner（OWNER）自己发的文件默认不存——她常发自己本机已有的文件给别人，自动存档=冗余（2026-06-08 拍板）。
    // 但她明确要求时品品能存：记下文件句柄进待存槽位，她回复说"存下来"→ 品品调 pinpin_save_file 据此下载。
    // env 未配则 fail-safe 回落照旧存（避免误把所有人文件都跳过）。图片/语音不受此约束。
    const ownerOpenId = process.env.FEISHU_OWNER_OPEN_ID;
    if (ownerOpenId && senderOpenId === ownerOpenId) {
      setPendingSaveFile(chatId, {
        fileMessageId: payload.message_id,
        fileKey: parsed.file_key,
        fileName: parsed.file_name ?? "file",
      });
      return `[文件附件「${parsed.file_name ?? "未命名"}」] 你发的文件默认没自动存（你本机通常已有）。要存进库就回复这条文件跟我说"存下来"，我用 pinpin_save_file 给你存。`;
    }
    const localPath = await saveInboundFile(payload.message_id, parsed.file_key, parsed.file_name ?? "file");
    return `[文件附件「${parsed.file_name ?? "未命名"}」] 已备份到本地，默认不读——要读：.xlsx/.docx/.csv 用 read_attachment 工具（Read 解析不了二进制），图片/PDF/文本用 Read：${localPath}`;
  } catch (e) {
    process.stderr.write(
      `[chat-message] 文件处理失败 msg_id=${payload.message_id}: ${e instanceof Error ? e.message : e}\n`,
    );
    return null;
  }
}

export async function parseAudio(ctx: ParseCtx): Promise<string | null> {
  const { payload, rawContent, chatId } = ctx;
  const parsed = JSON.parse(rawContent || "{}") as { file_key?: string };
  if (!parsed.file_key) {
    // audio 消息但拿不到 file_key，回退到错误引导
    return "[语音转写失败] 收到一条语音但找不到音频附件，可请对方打字发送";
  }
  // 下载到临时文件 → 读 buffer → 转写 → 删临时文件
  const tmpPath = path.join(os.tmpdir(), `pinpin_audio_${payload.message_id}.ogg`);
  try {
    // 飞书语音附件走 "file" 类型下载——messageResource.get 的 type 只认 "image"|"file"，
    // 传 "audio" 会下载失败/拿到坏数据（SDK 退役版踩过的坑，注释留此防再犯）。
    await downloadMessageResource(payload.message_id, parsed.file_key, "file", tmpPath);
    const audioBuffer = fs.readFileSync(tmpPath);
    const transcribed = await transcribeAudio(audioBuffer, "audio.ogg");
    if (transcribed.trim()) {
      return `[语音] ${transcribed.trim()}`;
    }
    return "[语音转写失败] 收到一条语音没听清内容，可请对方打字";
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[chat-message] 语音转写失败 msg_id=${payload.message_id}: ${detail}\n`);
    // 落 background log 便于排查（stderr 不进可查日志）——真实报错(statusCode/网络等)看这里
    logBackground("stt-error", `语音转写失败 [${chatId.slice(-6)}]: ${detail.slice(0, 200)}`);
    return "[语音转写失败] 收到一条语音没听清，可请对方打字";
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* 删临时文件失败不影响主流程 */
    }
  }
}

export async function parsePost(ctx: ParseCtx): Promise<string | null> {
  const { payload, rawContent, chatId } = ctx;
  // 飞书富文本（post）= 图文混合消息，同一条含文字段落 + 可选图片。
  // 图片来源优先级（双保险）：
  //   ① _sdk_resources（feishu-event-subscriber 从 SDK NormalizedMessage.resources 注入，
  //      WSClient 路径专有；SDK convertPost 已正确提取内嵌图片 key 进此数组）
  //   ② rawContent 手动解析（poll 路径 raw.body.content / WSClient 路径 raw.message.content；
  //      解析 post JSON 遍历 tag='img' 元素提取 image_key）
  // 文字提取走 rawContent 手动解析（优先），fallback SDK 归一化 payload.text。
  // 结构两种形态（同飞书 SDK unwrapLocale）：
  //   扁平（poll 路径 im.v1.message.list/get，bot 消息唯一入口）：{"title":"...","content":[[{"tag":"text","text":"..."},{"tag":"img","image_key":"..."},...],...]}
  //   语言壳（事件推送）：{"zh_cn":{同上}}
  // 必须先判扁平：按语言壳取会把 "title" 键当 locale、body 变成标题字符串 → 一字提不出且不抛错（bot 富文本白板根因）。
  let parsed = "";
  try {
    // ── 文字提取（rawContent 手动解析）──
    const body = unwrapPost(JSON.parse(rawContent || "{}"));

    // ── 图片 key 提取（双保险）──
    // ① 优先用 SDK 已解析的 _sdk_resources（WSClient 路径，最可靠）
    const sdkResources = (payload.raw as { _sdk_resources?: Array<{ type: string; fileKey: string }> } | undefined)
      ?._sdk_resources;
    const sdkImageKeys: string[] = (sdkResources ?? [])
      .filter((r) => r.type === "image")
      .map((r) => r.fileKey);

    // ── 文字 textParts + 内嵌图片 jsonImageKeys（手动解析 rawContent）──
    const textParts: string[] = [];
    const jsonImageKeys: string[] = [];
    if (body) {
      if (body.title) textParts.push(`**${body.title}**`);
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
        if (line.trim()) textParts.push(line);
      }
    }
    // 文字兜底：手动解析没捞到任何文字时回落 SDK 归一化的 payload.text（去掉 ![image](key) 图片占位符）。
    // WSClient 实时路径 rawContent 解析不出 body 时，文字只剩这一份；poll 路径 payload.text 为空，真值守卫不误注入。
    if (textParts.length === 0 && payload.text) {
      const sdkText = payload.text
        .replace(/!\[image\]\([^)]*\)/g, "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .join("\n");
      if (sdkText) textParts.push(sdkText);
    }
    // 图片双保险：SDK resources + rawContent 手动解析，去重避免重复下载
    const allImageKeys = [...new Set([...sdkImageKeys, ...jsonImageKeys])];
    process.stderr.write(
      `[chat-message] post msg_id=${payload.message_id} rawContent_len=${rawContent.length} sdk_imgs=${sdkImageKeys.length} json_imgs=${jsonImageKeys.length} total=${allImageKeys.length} text=${textParts.length}\n`,
    );
    const imagePaths: string[] = [];
    for (const imgKey of allImageKeys) {
      try {
        imagePaths.push(await saveInboundImage(payload.message_id, imgKey));
      } catch (imgErr) {
        process.stderr.write(
          `[chat-message] post 内嵌图片下载失败 key=${imgKey}: ${imgErr instanceof Error ? imgErr.message : imgErr}\n`,
        );
      }
    }
    const parts = [...textParts];
    if (imagePaths.length > 0) {
      parts.push(`[图片×${imagePaths.length}] 原图已存本地，用 Read 工具查看：${imagePaths.join(" | ")}`);
    }
    parsed = parts.join("\n").trim();
  } catch (e) {
    process.stderr.write(
      `[chat-message] post 解析失败 msg_id=${payload.message_id}: ${e instanceof Error ? e.message : e}\n`,
    );
  }
  // rawContent 解析出内容优先；解析不出再 fallback SDK 归一化的 payload.text；都没有给兜底（不 DROP）
  return parsed || payload.text || "[富文本] 收到一条富文本消息（内容解析失败）";
}

export async function parseInteractive(ctx: ParseCtx): Promise<string | null> {
  const { payload, rawContent } = ctx;
  // 飞书卡片（interactive）。发卡方多为 app/bot（走 poll，rawContent=raw.body.content 含完整卡片 JSON）。
  // 自解析卡片正文（SDK walkCard 认不出 tag:text 结构）；解析不出再 fallback payload.text / 兜底，不 DROP。
  const cardText = extractCardText(rawContent);
  return cardText || payload.text || "[卡片消息] 收到一张卡片（内容解析失败）";
}

// ── 其余类型：可读标签，让品品至少知道来了什么（system 系统提示不入，仍丢弃）──

const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** 秒级时间戳 → `YYYY-MM-DD HH:mm`（同 chat-message fmtLocalTime 风格），非法返回空。 */
const fmtTs = (v: unknown, prefix: string): string => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${prefix}${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const label =
  (fn: (c: Record<string, unknown>) => string): Parser =>
  async ({ rawContent }) => {
    try {
      return fn(JSON.parse(rawContent || "{}") as Record<string, unknown>);
    } catch {
      return fn({});
    }
  };
const calendarLabel = label((c) => `[日程] ${str(c.summary)}${fmtTs(c.start_time, " ")}${fmtTs(c.end_time, " ~ ")}`);

/** 视频：本体不下载，封面缩略图存本地供 Read。 */
export async function parseMedia(ctx: ParseCtx): Promise<string | null> {
  const { payload, rawContent } = ctx;
  let c: { file_name?: string; image_key?: string } = {};
  try {
    c = JSON.parse(rawContent || "{}");
  } catch {
    return "[视频] 收到一条视频消息（内容解析失败）";
  }
  const head = `[视频「${c.file_name ?? "未命名"}」]`;
  if (!c.image_key) return `${head} 视频本体未下载`;
  try {
    return `${head} 封面已存本地，用 Read 看：${await saveInboundImage(payload.message_id, c.image_key)}`;
  } catch (e) {
    process.stderr.write(`[chat-message] 视频封面下载失败 msg_id=${payload.message_id}: ${e instanceof Error ? e.message : e}\n`);
    return `${head} 视频本体未下载`;
  }
}

// ── 合并转发（B6）──
// im.v1.message.get 反查子消息列表。真实响应结构未在 SDK .d.ts 里如实建模（SDK 自带类型对不上
// 实测字段），故手写 interface + `as unknown as` 转换——同 reply-quote.ts:resolveReplyQuote 已验证
// 的既有写法（sender 只有 {id, id_type, sender_type}，没有 sender_name 字段；app 名字反查跟
// resolveReplyQuote 一致：resolveBotName(id) ?? id，不指望不存在的 sender_name）。
interface MergeForwardItem {
  message_id?: string;
  upper_message_id?: string;
  msg_type?: string;
  body?: { content?: string };
  sender?: { id?: string; id_type?: string; sender_type?: string };
  create_time?: string | number;
}

const MERGE_FORWARD_MAX_ITEMS = 40;
const MERGE_FORWARD_MAX_CHARS = 4000;

/** create_time 是毫秒字符串（同 chat-message.ts create_time_ms 用法，非秒级） → `MM-DD HH:mm` */
function fmtItemTime(v: string | number | undefined): string {
  const ms = Number(v);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** post 子消息文字提取（只取文字，合并转发列表不下钻内嵌图片）。 */
function extractPostText(raw: string | undefined): string {
  try {
    const body = unwrapPost(JSON.parse(raw || "{}"));
    if (!body) return "";
    const lines: string[] = [];
    if (body.title) lines.push(body.title);
    for (const para of body.content ?? []) {
      if (!Array.isArray(para)) continue;
      let line = "";
      for (const el of para) {
        if (el.tag === "text") line += el.text ?? "";
        else if (el.tag === "a") line += el.text ?? el.href ?? "";
      }
      if (line.trim()) lines.push(line);
    }
    return lines.join(" ").trim();
  } catch {
    return "";
  }
}

/** 子消息正文按 msg_type 渲染成一行可读文字。 */
function renderMergeForwardItemText(item: MergeForwardItem): string {
  const content = item.body?.content ?? "";
  switch (item.msg_type) {
    case "text":
      return parseTextContent(content) || "(无内容)";
    case "post":
      return extractPostText(content) || "(无内容)";
    case "image":
      return "[图片]";
    case "file": {
      let name = "未命名";
      try {
        name = (JSON.parse(content || "{}") as { file_name?: string }).file_name ?? name;
      } catch {
        /* 解析失败留默认名 */
      }
      return `[文件「${name}」]`;
    }
    case "audio":
      return "[语音]";
    default:
      return `[${item.msg_type ?? "未知类型"}]`;
  }
}

/** 子消息发送者名字反查：user 走已知映射优先（省一次 API 往返），app 走花名册。 */
async function resolveMergeForwardSenderName(sender: MergeForwardItem["sender"]): Promise<string> {
  const id = sender?.id;
  if (!id) return "未知用户";
  if (sender?.sender_type === "app") {
    return resolveBotName(id) ?? id;
  }
  return getKnownUserName(id) ?? (await getUserName(id));
}

/**
 * 合并转发的聊天记录：反查子消息列表并渲染成可读多行文字。
 * 失败（网络/权限/解析异常）回退旧文案 + 原因，不抛错不 DROP。
 */
export async function parseMergeForward(ctx: ParseCtx): Promise<string | null> {
  const messageId = ctx.payload.message_id;
  try {
    const res = await getFeishuClient().im.v1.message.get({
      path: { message_id: messageId },
    });
    const items = (res.data?.items ?? []) as unknown as MergeForwardItem[];
    const children = items
      .filter((it) => !!it.upper_message_id)
      .sort((a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0))
      .slice(0, MERGE_FORWARD_MAX_ITEMS);
    if (children.length === 0) {
      return "[合并转发的聊天记录]（正文看不到）";
    }
    const lines: string[] = [];
    for (const item of children) {
      const name = await resolveMergeForwardSenderName(item.sender);
      const text = renderMergeForwardItemText(item);
      lines.push(`[${fmtItemTime(item.create_time)}] ${name}：${text}`);
    }
    let body = lines.join("\n");
    if (body.length > MERGE_FORWARD_MAX_CHARS) {
      body = body.slice(0, MERGE_FORWARD_MAX_CHARS) + "…（已截断）";
    }
    return `合并转发（${children.length} 条）：\n${body}`;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[chat-message] 合并转发解析失败 msg_id=${messageId}: ${reason}\n`);
    return `[合并转发的聊天记录]（拉取正文失败：${reason}）`;
  }
}

// ── 路由表 ──

export const PARSERS: Record<string, Parser> = {
  text: parseText,
  image: parseImage,
  file: parseFile,
  audio: parseAudio,
  post: parsePost,
  interactive: parseInteractive,
  media: parseMedia,
  sticker: label(() => "[表情包]"),
  share_chat: label(() => "[分享了一个群名片]"),
  share_user: label(() => "[分享了一张个人名片]"),
  merge_forward: parseMergeForward,
  location: label((c) => `[位置] ${str(c.name)}${str(c.address) ? ` ${str(c.address)}` : ""}`),
  todo: label((c) => `[任务] ${unwrapPost(c.summary)?.title || "（无标题）"}${fmtTs(c.due_time, " 截止 ")}`),
  vote: label((c) => `[投票] ${str(c.topic)}｜选项：${(Array.isArray(c.options) ? c.options : []).map(str).join(" / ")}`),
  hongbao: label(() => "[红包]"),
  video_chat: label((c) => `[视频会议] ${str(c.topic)}${fmtTs(c.start_time, " ")}`),
  folder: label((c) => `[文件夹「${str(c.file_name)}」]（飞书文件夹不可下载）`),
  calendar: calendarLabel,
  share_calendar_event: calendarLabel,
  general_calendar: calendarLabel,
};
