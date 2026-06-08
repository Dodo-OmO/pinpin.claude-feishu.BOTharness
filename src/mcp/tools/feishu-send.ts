// 飞书消息发送封装（MCP 版——不走 LarkChannel WS，直接 HTTP API）
// 当前覆盖：sendText / replyText / splitMessage / uploadOpus / sendAudio / addReaction /
//   uploadImage / uploadFile / sendImage / sendFile / downloadMessageResource

import * as Lark from "@larksuiteoapi/node-sdk";

let _client: Lark.Client | null = null;

export function initFeishuClient(appId: string, appSecret: string): void {
  _client = new Lark.Client({ appId, appSecret, disableTokenCache: false });
}

export function getFeishuClient(): Lark.Client {
  if (!_client) throw new Error("飞书 Client 未初始化——先调 initFeishuClient");
  return _client;
}

/** 发文本消息到指定 chat，返回 message_id */
export async function sendText(chatId: string, text: string): Promise<string> {
  const res = await getFeishuClient().im.v1.message.create({
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
    params: { receive_id_type: "chat_id" },
  });
  const id = res.data?.message_id;
  if (!id) throw new Error(`sendText 失败：无 message_id (chatId=${chatId})`);
  return id;
}

/** 引用回复某条消息（文本），返回新 message_id */
export async function replyText(messageId: string, text: string): Promise<string> {
  const res = await getFeishuClient().im.v1.message.reply({
    data: { msg_type: "text", content: JSON.stringify({ text }) },
    path: { message_id: messageId },
  });
  const id = res.data?.message_id;
  if (!id) throw new Error(`replyText 失败：无 message_id (refId=${messageId})`);
  return id;
}

// 飞书单条文本上限 30K，但超 1900 字视觉体验差（折叠"展开全文"）——沿用 早期版本切片阈值
const MAX_SINGLE_MESSAGE_LENGTH = 1900;

export function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_SINGLE_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", MAX_SINGLE_MESSAGE_LENGTH);
    if (splitAt === -1 || splitAt < MAX_SINGLE_MESSAGE_LENGTH / 2) {
      splitAt = MAX_SINGLE_MESSAGE_LENGTH;
    }
    // 避免切在 surrogate pair 中间（high 在 splitAt-1、low 在 splitAt）→ 否则飞书显示半个 emoji 乱码
    if (
      splitAt < remaining.length &&
      remaining.charCodeAt(splitAt - 1) >= 0xd800 && remaining.charCodeAt(splitAt - 1) <= 0xdbff &&
      remaining.charCodeAt(splitAt) >= 0xdc00 && remaining.charCodeAt(splitAt) <= 0xdfff
    ) {
      splitAt -= 1;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    const fenceRegex = /^```/gm;
    let insideBlock = false;
    let blockLang = "";
    let match;
    while ((match = fenceRegex.exec(chunk)) !== null) {
      if (insideBlock) {
        insideBlock = false;
        blockLang = "";
      } else {
        insideBlock = true;
        const lineEnd = chunk.indexOf("\n", match.index);
        blockLang = chunk.slice(match.index + 3, lineEnd === -1 ? undefined : lineEnd).trim();
      }
    }

    if (insideBlock) {
      chunk += "\n```";
      remaining = "```" + blockLang + "\n" + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

// ── 阶段 2-B：音频上传 + audio 消息发送 + emoji reaction ──
// API 调用方式照搬 早期版本 src/feishu/api.ts:149-216（uploadFile + sendAudio）+
// WebFetch 飞书官方文档 messageReaction.create（早期版本用 LarkChannel 封装，MCP 版走原生 SDK）

/**
 * 上传 OGG Opus 音频，返回 file_key（限 30MB；durationMs 用 music-metadata 算出来传进来）
 * 飞书 SDK 已实证接受 file_type="opus"（早期版本生产跑通）
 */
export async function uploadOpus(
  buf: Buffer,
  fileName: string,
  durationMs?: number,
): Promise<string> {
  const res = await getFeishuClient().im.v1.file.create({
    data: {
      file_type: "opus",
      file_name: fileName,
      file: buf,
      ...(durationMs !== undefined ? { duration: durationMs } : {}),
    },
  });
  const key = res?.file_key;
  if (!key) throw new Error(`uploadOpus 失败：无 file_key (name=${fileName})`);
  return key;
}

/** 发音频消息（语音条），fileKey 来自 uploadOpus；可选 reply 引用 */
export async function sendAudio(
  chatId: string,
  fileKey: string,
  replyToMessageId?: string,
): Promise<string> {
  if (replyToMessageId) {
    const res = await getFeishuClient().im.v1.message.reply({
      data: { msg_type: "audio", content: JSON.stringify({ file_key: fileKey }) },
      path: { message_id: replyToMessageId },
    });
    const id = res.data?.message_id;
    if (!id) throw new Error("sendAudio(reply) 失败：无 message_id");
    return id;
  }
  const res = await getFeishuClient().im.v1.message.create({
    data: { receive_id: chatId, msg_type: "audio", content: JSON.stringify({ file_key: fileKey }) },
    params: { receive_id_type: "chat_id" },
  });
  const id = res.data?.message_id;
  if (!id) throw new Error("sendAudio 失败：无 message_id");
  return id;
}

// ── 任务D：图片/文件 上传 + 发送 + 入站资源下载 ──
// 方法照搬 早期版本 src/feishu/api.ts（uploadImage/uploadFile/sendImage/sendFile/messageResource.get），
// 走原生 SDK（MCP 版无 LarkChannel 封装）。

/** 上传图片，返回 image_key（用于发图片消息） */
export async function uploadImage(buf: Buffer): Promise<string> {
  const res = await getFeishuClient().im.v1.image.create({
    data: { image_type: "message", image: buf },
  });
  const key = res?.image_key;
  if (!key) throw new Error("uploadImage 失败：无 image_key");
  return key;
}

type FeishuFileType = "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";

/** 上传通用文件，返回 file_key。fileType：飞书接受 opus/mp4/pdf/doc/xls/ppt/stream，未知用 "stream" */
export async function uploadFile(
  buf: Buffer,
  fileName: string,
  fileType: string = "stream",
): Promise<string> {
  const res = await getFeishuClient().im.v1.file.create({
    data: { file_type: fileType as FeishuFileType, file_name: fileName, file: buf },
  });
  const key = res?.file_key;
  if (!key) throw new Error(`uploadFile 失败：无 file_key (name=${fileName})`);
  return key;
}

/** 发图片消息，imageKey 来自 uploadImage；可选 reply 引用 */
export async function sendImage(
  chatId: string,
  imageKey: string,
  replyToMessageId?: string,
): Promise<string> {
  const content = JSON.stringify({ image_key: imageKey });
  if (replyToMessageId) {
    const res = await getFeishuClient().im.v1.message.reply({
      data: { msg_type: "image", content },
      path: { message_id: replyToMessageId },
    });
    const id = res.data?.message_id;
    if (!id) throw new Error("sendImage(reply) 失败：无 message_id");
    return id;
  }
  const res = await getFeishuClient().im.v1.message.create({
    data: { receive_id: chatId, msg_type: "image", content },
    params: { receive_id_type: "chat_id" },
  });
  const id = res.data?.message_id;
  if (!id) throw new Error("sendImage 失败：无 message_id");
  return id;
}

/** 发文件消息，fileKey 来自 uploadFile；可选 reply 引用 */
export async function sendFile(
  chatId: string,
  fileKey: string,
  replyToMessageId?: string,
): Promise<string> {
  const content = JSON.stringify({ file_key: fileKey });
  if (replyToMessageId) {
    const res = await getFeishuClient().im.v1.message.reply({
      data: { msg_type: "file", content },
      path: { message_id: replyToMessageId },
    });
    const id = res.data?.message_id;
    if (!id) throw new Error("sendFile(reply) 失败：无 message_id");
    return id;
  }
  const res = await getFeishuClient().im.v1.message.create({
    data: { receive_id: chatId, msg_type: "file", content },
    params: { receive_id_type: "chat_id" },
  });
  const id = res.data?.message_id;
  if (!id) throw new Error("sendFile 失败：无 message_id");
  return id;
}

/** 下载入站消息里的资源到本地路径。飞书 messageResource.get 的 type 只认 "image"|"file"——
 *  语音附件也走 "file"（非 "audio"，飞书不认 audio 会下载失败）。 */
export async function downloadMessageResource(
  messageId: string,
  fileKey: string,
  type: "image" | "file",
  destPath: string,
): Promise<void> {
  const res = await getFeishuClient().im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });
  await res.writeFile(destPath);
}

/**
 * 给消息加 emoji reaction
 * emojiType: 飞书 emoji_type 规范名（如 "SMILE" / "Fire" / "EatingFood"）。
 * 由调用方（react-emoji tool）通过 resolveEmojiType 校验规范化后传入。
 */
export async function addReaction(messageId: string, emojiType: string): Promise<void> {
  await getFeishuClient().im.v1.messageReaction.create({
    path: { message_id: messageId },
    data: { reaction_type: { emoji_type: emojiType } },
  });
}
