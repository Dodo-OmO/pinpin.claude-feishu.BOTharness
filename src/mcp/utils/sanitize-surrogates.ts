/**
 * 落单 UTF-16 surrogate 净化——任何送进 Claude（CLI 对话历史 / API 请求体）的文本统一过此闸。
 *
 * 背景：半个 emoji（lone surrogate：high 无配对 low，或反之）会让 Claude API 请求体成为
 * 非法 JSON（400 no low surrogate）；一旦进入某个群 CLI 的累积历史就持续报错、重启才缓解。
 * 来源不止一处——被截断的 tool 返回值、飞书消息原文、各类注入内容。故在「进 Claude 的总出口」
 * （tool result + channel notification）统一兜底删除，与各源头的码点安全截断构成双层防护。
 */

// high 后不跟 low（落单 high）｜ low 前不是 high（落单 low）。完整 surrogate pair 不匹配，原样保留。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** 删除字符串里的落单 surrogate（完整 emoji surrogate pair 不受影响）。 */
export function stripLoneSurrogates(s: string): string {
  return s.replace(LONE_SURROGATE, "");
}

/** 净化 MCP tool result 里所有 text 片段（原地改并返回同一对象）。 */
export function sanitizeToolResult<T>(result: T): T {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    for (const part of content as Array<{ type?: string; text?: unknown }>) {
      if (part && part.type === "text" && typeof part.text === "string") {
        part.text = stripLoneSurrogates(part.text);
      }
    }
  }
  return result;
}

/** 净化 channel notification 的 content + meta 各值。 */
export function sanitizeChannelParams(
  content: string,
  meta: Record<string, string>,
): { content: string; meta: Record<string, string> } {
  const cleanMeta: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    cleanMeta[k] = typeof v === "string" ? stripLoneSurrogates(v) : v;
  }
  return { content: stripLoneSurrogates(content), meta: cleanMeta };
}
