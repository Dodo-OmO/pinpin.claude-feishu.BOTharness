// create_cloud_doc tool（MCP 版）
// 阶段 4 批次 2 步骤 2.3：周回顾 / 长文协议 #48 用——飞书云文档 docx create + import markdown

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";
import { createBitable } from "../feishu/bitable.js";
import { createSpreadsheet, createWikiNode, makeShareable, attachToChat } from "../feishu/cloud-doc-ops.js";

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
    "建飞书云文档并可挂到群标签页。format：docx 文档（默认，可带 markdown 内容）/ sheet 电子表格 / bitable 多维表格（表格类建空的，用 write_sheet/write_bitable 填数据）。" +
    "默认建完设组织内全员可编辑 + 挂当前群（attach_to_chat=false 不挂、chat_id 指定别的群、share='none' 不设权限）。" +
    "传 wiki_space_id 则建到该知识库（用 list_wiki_spaces 拿 id）。返回 { format, token, url, table_id?(多维表填数据用), attached, shared }。",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "文档标题" },
      format: { type: "string", enum: ["docx", "sheet", "bitable"], description: "文档格式，默认 docx" },
      markdown: { type: "string", description: "文档内容 markdown（仅 docx 生效）" },
      folder_token: { type: "string", description: "可选父文件夹 token（不传放我的空间根）" },
      wiki_space_id: { type: "string", description: "可选，建到该知识库空间（不传=建我的空间）" },
      wiki_parent_node: { type: "string", description: "可选，知识库内父节点 node_token" },
      attach_to_chat: { type: "boolean", description: "是否挂到群标签页，默认 true" },
      chat_id: { type: "string", description: "可选，挂到指定群（不传=当前群）" },
      share: { type: "string", enum: ["editable", "none"], description: "权限，默认 editable=组织内全员可编辑" },
    },
    required: ["title"],
  },
};

export async function handleCreateCloudDoc(args: {
  title: string;
  format?: "docx" | "sheet" | "bitable";
  markdown?: string;
  folder_token?: string;
  wiki_space_id?: string;
  wiki_parent_node?: string;
  attach_to_chat?: boolean;
  chat_id?: string;
  share?: "editable" | "none";
}) {
  const format = args.format ?? "docx";
  const attach = args.attach_to_chat !== false; // 默认挂群
  const share = args.share ?? "editable";
  const warnings: string[] = [];
  try {
    const client = getFeishuClient();
    let token = ""; // 底层文档 token：docx=document_id / sheet=spreadsheet_token / bitable=app_token
    let url = "";
    let tableId: string | undefined; // 多维表默认表 id，给 write_bitable 用
    let asDoc = false; // 挂群标签类型：docx(我的空间)=doc，其它=url
    let wikiNodeToken = ""; // wiki 节点 token（权限设在它上面，type=wiki）

    if (args.wiki_space_id) {
      // 建到知识库：飞书按 obj_type 自动建底层文档并挂知识库
      const node = await createWikiNode(args.wiki_space_id, format, args.title, args.wiki_parent_node);
      token = node.objToken;
      wikiNodeToken = node.nodeToken;
      url = node.url;
      if (format === "docx" && args.markdown) {
        try { await insertMarkdownBlocks(client, token, args.markdown, 0); }
        catch (e) { warnings.push(`markdown 渲染失败：${e instanceof Error ? e.message : e}`); }
      }
      if (format === "bitable" && token) {
        try {
          const tbl = await client.bitable.v1.appTable.list({ path: { app_token: token }, params: { page_size: 1 } });
          tableId = tbl.data?.items?.[0]?.table_id;
        } catch { /* 拿不到 table_id 不致命，write_bitable 可自取 */ }
      }
    } else if (format === "docx") {
      const createRes = await client.docx.v1.document.create({
        data: { title: args.title, ...(args.folder_token ? { folder_token: args.folder_token } : {}) },
      });
      token = createRes.data?.document?.document_id ?? "";
      if (!token) return { isError: true, content: [{ type: "text" as const, text: "建文档失败：未拿到 doc_token" }] };
      url = `https://feishu.cn/docx/${token}`;
      asDoc = true;
      if (args.markdown) {
        try { await insertMarkdownBlocks(client, token, args.markdown, 0); }
        catch (e) { warnings.push(`markdown 渲染失败：${e instanceof Error ? e.message : e}`); }
      }
    } else if (format === "sheet") {
      const ss = await createSpreadsheet(args.title, args.folder_token);
      token = ss.token; url = ss.url;
    } else {
      const bt = await createBitable(args.title, args.folder_token);
      token = bt.appToken; url = bt.url; tableId = bt.defaultTableId;
    }

    let shared = false;
    if (share === "editable") {
      // wiki 节点权限设在 node_token + type=wiki；我的空间设在底层文档 token + 其格式
      const pToken = args.wiki_space_id ? wikiNodeToken : token;
      const pType = args.wiki_space_id ? "wiki" : format;
      shared = await makeShareable(pToken, pType, true);
      if (!shared) warnings.push("设全员可编辑权限失败（文档已建）");
    }

    let attached = false;
    if (attach) {
      const chatId = args.chat_id || process.env.PINPIN_CHAT_ID;
      if (!chatId) warnings.push("挂群跳过：拿不到 chat_id");
      else {
        attached = await attachToChat(chatId, args.title, url, asDoc);
        if (!attached) warnings.push("挂群失败（文档已建，可能没群标签页管理权限）");
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ format, token, url, ...(tableId ? { table_id: tableId } : {}), attached, shared, ...(warnings.length ? { warnings } : {}) }),
      }],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `建云文档失败：${msg}` }] };
  }
}
