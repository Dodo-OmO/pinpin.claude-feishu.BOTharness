// write_bitable tool——往多维表格填数据（先用 create_cloud_doc format=bitable 建表拿 token+table_id）。
// 可选先建字段，再 batchCreate 记录（单次≤500）。bitable 的 records/fields API SDK 已封装。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getFeishuClient } from "./feishu-send.js";

export const writeBitableTool: Tool = {
  name: "write_bitable",
  description:
    "往多维表格填数据（先用 create_cloud_doc format=bitable 建表拿 token + table_id）。" +
    "records=记录数组，每条 {字段名:值}。可选 fields 先建字段，每个 {field_name, type}（type：1文本/2数字/3单选/5日期/7复选框/15链接）。table_id 不传=首个表。",
  inputSchema: {
    type: "object",
    properties: {
      app_token: { type: "string", description: "多维表 token（app_token）" },
      table_id: { type: "string", description: "可选，数据表 id（不传=首个表）" },
      fields: {
        type: "array",
        description: "可选，先建字段，每个 {field_name, type}",
        items: { type: "object" },
      },
      records: {
        type: "array",
        description: '记录数组，每条对象 {字段名:值}，如 [{"姓名":"小明","年龄":18}]',
        items: { type: "object" },
      },
    },
    required: ["app_token", "records"],
  },
};

export async function handleWriteBitable(args: {
  app_token: string;
  table_id?: string;
  fields?: { field_name: string; type: number }[];
  records: Record<string, string | number | boolean>[];
}) {
  try {
    const client = getFeishuClient();
    const appToken = args.app_token;
    let tableId = args.table_id;
    if (!tableId) {
      const tbl = await client.bitable.v1.appTable.list({ path: { app_token: appToken }, params: { page_size: 1 } });
      tableId = tbl.data?.items?.[0]?.table_id;
      if (!tableId) return { isError: true, content: [{ type: "text" as const, text: "拿不到数据表 id（确认 token 对、有权限）" }] };
    }

    // 建字段（可选）；已存在的字段会报错，忽略继续
    const createdFields: string[] = [];
    for (const f of args.fields ?? []) {
      try {
        await client.bitable.v1.appTableField.create({
          path: { app_token: appToken, table_id: tableId },
          data: { field_name: f.field_name, type: f.type },
        });
        createdFields.push(f.field_name);
      } catch {
        /* 字段可能已存在，跳过 */
      }
    }

    const records = (args.records ?? []).map((fields) => ({ fields }));
    if (records.length > 500) {
      return { isError: true, content: [{ type: "text" as const, text: "单次最多填 500 条记录，请分批" }] };
    }
    if (records.length === 0) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, table_id: tableId, created_fields: createdFields, created_records: 0 }) }] };
    }
    const res = await client.bitable.v1.appTableRecord.batchCreate({
      path: { app_token: appToken, table_id: tableId },
      data: { records },
    });
    if (res.code !== 0) {
      return { isError: true, content: [{ type: "text" as const, text: `填记录失败：code=${res.code} msg=${res.msg}` }] };
    }
    const n = res.data?.records?.length ?? records.length;
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, table_id: tableId, created_fields: createdFields, created_records: n }) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `填多维表失败：${msg}` }] };
  }
}
