// 任务D：品品发本地文件/图片到飞书群
// 自动判别：图片扩展名 → 走图片消息（群里直接显示）；其它 → 走文件消息。
// 可发任意确知频道（不限当前活跃）；安全白名单仍限制只能发 vault/系统临时目录文件。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  uploadImage,
  sendImage,
  uploadFile,
  sendFile,
} from "./feishu-send.js";
import { appendBotReply } from "../utils/chat-log.js";
import { getVaultRoot } from "../utils/helper.js";

// 安全白名单：只允许发 vault 或系统临时目录里的文件——挡住被社工诱导把
// .env / .feishu-user-token.json 等凭据文件（在代码包目录）误发到群里（群里不可撤回）。
const ALLOWED_ROOTS = [
  getVaultRoot(),
  os.tmpdir(),
].map((r) => path.resolve(r));

function isAllowedPath(p: string): boolean {
  const resolved = path.resolve(p);
  return ALLOWED_ROOTS.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
// 飞书 file_type 接受 opus/mp4/pdf/doc/xls/ppt/stream，其它一律 stream
const EXT_TO_FILETYPE: Record<string, string> = {
  ".mp4": "mp4",
  ".pdf": "pdf",
  ".doc": "doc",
  ".xls": "xls",
  ".ppt": "ppt",
};

const MAX_BYTES = 28 * 1024 * 1024; // 飞书文件 30MB 上限，留余量

export const PINPIN_SEND_FILE_TOOL = {
  name: "pinpin_send_file",
  description:
    "把本地一个文件/图片发到任意你确知的飞书频道（群或单聊，不限当前活跃）。传本地绝对路径 file_path 。用于任何人类让你「把 X 文件发某频道」「把刚生成的图发出去」。",
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

  if (!isAllowedPath(file_path)) {
    return {
      isError: true,
      content: [{ type: "text", text: "只能发 vault 目录或系统临时目录里的文件（防误发配置/凭据文件到群里）。要发别处的，先挪到 vault。" }],
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
    if (IMAGE_EXTS.has(ext)) {
      const imageKey = await uploadImage(buf);
      messageId = await sendImage(chat_id, imageKey, reply_to_message_id);
      kind = "图片";
    } else {
      const fileKey = await uploadFile(buf, baseName, EXT_TO_FILETYPE[ext] ?? "stream");
      messageId = await sendFile(chat_id, fileKey, reply_to_message_id);
      kind = "文件";
    }
    appendBotReply(chat_id, `[发${kind} ${baseName}]`);
    return {
      content: [{ type: "text", text: JSON.stringify({ delivered: true, kind, message_id: messageId }) }],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      isError: true,
      content: [{ type: "text", text: `发送失败：${msg}` }],
    };
  }
}
