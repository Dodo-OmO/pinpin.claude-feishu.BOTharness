// read_cloud_doc / edit_cloud_doc tool——读已有飞书云文档纯文本 + 编辑品品自己建的文档。
// 读走 docx.v1.document.rawContent；编辑：append=末尾追加 markdown，replace=清空原内容再写
// （replace 前先 rawContent 备份到日志防半态丢失）。编辑别人的文档飞书会 403——优雅回报，别砸脸。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";
import { insertMarkdownBlocks } from "./create-cloud-doc.js";

type Client = ReturnType<typeof getFeishuClient>;

export const readCloudDocTool: Tool = {
  name: "read_cloud_doc",
  description:
    "读飞书云文档（docx）纯文本内容。doc_token = 文档 id（建文档时返回的 doc_token，或文档 url 里 /docx/ 后那段）。",
  inputSchema: {
    type: "object",
    properties: {
      doc_token: { type: "string", description: "文档 id（doc_token）" },
    },
    required: ["doc_token"],
  },
};

export const editCloudDocTool: Tool = {
  name: "edit_cloud_doc",
  description:
    "编辑飞书云文档（docx）——只能编辑品品自己建的文档（编辑别人的会被飞书拒）。" +
    "mode='append' 在文档末尾追加 markdown；mode='replace' 清空原内容后整篇重写（重写前自动备份原文到日志）。",
  inputSchema: {
    type: "object",
    properties: {
      doc_token: { type: "string", description: "文档 id（doc_token）" },
      markdown: { type: "string", description: "要写入的 markdown 内容" },
      mode: { type: "string", enum: ["append", "replace"], description: "append=末尾追加；replace=整篇重写" },
    },
    required: ["doc_token", "markdown", "mode"],
  },
};

export async function handleReadCloudDoc(args: { doc_token: string }) {
  try {
    const client = getFeishuClient();
    const res = await client.docx.v1.document.rawContent({
      path: { document_id: args.doc_token },
    });
    const content = res.data?.content ?? "";
    return { content: [{ type: "text" as const, text: content || "（文档为空）" }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `读云文档失败：${msg}` }] };
  }
}

/** 统计文档顶层子块数量（append 时定位末尾 index 用） */
async function countTopChildren(client: Client, docToken: string): Promise<number> {
  let total = 0;
  let pageToken: string | undefined;
  do {
    const res = await client.docx.v1.documentBlockChildren.get({
      path: { document_id: docToken, block_id: docToken },
      params: { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    total += (res.data?.items ?? []).length;
    pageToken = res.data?.has_more ? res.data?.page_token : undefined;
  } while (pageToken);
  return total;
}

/** 清空文档全部顶层子块（replace 前用）。按页删，每轮删当前首页全部，直到取不到子块。
 *  MAX_ROUNDS 保险：万一 API 不抛错也没真删（极罕见网络/限速异常），避免死循环。 */
async function clearTopChildren(client: Client, docToken: string): Promise<void> {
  const MAX_ROUNDS = 100;
  for (let rounds = 0; rounds < MAX_ROUNDS; rounds++) {
    const res = await client.docx.v1.documentBlockChildren.get({
      path: { document_id: docToken, block_id: docToken },
      params: { page_size: 500 },
    });
    const items = res.data?.items ?? [];
    if (items.length === 0) return;
    await client.docx.v1.documentBlockChildren.batchDelete({
      path: { document_id: docToken, block_id: docToken },
      data: { start_index: 0, end_index: items.length },
    });
  }
  throw new Error(`clearTopChildren 超 ${MAX_ROUNDS} 轮仍未清空，疑 API 异常，中止以防死循环`);
}

export async function handleEditCloudDoc(args: { doc_token: string; markdown: string; mode: "append" | "replace" }) {
  const { doc_token, markdown, mode } = args;
  try {
    const client = getFeishuClient();
    if (mode === "replace") {
      // 半态保护：清空前先把原文备份到日志，万一插入失败有据可查
      try {
        const cur = await client.docx.v1.document.rawContent({ path: { document_id: doc_token } });
        process.stderr.write(
          `[edit-cloud-doc] replace 前备份 ${doc_token} 原文(${(cur.data?.content ?? "").length} 字)：\n${(cur.data?.content ?? "").slice(0, 2000)}\n`,
        );
      } catch {
        /* 备份失败不阻断重写本身 */
      }
      await clearTopChildren(client, doc_token);
      await insertMarkdownBlocks(client, doc_token, markdown, 0);
    } else {
      const atIndex = await countTopChildren(client, doc_token);
      await insertMarkdownBlocks(client, doc_token, markdown, atIndex);
    }
    const url = `https://feishu.cn/docx/${doc_token}`;
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, mode, doc_token, url }) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = /permission|403|forbidden|denied/i.test(msg)
      ? "（八成是没编辑权限——只能编辑品品自己建的文档，别人的改不了）"
      : "";
    return { isError: true, content: [{ type: "text" as const, text: `编辑云文档失败：${msg}${hint}` }] };
  }
}
