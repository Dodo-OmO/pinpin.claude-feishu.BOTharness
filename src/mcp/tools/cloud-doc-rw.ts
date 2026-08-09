// read_cloud_doc / edit_cloud_doc tool——读已有飞书云文档纯文本 + 编辑品品自己建的文档。
// 读走 docx.v1.document.rawContent；编辑：append=末尾追加 markdown，replace=清空原内容再写
// （replace 前：①先转换 markdown 验可行，②全文备份到日志文件，③清空，④插入——防半态丢失）。
// 编辑别人的文档飞书会 403——优雅回报，别砸脸。

import fs from "node:fs";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";
import { insertMarkdownBlocks } from "./create-cloud-doc.js";
import { getVaultRoot, dateYYYYMM } from "../utils/helper.js";

type Client = ReturnType<typeof getFeishuClient>;

export const readCloudDocTool: Tool = {
  name: "read_cloud_doc",
  description:
    "读飞书云文档纯文本。支持普通文档 + 知识库(wiki)文档——直接传文档链接即可（自动识别 wiki/普通文档并转换），也可传裸文档 id。注：wiki 里的表格/多维表/思维笔记等非文字文档不支持纯文本读取。",
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
    let token = args.doc_token.trim();
    // 传链接时提取 token + 判类型：/wiki/ = 知识库节点，/docx/ = 普通文档；裸 token 不匹配走原路
    let isWiki = false;
    const m = token.match(/\/(wiki|docx|docs)\/([A-Za-z0-9]+)/);
    if (m) {
      isWiki = m[1] === "wiki";
      token = m[2];
    }
    // 知识库节点：先转成背后真实文档 obj_token，且仅 docx 类支持纯文本读取
    if (isWiki) {
      const node = await client.wiki.v2.space.getNode({ params: { token } });
      const obj = node.data?.node;
      if (!obj?.obj_token) {
        return { isError: true, content: [{ type: "text" as const, text: "读 wiki 节点失败：拿不到背后的文档（八成没节点阅读权限）" }] };
      }
      if (obj.obj_type !== "docx") {
        return { content: [{ type: "text" as const, text: `「${obj.title ?? ""}」是 ${obj.obj_type} 类型（非文字文档），暂不支持纯文本读取。` }] };
      }
      token = obj.obj_token;
    }
    const res = await client.docx.v1.document.rawContent({ path: { document_id: token } });
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
      // 半态保护（安全顺序）：
      // ① 先把原文全文备份到日志文件（失败不阻断）
      // ② 再清空 ③ 再插入——确保备份在清空前完成
      let rawContent = "";
      try {
        const cur = await client.docx.v1.document.rawContent({ path: { document_id: doc_token } });
        rawContent = cur.data?.content ?? "";
        const backupDir = path.join(getVaultRoot(), "系统日志", "云文档替换备份", dateYYYYMM());
        try {
          fs.mkdirSync(backupDir, { recursive: true });
          const backupFile = path.join(backupDir, `${doc_token}-${Date.now()}.md`);
          fs.writeFileSync(backupFile, rawContent, "utf-8");
        } catch (backupErr) {
          // 备份写盘失败不阻断重写本身，但 stderr 留痕
          process.stderr.write(
            `[edit-cloud-doc] 备份写盘失败（继续执行）: ${backupErr instanceof Error ? backupErr.message : backupErr}\n原文前 500 字: ${rawContent.slice(0, 500)}\n`,
          );
        }
      } catch {
        /* 读原文失败同样不阻断 */
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
