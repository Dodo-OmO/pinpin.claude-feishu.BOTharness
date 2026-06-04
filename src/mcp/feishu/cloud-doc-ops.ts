/**
 * 云文档通用操作（create_cloud_doc 等工具共享）：
 * 建电子表格 / 建知识库节点 / 设全员权限 / 挂群标签页。
 * docx 创建 + markdown 渲染在 tools/create-cloud-doc.ts；多维表创建在 feishu/bitable.ts。
 */

import { getFeishuClient } from "../tools/feishu-send.js";

export type CloudDocType = "docx" | "sheet" | "bitable" | "wiki";

/** 建电子表格，返回 token + url */
export async function createSpreadsheet(
  title: string,
  folderToken?: string,
): Promise<{ token: string; url: string }> {
  const client = getFeishuClient();
  const res = await client.sheets.v3.spreadsheet.create({
    data: { title, ...(folderToken ? { folder_token: folderToken } : {}) },
  });
  if (res.code !== 0) throw new Error(`建电子表格失败：code=${res.code} msg=${res.msg}`);
  const ss = res.data?.spreadsheet;
  if (!ss?.spreadsheet_token) throw new Error("建电子表格失败：无 spreadsheet_token");
  return { token: ss.spreadsheet_token, url: ss.url || `https://feishu.cn/sheets/${ss.spreadsheet_token}` };
}

/** 在知识库空间建节点（obj_type 决定底层文档类型），返回 node_token / obj_token / url。
 *  注意：品品应用须是该知识库成员且有父节点编辑权限，否则飞书拒。 */
export async function createWikiNode(
  spaceId: string,
  objType: "docx" | "sheet" | "bitable",
  title: string,
  parentNodeToken?: string,
): Promise<{ nodeToken: string; objToken: string; url: string }> {
  const client = getFeishuClient();
  const res = await client.wiki.v2.spaceNode.create({
    path: { space_id: spaceId },
    data: {
      obj_type: objType,
      node_type: "origin",
      title,
      ...(parentNodeToken ? { parent_node_token: parentNodeToken } : {}),
    },
  });
  if (res.code !== 0) {
    throw new Error(`建知识库节点失败：code=${res.code} msg=${res.msg}（确认品品应用是该知识库成员）`);
  }
  const node = res.data?.node;
  if (!node?.node_token) throw new Error("建知识库节点失败：无 node_token");
  return { nodeToken: node.node_token, objToken: node.obj_token || "", url: node.url || "" };
}

/** 设云文档"组织内全员可编辑"（editable=false 则只读）。失败不抛只 warn，返回是否成功。 */
export async function makeShareable(token: string, type: CloudDocType, editable = true): Promise<boolean> {
  const client = getFeishuClient();
  try {
    const res = await client.drive.v1.permissionPublic.patch({
      path: { token },
      params: { type },
      data: { link_share_entity: editable ? "tenant_editable" : "tenant_readable" },
    });
    if (res.code !== 0) {
      process.stderr.write(`[cloud-doc] 设权限失败 code=${res.code} msg=${res.msg}\n`);
      return false;
    }
    return true;
  } catch (e) {
    process.stderr.write(`[cloud-doc] 设权限异常：${e instanceof Error ? e.message : e}\n`);
    return false;
  }
}

/** 把云文档挂到群标签页。docx 用 doc 类型，其它（sheet/bitable/wiki）用 url 类型。失败不抛只 warn，返回是否成功。 */
export async function attachToChat(
  chatId: string,
  tabName: string,
  url: string,
  asDoc: boolean,
): Promise<boolean> {
  const client = getFeishuClient();
  try {
    const tab = asDoc
      ? { tab_name: tabName, tab_type: "doc" as const, tab_content: { doc: url } }
      : { tab_name: tabName, tab_type: "url" as const, tab_content: { url } };
    const res = await client.im.v1.chatTab.create({
      path: { chat_id: chatId },
      data: { chat_tabs: [tab] },
    });
    if (res.code !== 0) {
      process.stderr.write(`[cloud-doc] 挂群失败 code=${res.code} msg=${res.msg}\n`);
      return false;
    }
    return true;
  } catch (e) {
    process.stderr.write(`[cloud-doc] 挂群异常：${e instanceof Error ? e.message : e}\n`);
    return false;
  }
}

/** 从群标签页移除指向某文档(token)的标签（按 tab_content 的 url/doc 含 token 匹配）。返回移除数，失败不抛只 warn。 */
export async function detachDocFromChat(chatId: string, token: string): Promise<number> {
  const client = getFeishuClient();
  try {
    const list = await client.im.v1.chatTab.listTabs({ path: { chat_id: chatId } });
    const matched = (list.data?.chat_tabs ?? [])
      .filter((t) => {
        const u = t.tab_content?.doc || t.tab_content?.url || "";
        return t.tab_id && u.includes(token);
      })
      .map((t) => t.tab_id as string);
    if (matched.length === 0) return 0;
    await client.im.v1.chatTab.deleteTabs({ path: { chat_id: chatId }, data: { tab_ids: matched } });
    return matched.length;
  } catch (e) {
    process.stderr.write(`[cloud-doc] 移除群标签异常：${e instanceof Error ? e.message : e}\n`);
    return 0;
  }
}
