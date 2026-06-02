/**
 * 飞书多维表格 API 封装（channel 版精简）
 *
 * 仅含核心 2 函数：createBitable / makeBitableShareable
 * 早期版本 165 行的完整 createTable / addFields / batchCreateRecords 等暂未搬迁
 * （Owner罕用，按需后续补）。
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

/** 设多维表格为"组织内有链接可阅读"，不设则品品建完别人点开 403 */
export async function makeBitableShareable(appToken: string): Promise<void> {
  const client = getFeishuClient();
  try {
    const res = await client.drive.v1.permissionPublic.patch({
      path: { token: appToken },
      params: { type: "bitable" },
      data: { link_share_entity: "tenant_readable" },
    });
    if (res.code !== 0) {
      console.warn(
        `[bitable] 设共享权限失败 code=${res.code} msg=${res.msg}——表格已建但可能仅创建者可见`,
      );
    }
  } catch (e) {
    console.warn(
      "[bitable] 设共享权限异常（表格已建，可能仅创建者可见）:",
      e instanceof Error ? e.message : e,
    );
  }
}
