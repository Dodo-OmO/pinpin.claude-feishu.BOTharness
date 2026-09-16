// 审批定义订阅：飞书只给"应用已订阅的 approval_code"推实例/任务事件，故启动时按 vault 的审批定义清单逐个订阅。
// 清单 `vault\Client\审批定义.json` 由品品用Owner身份 `lark-cli approval approvals search` 刷新（周收官 SOP）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as Lark from '@larksuiteoapi/node-sdk';

export interface ApprovalDefinition {
  /** true 才订阅它的事件；默认不订，防全公司审批流灌进来 */
  watch?: boolean;
  approval_code: string;
  approval_name: string;
}

export function readApprovalDefinitions(vaultCwd: string): ApprovalDefinition[] {
  const file = path.join(vaultCwd, 'Client', '审批定义.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { approvals?: ApprovalDefinition[] };
    // 只订标了 watch:true 的：全租户的审批流都会推过来（各分部的加班单），全订 = 刷爆豆姐私聊。
    return (raw.approvals ?? []).filter((a) => typeof a.approval_code === 'string' && a.approval_code && a.watch === true);
  } catch {
    return [];
  }
}

/** 已订阅过的 approval_code 记在本机：飞书订阅是持久的，重复订阅会回 1390007，SDK 在抛出前还会打一条 [error] 刷日志 */
const SUBSCRIBED_FILE = path.join(os.homedir(), '.pinpin', 'approval-subscribed.json');

function readSubscribed(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(SUBSCRIBED_FILE, 'utf8')) as string[]);
  } catch {
    return new Set();
  }
}

/** 逐个订阅（本机记过的跳过）；已订阅 / 无权限的单条失败只记日志不中断。返回成功数（含跳过）。 */
export async function subscribeApprovalDefinitions(client: Lark.Client, defs: ApprovalDefinition[]): Promise<number> {
  const done = readSubscribed();
  const before = done.size;
  let ok = 0;
  for (const d of defs) {
    if (done.has(d.approval_code)) { ok++; continue; }
    try {
      await client.approval.v4.approval.subscribe({ path: { approval_code: d.approval_code } });
      ok++;
      done.add(d.approval_code);
    } catch (e) {
      const code = (e as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
      // 1390007 = 已订阅（幂等），不算失败
      if (code?.code === 1390007) { ok++; done.add(d.approval_code); continue; }
      process.stderr.write(`[approval] 订阅失败 ${d.approval_name}(${d.approval_code.slice(0, 8)}…): ${code?.msg ?? (e instanceof Error ? e.message : e)}
`);
    }
  }
  if (done.size !== before) {
    try {
      fs.mkdirSync(path.dirname(SUBSCRIBED_FILE), { recursive: true });
      fs.writeFileSync(SUBSCRIBED_FILE, JSON.stringify([...done]), 'utf8');
    } catch { /* 记不下只是下次多订一次，不影响功能 */ }
  }
  return ok;
}

/** 审批状态 → 人话 */
export function approvalStatusZh(status: string): string {
  const map: Record<string, string> = {
    PENDING: '待审批', APPROVED: '已通过', REJECTED: '已拒绝', CANCELED: '已撤回', DELETED: '已删除',
    REVERTED: '已撤销', TRANSFERRED: '已转交', DONE: '已处理',
  };
  return map[status] ?? status;
}
