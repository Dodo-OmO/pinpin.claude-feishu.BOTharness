// create_cloud_doc tool（MCP 版）
// 阶段 4 批次 2 步骤 2.3：周回顾 / 长文协议 #48 用——飞书云文档 docx create + import markdown

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";

/**
 * markdown → 飞书 blocks（convert 服务端解析）→ 整树插入 docToken 下 atIndex 处。
 * 标题/列表/加粗/代码/引用等真渲染；超 1000 block 按顶层块切片续接（杜绝静默截断）。
 * 抽成共享 helper：create_cloud_doc 建文档 + edit_cloud_doc 追加/重写都复用。
 */
export async function insertMarkdownBlocks(
  client: ReturnType<typeof getFeishuClient>,
  docToken: string,
  markdown: string,
  atIndex = 0,
): Promise<void> {
  const conv = await client.docx.v1.document.convert({
    data: { content_type: "markdown", content: markdown },
  });
  const blocks = conv.data?.blocks ?? [];
  const firstLevelIds = conv.data?.first_level_block_ids ?? [];
  // table block 的 merge_info 是只读属性，插入前剔除否则报错
  for (const b of blocks) {
    const t = (b as { table?: { merge_info?: unknown } }).table;
    if (t && "merge_info" in t) delete (t as { merge_info?: unknown }).merge_info;
  }
  if (firstLevelIds.length === 0) return;
  const MAX = 1000; // 单次 descendants 上限 1000 block
  if (blocks.length <= MAX) {
    await client.docx.v1.documentBlockDescendant.create({
      path: { document_id: docToken, block_id: docToken },
      data: { children_id: firstLevelIds, index: atIndex, descendants: blocks },
    });
    return;
  }
  // 超 1000 block：按顶层块切片，每批带齐其整棵子孙、index 续接——杜绝静默截断
  const byId = new Map(blocks.map((b) => [(b as { block_id?: string }).block_id ?? "", b] as const));
  const subtree = (rootId: string) => {
    const out: typeof blocks = [];
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop();
      const node = id ? byId.get(id) : undefined;
      if (!node) continue;
      out.push(node);
      const kids = (node as { children?: string[] }).children;
      if (Array.isArray(kids)) stack.push(...kids);
    }
    return out;
  };
  let insertedTop = 0;
  for (let i = 0; i < firstLevelIds.length; ) {
    const chunkTop: string[] = [];
    let chunkBlocks: typeof blocks = [];
    while (i < firstLevelIds.length) {
      const sub = subtree(firstLevelIds[i]);
      if (chunkBlocks.length > 0 && chunkBlocks.length + sub.length > MAX) break;
      chunkTop.push(firstLevelIds[i]);
      chunkBlocks = chunkBlocks.concat(sub);
      i++;
    }
    await client.docx.v1.documentBlockDescendant.create({
      path: { document_id: docToken, block_id: docToken },
      data: { children_id: chunkTop, index: atIndex + insertedTop, descendants: chunkBlocks },
    });
    insertedTop += chunkTop.length;
  }
}

export const createCloudDocTool: Tool = {
  name: "create_cloud_doc",
  description:
    "建飞书云文档（docx）。title = 文档标题；markdown = 文档内容。" +
    "返回 { doc_token, url }——url 可用于飞书私聊发链接。",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "文档标题" },
      markdown: { type: "string", description: "文档内容 markdown" },
      folder_token: { type: "string", description: "可选父文件夹 token（不传放在我的空间根）" },
    },
    required: ["title", "markdown"],
  },
};

export async function handleCreateCloudDoc(args: {
  title: string;
  markdown: string;
  folder_token?: string;
}) {
  const { title, markdown, folder_token } = args;
  try {
    const client = getFeishuClient();
    // 1. 创建空 docx
    const createRes = await client.docx.v1.document.create({
      data: {
        title,
        ...(folder_token ? { folder_token } : {}),
      },
    });
    const docToken = createRes.data?.document?.document_id;
    if (!docToken) {
      return { isError: true, content: [{ type: "text" as const, text: "建文档失败：未拿到 doc_token" }] };
    }
    // 2. markdown → 飞书 blocks（convert 由飞书服务端解析，零自写解析）→ 整树插入（共享 helper）
    try {
      await insertMarkdownBlocks(client, docToken, markdown, 0);
    } catch (e) {
      // 渲染插入失败不致命——文档已建好，回滚成本太高，仅 warn
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[create-cloud-doc] markdown 渲染插入失败但文档已建：${msg}\n`);
    }
    const url = `https://feishu.cn/docx/${docToken}`;
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ doc_token: docToken, url, title }) },
      ],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `建云文档失败：${msg}` }] };
  }
}
