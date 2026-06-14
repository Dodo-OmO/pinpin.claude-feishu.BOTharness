// read_doc_todos / set_doc_todo——读飞书云文档里的待办(复选框 todo block)状态 + 勾掉/取消。
// 纯文本读取(rawContent)不保证带 done 状态，故走 block 级：documentBlockChildren.get 读 + documentBlock.patch 写。
// 双向勾选：成员在飞书 UI 点的勾 done 也能被 read_doc_todos 读到。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";

export const readDocTodosTool: Tool = {
  name: "read_doc_todos",
  description:
    "读飞书云文档里所有待办(复选框)，返回 { total, undone, todos:[{block_id, text, done}] }。" +
    "盘点未完成任务用（done=false）。doc_token = 文档 id（或链接里 /docx/ 后那段）。",
  inputSchema: {
    type: "object",
    properties: { doc_token: { type: "string", description: "文档 id" } },
    required: ["doc_token"],
  },
};

export const setDocTodoTool: Tool = {
  name: "set_doc_todo",
  description:
    "勾掉 / 取消勾飞书云文档里的某条待办。block_id 从 read_doc_todos 拿；done=true 标完成、false 取消完成。",
  inputSchema: {
    type: "object",
    properties: {
      doc_token: { type: "string", description: "文档 id" },
      block_id: { type: "string", description: "待办块 id（read_doc_todos 返回）" },
      done: { type: "boolean", description: "true=勾掉(完成) / false=取消" },
    },
    required: ["doc_token", "block_id", "done"],
  },
};

type DocBlock = {
  block_id?: string;
  todo?: { elements?: { text_run?: { content?: string } }[]; style?: { done?: boolean } };
};

export async function handleReadDocTodos(args: { doc_token: string }) {
  try {
    const client = getFeishuClient();
    const todos: { block_id: string; text: string; done: boolean }[] = [];
    let pageToken: string | undefined;
    do {
      const res = await client.docx.v1.documentBlockChildren.get({
        path: { document_id: args.doc_token, block_id: args.doc_token },
        params: { page_size: 500, with_descendants: true, ...(pageToken ? { page_token: pageToken } : {}) },
      });
      for (const b of (res.data?.items ?? []) as DocBlock[]) {
        if (!b.todo) continue;
        const text = (b.todo.elements ?? []).map((e) => e.text_run?.content ?? "").join("");
        todos.push({ block_id: b.block_id ?? "", text, done: !!b.todo.style?.done });
      }
      pageToken = res.data?.has_more ? res.data?.page_token : undefined;
    } while (pageToken);
    const undone = todos.filter((t) => !t.done).length;
    return { content: [{ type: "text" as const, text: JSON.stringify({ total: todos.length, undone, todos }, null, 2) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `读待办失败：${msg}` }] };
  }
}

export async function handleSetDocTodo(args: { doc_token: string; block_id: string; done: boolean }) {
  try {
    const client = getFeishuClient();
    // fields:[2] = 只更新 todo 的 done 字段（飞书 update_text_style 字段编号）
    const res = await client.docx.v1.documentBlock.patch({
      path: { document_id: args.doc_token, block_id: args.block_id },
      data: { update_text_style: { style: { done: args.done }, fields: [2] } },
    });
    if (res.code !== 0) {
      return { isError: true, content: [{ type: "text" as const, text: `勾待办失败：code=${res.code} msg=${res.msg}` }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, block_id: args.block_id, done: args.done }) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `勾待办失败：${msg}` }] };
  }
}
