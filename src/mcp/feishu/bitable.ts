/**
 * 飞书多维表格 API 封装（channel 版精简）
 * createBitable：建空多维表（create_cloud_doc format=bitable 复用）。
 * 权限设置走 feishu/cloud-doc-ops.ts 的 makeShareable；填数据走 tools/write-bitable.ts。
 */

import { getFeishuClient } from "../tools/feishu-send.js";

export async function createBitable(
  name: string,
  folderToken?: string,
): Promise<{ appToken: string; defaultTableId: string; url: string }> {
  const client = getFeishuClient();
  const res = await client.bitable.v1.app.create({
    data: { name, folder_token: folderToken },
  });
  if (res.code !== 0) throw new Error(`createBitable failed: code=${res.code} msg=${res.msg}`);
  const app = res.data?.app;
  if (!app?.app_token || !app.default_table_id) {
    throw new Error("createBitable: missing app_token/default_table_id");
  }
  return {
    appToken: app.app_token,
    defaultTableId: app.default_table_id,
    url: app.url || `https://feishu.cn/base/${app.app_token}`,
  };
}
