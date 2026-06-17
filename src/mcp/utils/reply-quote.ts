// 引用回复 quote 解析（R3）——poll 路径下飞书 message.list 返回项含 parent_id
// 但不含被回复消息内容，需调 im.v1.message.get 反查 + 截 ≤15 字
//
// 搬迁源：早期版本 src/feishu/handlers/message.ts:276-336 resolveReplyContext
// MCP 版差异：
// - 输出格式 = <channel reply_to_quote="..."> 属性值（短字符串，进 prompt 头标签）
// - 不输出 logSenderName（MCP 版没有 chat-log 写盘逻辑，留阶段 3）

import { getFeishuClient } from "../tools/feishu-send.js";
import { getUserName, resolveBotName } from "./sender-names.js";
import { setPendingSaveFile } from "./save-target.js";

const QUOTE_TEXT_MAX_CHARS = 15;

interface FeishuParentMessage {
  msg_type?: string;
  body?: { content?: string };
  sender?: { sender_type?: string; id?: string };
}

/**
 * 反查被回复消息，返回简短引用串。
 * @param parentMessageId 被回复消息 ID
 * @param selfBotAppId 品品自己的 app_id（被回复消息是品品自己时显示"品品"而不是反查 contact）
 * @param chatId 当前对话 ID——被回复的是"Owner自己的文件"时记进待存槽位（她说"存下来"用）
 * @returns 形如 `@Owner: "今天感觉不错的一天我都..."` 或 `@BotB 的语音`；失败返 "[回复一条已不可见的消息]"
 */
export async function resolveReplyQuote(
  parentMessageId: string,
  selfBotAppId: string,
  chatId: string,
): Promise<string> {
  try {
    const res = await getFeishuClient().im.v1.message.get({
      path: { message_id: parentMessageId },
    });
    const items = res.data?.items ?? [];
    const ref = items[0] as unknown as FeishuParentMessage | undefined;
    if (!ref) {
      return "[回复一条已不可见的消息]";
    }

    // ── 发送者名 ──
    let authorName = "未知用户";
    const refSender = ref.sender;
    if (refSender?.sender_type === "app") {
      // bot 发的：自己 = "品品" / 其它 bot 查 BOT_NAME_MAP
      if (refSender.id === selfBotAppId) {
        authorName = "品品";
      } else if (refSender.id) {
        authorName = resolveBotName(refSender.id) ?? refSender.id;
      }
    } else if (refSender?.id) {
      authorName = await getUserName(refSender.id);
    }

    // ── 内容描述 ──
    let contentDesc: string;
    const refType = ref.msg_type ?? "text";
    if (refType === "text") {
      let txt = "";
      try {
        const obj = JSON.parse(ref.body?.content ?? "{}") as { text?: string };
        txt = (obj.text ?? "").replace(/\s+/g, " ").trim();
      } catch {
        /* 解析失败留空 */
      }
      const chars = Array.from(txt);
      const truncated =
        chars.length > QUOTE_TEXT_MAX_CHARS
          ? chars.slice(0, QUOTE_TEXT_MAX_CHARS).join("") + "..."
          : chars.join("");
      contentDesc = `: "${truncated}"`;
    } else if (refType === "audio") {
      contentDesc = " 的语音";
    } else if (refType === "image") {
      contentDesc = " 的图片";
    } else if (refType === "file") {
      // Owner回复自己发的文件 → 记进待存槽位（owner-skip 时没存），她说"存下来"时 pinpin_save_file 据此下载。
      const ownerOpenId = process.env.FEISHU_OWNER_OPEN_ID;
      if (ownerOpenId && refSender?.id === ownerOpenId) {
        try {
          const fc = JSON.parse(ref.body?.content ?? "{}") as { file_key?: string; file_name?: string };
          if (fc.file_key) {
            setPendingSaveFile(chatId, {
              fileMessageId: parentMessageId,
              fileKey: fc.file_key,
              fileName: fc.file_name ?? "file",
            });
          }
        } catch {
          /* 解析失败不影响引用串 */
        }
      }
      contentDesc = " 的文件";
    } else if (refType === "post") {
      contentDesc = " 的富文本";
    } else {
      contentDesc = " 的消息";
    }

    return `回复 @${authorName}${contentDesc}`;
  } catch (e) {
    process.stderr.write(
      `[reply-quote] resolveReplyQuote 失败 parent=${parentMessageId}: ${e instanceof Error ? e.message : e}\n`,
    );
    return "[回复一条已不可见的消息]";
  }
}
