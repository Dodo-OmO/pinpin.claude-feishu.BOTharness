// pinpin_save_file——把Owner刚发/刚回复的、默认没自动存的文件存进本地库。
// 背景：owner-skip 默认不存Owner自己发的文件（她常发本机已有的文件给别人），
// 但她说"存下来"时品品调本工具。文件句柄由 save-target 槽位提供（parseFile / 回复 owner 文件时写），
// 品品只需传 chat_id，不碰 message_id。下载落盘复用 saveInboundFile（统一落 vault\他人附件）。

import { getPendingSaveFile, clearPendingSaveFile } from "../utils/save-target.js";
import { saveInboundFile } from "../utils/media-attachments.js";

export const PINPIN_SAVE_FILE_TOOL = {
  name: "pinpin_save_file",
  description:
    "把Owner刚发或刚回复的、默认没自动存的文件存进本地库。Owner自己发的文件默认不存，她说「存下来」时调本工具——只需传当前 chat_id，文件已记在后台槽位。存完返回落盘路径，告诉Owner存哪了。槽位空（如品品重启过）会返回提示，让Owner回复那条文件再说一声。",
  inputSchema: {
    type: "object" as const,
    properties: {
      chat_id: { type: "string" as const, description: "当前对话 chat_id" },
    },
    required: ["chat_id"],
  },
};

interface SaveFileArgs {
  chat_id: string;
}

export async function handlePinpinSaveFile(
  args: SaveFileArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { chat_id } = args;
  if (!chat_id) {
    return { isError: true, content: [{ type: "text", text: "缺少必填参数 chat_id" }] };
  }
  const target = getPendingSaveFile(chat_id);
  if (!target) {
    return {
      content: [
        {
          type: "text",
          text: "我这会儿没攥着待存的文件句柄——你回复那条文件跟我说声「存下来」，我就能存（重启会丢句柄，重发/回复一下即可）。",
        },
      ],
    };
  }
  try {
    const localPath = await saveInboundFile(target.fileMessageId, target.fileKey, target.fileName);
    clearPendingSaveFile(chat_id);
    return {
      content: [{ type: "text", text: JSON.stringify({ saved: true, file_name: target.fileName, path: localPath }) }],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text", text: `存文件失败：${msg}` }] };
  }
}
