/**
 * 飞书自带任务 v2 封装（channel 版）—— 搬自 早期版本 src/feishu/feishu-task.ts
 *
 * 以Owner user_access_token 身份建/改/删任务 + 分组。
 *
 * source-driven（对飞书 task-v2 官方文档 + SDK @larksuiteoapi/node-sdk 1.64.0）：
 * - 建任务 client.task.v2.task.create data:{summary(≤3000), members[{id,type:"user",
 *   role:"assignee"|"follower"}], due{timestamp:"ms字符串",is_all_day}, tasklists[{tasklist_guid,
 *   section_guid}]}；完成 patch data:{task:{completed_at:"ms"},update_fields:["completed_at"]}
 *   completed_at "0"=未完成；删 delete path:{task_guid}；查 get path:{task_guid}
 * - 建清单 tasklist.create data:{name(≤100)} → data.tasklist.guid（scope task:tasklist:write）
 * - 建分组 section.create data:{name,resource_type:"tasklist",resource_id:tasklist_guid}
 *   → data.section.guid（scope task:section:write）
 * - 鉴权 user_access_token 走 SDK 第二参 lark.withUserAccessToken(token)
 *
 * 清单/分组幂等：用 app_meta 缓存 name→guid（建过的复用，不重复建——解决 #49 旧痛点
 * "分组始终重复/不生效"；不依赖未对版的 list 接口）。
 *
 * 错误统一转中文引导（bot 错误自动引导硬规则）——飞书原始错误码不直接抛给最终用户。
 *
 * 本版调整：
 * - import getFeishuClient from "../tools/feishu-send.js"（不再从 ./api.js）
 * - FEISHU_OWNER_OPEN_ID 从 process.env 读（不再走 getConfig）
 */

import * as lark from "@larksuiteoapi/node-sdk";
import { getFeishuClient } from "../tools/feishu-send.js";
import { getUserToken } from "./feishu-token.js";
import { getMeta, setMeta, deleteMeta, listMetaEntries } from "../db/database.js";

const TL_CACHE_PREFIX = "feishu_tl::"; // + name
const SEC_CACHE_PREFIX = "feishu_sec::"; // + tasklistGuid::name

/** 取已授权 access_token + SDK 调用 options（未授权/失效会抛 FeishuAuthError） */
async function authOpts() {
  const token = await getUserToken();
  if (!token) {
    throw new Error("飞书任务未授权——私聊我「授权飞书任务」走一次。");
  }
  return lark.withUserAccessToken(token);
}

/** SDK 响应 code!==0 视为失败，转中文 */
function ensureOk<T extends { code?: number; msg?: string; data?: unknown }>(
  resp: T,
  what: string,
): T {
  if (resp.code !== undefined && resp.code !== 0) {
    throw new Error(`${what}失败：${resp.msg || `飞书返回 code=${resp.code}`}`);
  }
  return resp;
}

/** 幂等建清单：app_meta 缓存 name→guid，命中复用不重复建 */
export async function ensureTasklist(name: string): Promise<string> {
  const key = name.trim();
  if (!key) throw new Error("清单名为空");
  const cached = getMeta(TL_CACHE_PREFIX + key);
  if (cached) return cached;
  const client = getFeishuClient();
  const opts = await authOpts();
  const resp = ensureOk(
    await client.task.v2.tasklist.create({ data: { name: key } }, opts),
    `建清单「${key}」`,
  );
  const guid = (resp.data as { tasklist?: { guid?: string } })?.tasklist?.guid;
  if (!guid) throw new Error(`建清单「${key}」没拿到 guid（飞书响应异常）`);
  setMeta(TL_CACHE_PREFIX + key, guid);
  return guid;
}

/** 幂等建分组（归属某清单）：app_meta 缓存 tasklistGuid::name→guid */
export async function ensureSection(
  tasklistGuid: string,
  name: string,
): Promise<string> {
  const key = name.trim();
  if (!key) throw new Error("分组名为空");
  const cacheKey = `${SEC_CACHE_PREFIX}${tasklistGuid}::${key}`;
  const cached = getMeta(cacheKey);
  if (cached) return cached;
  const client = getFeishuClient();
  const opts = await authOpts();
  const resp = ensureOk(
    await client.task.v2.section.create(
      {
        data: {
          name: key,
          resource_type: "tasklist",
          resource_id: tasklistGuid,
        },
      },
      opts,
    ),
    `建分组「${key}」`,
  );
  const guid = (resp.data as { section?: { guid?: string } })?.section?.guid;
  if (!guid) throw new Error(`建分组「${key}」没拿到 guid（飞书响应异常）`);
  setMeta(cacheKey, guid);
  return guid;
}

type TaskMember = { id: string; type: "user"; role: "assignee" | "follower" };

/** 纯构造 members 数组（不含默认负责人逻辑——调用方先解析好 ownerOpenIds 再传入） */
function buildMembers(
  ownerOpenIds: string[],
  followerOpenIds: string[],
): TaskMember[] {
  const members: TaskMember[] = [];
  for (const id of ownerOpenIds)
    members.push({ id, type: "user", role: "assignee" });
  for (const id of followerOpenIds)
    members.push({ id, type: "user", role: "follower" });
  return members;
}

/** ISO8601 → 飞书 due（毫秒字符串）；空/非法 = undefined（不设截止） */
function buildDue(
  dueIso?: string,
): { timestamp: string; is_all_day: boolean } | undefined {
  if (!dueIso || !dueIso.trim()) return undefined;
  const ms = Date.parse(dueIso);
  if (Number.isNaN(ms)) return undefined;
  return { timestamp: String(ms), is_all_day: false };
}

export interface CreateTaskInput {
  summary: string;
  dueIso?: string; // ISO8601；空/无 = 不设截止
  ownerOpenIds?: string[];
  followerOpenIds?: string[];
  tasklistGuid?: string;
  sectionGuid?: string;
}

/** 建飞书任务，返回 task_guid。owner 空时默认负责人=Owner（process.env FEISHU_OWNER_OPEN_ID） */
export async function createTask(input: CreateTaskInput): Promise<string> {
  const client = getFeishuClient();
  const opts = await authOpts();
  let owners = (input.ownerOpenIds ?? []).filter((s) => s && s.trim());
  if (owners.length === 0) {
    const def = process.env.FEISHU_OWNER_OPEN_ID;
    if (def) owners = [def]; // 默认负责人Owner（品品建的是Owner的任务）
  }
  const members = buildMembers(owners, input.followerOpenIds ?? []);

  const data: {
    summary: string;
    members?: TaskMember[];
    due?: { timestamp: string; is_all_day: boolean };
    tasklists?: Array<{ tasklist_guid: string; section_guid?: string }>;
  } = { summary: input.summary };
  if (members.length > 0) data.members = members;
  const due = buildDue(input.dueIso);
  if (due) data.due = due;
  if (input.tasklistGuid) {
    const tl: { tasklist_guid: string; section_guid?: string } = {
      tasklist_guid: input.tasklistGuid,
    };
    if (input.sectionGuid) tl.section_guid = input.sectionGuid;
    data.tasklists = [tl];
  }
  const resp = ensureOk(
    await client.task.v2.task.create({ data }, opts),
    `建任务「${input.summary}」`,
  );
  const guid = (resp.data as { task?: { guid?: string } })?.task?.guid;
  if (!guid) throw new Error(`建任务「${input.summary}」没拿到 guid（飞书响应异常）`);
  return guid;
}

export interface CreateSubtaskInput {
  summary: string;
  dueIso?: string;
  ownerOpenIds?: string[];
  followerOpenIds?: string[];
}

/** 在某父任务下建子步骤（taskSubtask.create），返回 subtask_guid。
 *  子步骤的「完成」「删除」复用通用 markTaskDone / deleteTask（子任务走通用 task.patch/delete 接口）。 */
export async function createSubtask(
  parentGuid: string,
  input: CreateSubtaskInput,
): Promise<string> {
  const client = getFeishuClient();
  const opts = await authOpts();
  const members = buildMembers(
    input.ownerOpenIds ?? [],
    input.followerOpenIds ?? [],
  );
  const data: {
    summary: string;
    members?: TaskMember[];
    due?: { timestamp: string; is_all_day: boolean };
  } = { summary: input.summary };
  if (members.length > 0) data.members = members;
  const due = buildDue(input.dueIso);
  if (due) data.due = due;
  const resp = ensureOk(
    await client.task.v2.taskSubtask.create(
      { path: { task_guid: parentGuid }, data },
      opts,
    ),
    `建子步骤「${input.summary}」`,
  );
  const guid = (resp.data as { subtask?: { guid?: string } })?.subtask?.guid;
  if (!guid)
    throw new Error(`建子步骤「${input.summary}」没拿到 guid（飞书响应异常）`);
  return guid;
}

/** 标记飞书任务完成（completed_at=当前 ms）。子任务走通用接口——传 subtask_guid 即「完成子步骤」。 */
export async function markTaskDone(taskGuid: string): Promise<void> {
  const client = getFeishuClient();
  const opts = await authOpts();
  ensureOk(
    await client.task.v2.task.patch(
      {
        path: { task_guid: taskGuid },
        data: {
          task: { completed_at: String(Date.now()) },
          update_fields: ["completed_at"],
        },
      },
      opts,
    ),
    "标记任务完成",
  );
}

/** 删飞书任务。子任务走通用接口——传 subtask_guid 即「删子步骤」。 */
export async function deleteTask(taskGuid: string): Promise<void> {
  const client = getFeishuClient();
  const opts = await authOpts();
  ensureOk(
    await client.task.v2.task.delete({ path: { task_guid: taskGuid } }, opts),
    "删除任务",
  );
}

// ============ C3 扩权：查看 / 更新 / 分组管理 / 评论 ============
// 方法名经 SDK 1.65 client.task.v2 实例 introspect 核实（source-driven）：
//   task.{list,get,patch,addMembers,removeMembers,addTasklist}
//   tasklist.{list,tasks}  section.{list,tasks,delete,patch}  comment.{create,list}
// 调用形：path=guid / data=body / params=query（沿用本文件 create/patch 已验证惯例）。

export interface TaskBrief {
  guid: string;
  summary: string;
  completed: boolean;
  due_ms?: string;
}

function toBrief(t: Record<string, unknown>): TaskBrief {
  const due = (t.due as { timestamp?: string } | undefined)?.timestamp;
  const completedAt = (t.completed_at as string | undefined) ?? "0";
  return {
    guid: String(t.guid ?? ""),
    summary: String(t.summary ?? ""),
    completed: completedAt !== "0" && completedAt !== "",
    ...(due ? { due_ms: due } : {}),
  };
}

/** 列任务（默认列未完成；includeCompleted=true 含已完成）。返回精简列表。 */
export async function listTasks(includeCompleted = false): Promise<TaskBrief[]> {
  const client = getFeishuClient();
  const opts = await authOpts();
  const resp = ensureOk(
    await client.task.v2.task.list(
      { params: { page_size: 50, completed: includeCompleted ? undefined : false, user_id_type: "open_id" } },
      opts,
    ),
    "列任务",
  );
  const items = (resp.data as { items?: Array<Record<string, unknown>> })?.items ?? [];
  return items.map(toBrief);
}

/** 查单个任务详情（含 members / due / 完成态 / 备注）。 */
export async function getTaskDetail(taskGuid: string): Promise<Record<string, unknown>> {
  const client = getFeishuClient();
  const opts = await authOpts();
  const resp = ensureOk(
    await client.task.v2.task.get(
      { path: { task_guid: taskGuid }, params: { user_id_type: "open_id" } },
      opts,
    ),
    "查任务详情",
  );
  return ((resp.data as { task?: Record<string, unknown> })?.task ?? {}) as Record<string, unknown>;
}

/** 列所有清单（name + guid）。 */
export async function listTasklists(): Promise<Array<{ guid: string; name: string }>> {
  const client = getFeishuClient();
  const opts = await authOpts();
  const resp = ensureOk(
    await client.task.v2.tasklist.list({ params: { page_size: 50, user_id_type: "open_id" } }, opts),
    "列清单",
  );
  const items = (resp.data as { items?: Array<Record<string, unknown>> })?.items ?? [];
  return items.map((t) => ({ guid: String(t.guid ?? ""), name: String(t.name ?? "") }));
}

/** 列某清单下的任务。 */
export async function listTasklistTasks(tasklistGuid: string): Promise<TaskBrief[]> {
  const client = getFeishuClient();
  const opts = await authOpts();
  const resp = ensureOk(
    await client.task.v2.tasklist.tasks(
      { path: { tasklist_guid: tasklistGuid }, params: { page_size: 50 } },
      opts,
    ),
    "列清单任务",
  );
  const items = (resp.data as { items?: Array<Record<string, unknown>> })?.items ?? [];
  return items.map(toBrief);
}

/** 列某清单下的分组（name + guid）。 */
export async function listSections(tasklistGuid: string): Promise<Array<{ guid: string; name: string }>> {
  const client = getFeishuClient();
  const opts = await authOpts();
  const resp = ensureOk(
    await client.task.v2.section.list(
      { params: { resource_type: "tasklist", resource_id: tasklistGuid, page_size: 50 } },
      opts,
    ),
    "列分组",
  );
  const items = (resp.data as { items?: Array<Record<string, unknown>> })?.items ?? [];
  return items.map((s) => ({ guid: String(s.guid ?? ""), name: String(s.name ?? "") }));
}

/** 列某分组下的任务。 */
export async function listSectionTasks(sectionGuid: string): Promise<TaskBrief[]> {
  const client = getFeishuClient();
  const opts = await authOpts();
  const resp = ensureOk(
    await client.task.v2.section.tasks(
      { path: { section_guid: sectionGuid }, params: { page_size: 50 } },
      opts,
    ),
    "列分组任务",
  );
  const items = (resp.data as { items?: Array<Record<string, unknown>> })?.items ?? [];
  return items.map(toBrief);
}

export interface UpdateTaskInput {
  summary?: string;
  dueIso?: string; // 传空字符串 "" = 清除截止
  description?: string;
}

/** 更新任务字段（summary / due / description）。只更新传入的字段。 */
export async function updateTask(taskGuid: string, input: UpdateTaskInput): Promise<void> {
  const client = getFeishuClient();
  const opts = await authOpts();
  const task: Record<string, unknown> = {};
  const updateFields: string[] = [];
  if (input.summary !== undefined) {
    task.summary = input.summary;
    updateFields.push("summary");
  }
  if (input.dueIso !== undefined) {
    const due = buildDue(input.dueIso);
    task.due = due ?? null; // null = 清除截止
    updateFields.push("due");
  }
  if (input.description !== undefined) {
    task.description = input.description;
    updateFields.push("description");
  }
  if (updateFields.length === 0) throw new Error("更新任务：没有要改的字段");
  ensureOk(
    await client.task.v2.task.patch(
      { path: { task_guid: taskGuid }, data: { task, update_fields: updateFields } },
      opts,
    ),
    "更新任务",
  );
}

/** 改任务负责人/关注人：add 加成员，remove 去成员。role 默认 assignee。 */
export async function setTaskMembers(
  taskGuid: string,
  addOpenIds: string[],
  removeOpenIds: string[],
  role: "assignee" | "follower" = "assignee",
): Promise<void> {
  const client = getFeishuClient();
  const opts = await authOpts();
  if (addOpenIds.length > 0) {
    ensureOk(
      await client.task.v2.task.addMembers(
        {
          path: { task_guid: taskGuid },
          data: { members: addOpenIds.map((id) => ({ id, type: "user", role })) },
        },
        opts,
      ),
      "加任务成员",
    );
  }
  if (removeOpenIds.length > 0) {
    ensureOk(
      await client.task.v2.task.removeMembers(
        {
          path: { task_guid: taskGuid },
          data: { members: removeOpenIds.map((id) => ({ id, type: "user", role })) },
        },
        opts,
      ),
      "去任务成员",
    );
  }
}

/**
 * 真·移动任务到目标清单（可指定分组）。
 * 飞书 addTasklist 只是「追加归属」（任务可同属多清单），所以真移动 = 先加目标、再把所有非目标清单 removeTasklist 掉。
 * 这样移动后原清单不再有该任务。先查任务当前所属清单（task.get → data.task.tasklists[]），
 * 对每个 tasklist_guid≠目标的调 removeTasklist。removeTasklist 容错（单个失败不阻断整体）。
 */
export async function moveTaskToTasklist(
  taskGuid: string,
  tasklistGuid: string,
  sectionGuid?: string,
): Promise<void> {
  const client = getFeishuClient();
  const opts = await authOpts();
  // 1. 先查当前所属清单（移除前快照）
  const detail = await getTaskDetail(taskGuid);
  const oldTasklists = ((detail.tasklists as Array<{ tasklist_guid?: string }> | undefined) ?? [])
    .map((t) => t.tasklist_guid)
    .filter((g): g is string => !!g && g !== tasklistGuid);
  // 2. 加入目标清单/分组
  const data: { tasklist_guid: string; section_guid?: string } = { tasklist_guid: tasklistGuid };
  if (sectionGuid) data.section_guid = sectionGuid;
  ensureOk(
    await client.task.v2.task.addTasklist({ path: { task_guid: taskGuid }, data }, opts),
    "加入目标清单/分组",
  );
  // 3. 从所有原清单移除（真移动语义）。单个失败不阻断——目标已加入，残留原归属退化为「追加」，可接受
  for (const oldGuid of oldTasklists) {
    try {
      ensureOk(
        await client.task.v2.task.removeTasklist(
          { path: { task_guid: taskGuid }, data: { tasklist_guid: oldGuid } },
          opts,
        ),
        "从原清单移除",
      );
    } catch (e) {
      process.stderr.write(
        `[feishu-task] 移动任务：从原清单 ${oldGuid} 移除失败但目标已加入：${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
}

/** 删分组（section.delete）。分组里的任务不删，只解除分组归属。 */
export async function deleteSection(sectionGuid: string): Promise<void> {
  const client = getFeishuClient();
  const opts = await authOpts();
  ensureOk(
    await client.task.v2.section.delete({ path: { section_guid: sectionGuid } }, opts),
    "删除分组",
  );
}

/** 删清单（tasklist.delete）。同时清掉指向它的 name→guid 缓存（含其下分组缓存），避免下次同名复用拿到死 guid。 */
export async function deleteTasklist(tasklistGuid: string): Promise<void> {
  const client = getFeishuClient();
  const opts = await authOpts();
  ensureOk(
    await client.task.v2.tasklist.delete({ path: { tasklist_guid: tasklistGuid } }, opts),
    "删除清单",
  );
  // 清缓存：TL_CACHE 里 value===guid 的条目 + SEC_CACHE 里 key 含该 tasklistGuid 的条目
  for (const { key, value } of listMetaEntries()) {
    if (key.startsWith(TL_CACHE_PREFIX) && value === tasklistGuid) deleteMeta(key);
    else if (key.startsWith(`${SEC_CACHE_PREFIX}${tasklistGuid}::`)) deleteMeta(key);
  }
}

/** 给任务加评论（comment.create）。 */
export async function addTaskComment(taskGuid: string, content: string): Promise<void> {
  const client = getFeishuClient();
  const opts = await authOpts();
  ensureOk(
    await client.task.v2.comment.create(
      { data: { content, resource_type: "task", resource_id: taskGuid } },
      opts,
    ),
    "加评论",
  );
}

/** 列任务评论（comment.list）。返回 content 列表。 */
export async function listTaskComments(taskGuid: string): Promise<string[]> {
  const client = getFeishuClient();
  const opts = await authOpts();
  const resp = ensureOk(
    await client.task.v2.comment.list(
      { params: { resource_type: "task", resource_id: taskGuid, page_size: 50 } },
      opts,
    ),
    "列评论",
  );
  const items = (resp.data as { items?: Array<Record<string, unknown>> })?.items ?? [];
  return items.map((c) => String(c.content ?? ""));
}

/** 任务在飞书侧已不存在（被删/查不到）。SDK 抛 AxiosError，
 *  e.response.data.code=1470404（任务不存在）/ HTTP 404。删/标完成时遇此
 *  视为"已经没了=幂等成功"，不当错误。 */
export function isTaskGoneError(e: unknown): boolean {
  const any = e as {
    response?: { status?: number; data?: { code?: number } };
  };
  return (
    any?.response?.data?.code === 1470404 || any?.response?.status === 404
  );
}
