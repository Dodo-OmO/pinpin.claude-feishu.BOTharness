// list_wiki_spaces tool——列品品能访问的知识库空间（space_id + 名称），
// 给 create_cloud_doc 的 wiki_space_id 用。注：品品应用须先被加进知识库为成员才看得到。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";

export const listWikiSpacesTool: Tool = {
  name: "list_wiki_spaces",
  description:
    "列品品能访问的知识库空间（space_id + 名称），用于 create_cloud_doc 建到知识库时填 wiki_space_id。" +
    "注：品品应用须先被加进对应知识库为成员才看得到。",
  inputSchema: { type: "object", properties: {} },
};

export async function handleListWikiSpaces() {
  try {
    const client = getFeishuClient();
    const res = await client.wiki.v2.space.list({ params: { page_size: 50 } });
    const spaces = (res.data?.items ?? []).map((s) => ({ space_id: s.space_id, name: s.name }));
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ count: spaces.length, spaces }, null, 2) }],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `列知识库失败：${msg}` }] };
  }
}
