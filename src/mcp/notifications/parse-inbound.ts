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
import { downloadMessageResource } from "../tools/feishu-send.js";
import { transcribeAudio } from "../utils/stt.js";
import { logBackground } from "../utils/background-log.js";

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
  // 标准 v2 卡片标题在 header.title（真实卡片多用顶层 title，此处兼容 header 形态）
  if (obj.header && typeof obj.header === "object") {
    return cardLineText((obj.header as Record<string, unknown>).title);
  }
  if (obj.text && typeof obj.text === "object") return cardLineText(obj.text);
  for (const key of ["elements", "fields", "columns"]) {
    if (Array.isArray(obj[key])) return (obj[key] as unknown[]).map(cardLineText).join("");
  }
  return "";
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
  const elements = card.elements;
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
    return `[图片] 有人发了图片，已压缩存本地——**这轮先用 Read 工具读这张图、看清内容再回应**：${localPath}`;
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
    return `[文件附件「${parsed.file_name ?? "未命名"}」] 已备份到本地，默认不读——需要时再 Read：${localPath}`;
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
      parts.push(`[图片×${imagePaths.length}] 已存本地，用 Read 工具查看：${imagePaths.join(" | ")}`);
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

// ── 路由表 ──

export const PARSERS: Record<string, Parser> = {
  text: parseText,
  image: parseImage,
  file: parseFile,
  audio: parseAudio,
  post: parsePost,
  interactive: parseInteractive,
};
