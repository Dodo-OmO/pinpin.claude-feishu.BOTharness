// 任务D：品品发本地文件/图片到飞书群
// 自动判别：图片扩展名 → 走图片消息（群里直接显示）；其它 → 走文件消息。
// 可发任意确知频道（不限当前活跃）+ 任意本地路径文件；仅黑名单挡凭据/密钥文件。

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  uploadImage,
  sendImage,
  uploadFile,
  sendFile,
} from "./feishu-send.js";
import { appendBotReply } from "../utils/chat-log.js";

// 凭据/密钥黑名单：默认放行任意路径文件，只挡这些一旦误发进群（不可撤回）就泄密的——
// 挡住被社工诱导把 .env / 飞书 token / 私钥等凭据发到群里。工作文件（.docx/.png 等）一律放行。
const BLOCKED_EXTS = new Set([".pem", ".key", ".pfx", ".p12", ".ppk"]); // 私钥/证书（含 PuTTY .ppk）
const BLOCKED_NAMES = new Set([
  ".feishu-user-token.json",
  ".envrc", "credentials", // direnv 环境 / 云凭据文件
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", // SSH 私钥
  ".git-credentials", ".npmrc", // git 凭据 / npm token
]);

export function isBlockedCredentialFile(p: string): boolean {
  const name = path.basename(p).toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) return true; // .env / .env.local 等
  if (BLOCKED_NAMES.has(name)) return true;
  if (BLOCKED_EXTS.has(path.extname(name))) return true;
  return false;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
// 飞书不认 svg——直接发只会变成一个群里打不开的附件。品品画结构图/流程图走 SVG
// （免费、字不会写错、能反复精修），发送时在这儿栅格化成 PNG，源 .svg 仍留在本地。
const VECTOR_EXTS = new Set([".svg"]);
const SVG_RASTER_DENSITY = 200; // DPI：够清晰又不会大到离谱；再大交给 fitImageForFeishu 收
// 飞书 file_type 接受 opus/mp4/pdf/doc/xls/ppt/stream，其它一律 stream
const EXT_TO_FILETYPE: Record<string, string> = {
  ".mp4": "mp4",
  ".pdf": "pdf",
  ".doc": "doc",
  ".xls": "xls",
  ".ppt": "ppt",
};

const MAX_BYTES = 28 * 1024 * 1024; // 飞书文件 30MB 上限，留余量
// 飞书**图片**上限比文件低得多：官方 im/v1/images 文档「上传的图片大小不能超过 10 MB」。
// LibTV 2K 出图动辄 12MB+，直发必失败 → 超限自动压到线下再发（高清原图仍留在作业本）。
const FEISHU_IMAGE_MAX = 9.5 * 1024 * 1024;
const SHRINK_STEPS = [3000, 2400, 1920, 1440] as const; // 逐级降最长边

/**
 * 把出站图片压到飞书 10MB 线以下。未超限原样返回。
 * 有 alpha 的保持 PNG（不压成 JPEG，免得透明底变黑）；无 alpha 走 JPEG。
 * 压不动 / sharp 出错 → 原样返回，交由上传报错，不吞异常。
 */
async function fitImageForFeishu(buf: Buffer): Promise<{ buf: Buffer; note: string }> {
  if (buf.length <= FEISHU_IMAGE_MAX) return { buf, note: "" };
  const before = (buf.length / 1024 / 1024).toFixed(1);
  try {
    const hasAlpha = !!(await sharp(buf).metadata()).hasAlpha;
    const encode = (s: sharp.Sharp) => (hasAlpha ? s.png({ compressionLevel: 9 }) : s.jpeg({ quality: 88 }));
    let out = await encode(sharp(buf)).toBuffer(); // 先只重编码，保住原分辨率
    for (const edge of SHRINK_STEPS) {
      if (out.length <= FEISHU_IMAGE_MAX) break;
      out = await encode(sharp(buf).resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })).toBuffer();
    }
    if (out.length > FEISHU_IMAGE_MAX) return { buf, note: "" }; // 压不下去，别拿更差的图去撞同一堵墙
    return { buf: out, note: `（原图 ${before}MB 超飞书 10MB 图片上限，已压到 ${(out.length / 1024 / 1024).toFixed(1)}MB 再发；高清原图仍在本地）` };
  } catch (e) {
    process.stderr.write(`[send-file] 图片压缩失败，改发原图：${e instanceof Error ? e.message : e}\n`);
    return { buf, note: "" };
  }
}

export const PINPIN_SEND_FILE_TOOL = {
  name: "pinpin_send_file",
  description:
    "把本地一个文件/图片发到任意你确知的飞书频道（群或单聊，不限当前活跃）。传本地绝对路径 file_path 。用于任何人类让你「把 X 文件发某频道」「把刚生成的图发出去」。图片扩展名走图片消息（群里直接显示）；**.svg 会自动栅格化成 PNG 再发**（飞书不认 svg），所以你画结构图/流程图可以直接写 .svg 交给它；超飞书 10MB 图片上限的会自动压缩后再发。",
  inputSchema: {
    type: "object" as const,
    properties: {
      chat_id: { type: "string" as const, description: "目标频道 chat_id（你确知的任意频道，不限当前活跃）" },
      file_path: { type: "string" as const, description: "要发的本机文件绝对路径" },
      reply_to_message_id: { type: "string" as const, description: "可选，引用回复某条消息" },
    },
    required: ["chat_id", "file_path"],
  },
};

interface SendFileArgs {
  chat_id: string;
  file_path: string;
  reply_to_message_id?: string;
}

export async function handlePinpinSendFile(
  args: SendFileArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { chat_id, file_path, reply_to_message_id } = args;
  if (!chat_id || !file_path) {
    return { isError: true, content: [{ type: "text", text: "缺少必填参数 chat_id 或 file_path" }] };
  }

  if (isBlockedCredentialFile(file_path)) {
    return {
      isError: true,
      content: [{ type: "text", text: "这是凭据/密钥类文件（.env / 飞书 token / 私钥证书等），不能发到群里（群消息撤不回，怕泄密）。" }],
    };
  }

  if (!fs.existsSync(file_path)) {
    return { isError: true, content: [{ type: "text", text: `文件不存在：${file_path}（确认路径对不对）` }] };
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file_path);
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `读文件失败：${e instanceof Error ? e.message : e}` }] };
  }
  if (buf.length > MAX_BYTES) {
    return {
      isError: true,
      content: [{ type: "text", text: `文件太大（${(buf.length / 1024 / 1024).toFixed(1)}MB，超飞书 ~30MB 上限），发不了。` }],
    };
  }

  const ext = path.extname(file_path).toLowerCase();
  const baseName = path.basename(file_path);
  try {
    let messageId: string;
    let kind: string;
    let note = "";
    if (IMAGE_EXTS.has(ext) || VECTOR_EXTS.has(ext)) {
      let imgBuf = buf;
      if (VECTOR_EXTS.has(ext)) {
        try {
          imgBuf = await sharp(buf, { density: SVG_RASTER_DENSITY }).png().toBuffer();
          note = "（SVG 已转成 PNG 发出，矢量源文件仍在本地）";
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text", text: `这个 SVG 转不成图片（${e instanceof Error ? e.message : e}）——多半是 SVG 本身写坏了，检查一下标签闭合和 width/height。` }],
          };
        }
      }
      const fitted = await fitImageForFeishu(imgBuf);
      note = [note, fitted.note].filter(Boolean).join(" ");
      const imageKey = await uploadImage(fitted.buf);
      messageId = await sendImage(chat_id, imageKey, reply_to_message_id);
      kind = "图片";
    } else {
      const fileKey = await uploadFile(buf, baseName, EXT_TO_FILETYPE[ext] ?? "stream");
      messageId = await sendFile(chat_id, fileKey, reply_to_message_id);
      kind = "文件";
    }
    appendBotReply(chat_id, `[发${kind} ${baseName}]`);
    return {
      content: [{ type: "text", text: JSON.stringify({ delivered: true, kind, message_id: messageId, note: note || undefined }) }],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      isError: true,
      content: [{ type: "text", text: `发送失败：${msg}` }],
    };
  }
}
