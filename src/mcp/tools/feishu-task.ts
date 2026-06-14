/**
 * 飞书自带任务 6 tool（搬自 早期版本 custom-tools L676-1282）
 *
 * - feishu_authorize / feishu_submit_auth_code：OAuth 一年一次手动贴码
 * - feishu_task_create / done / delete / subtask_add：核心 4 tool 含 OB 台账双写
 *
 * 适配 channel 版：
 *   chat.id → process.env.PINPIN_CHAT_ID
 *   getConfig().DAILY_BRIEFING_TASK_FILE → process.env.DAILY_BRIEFING_TASK_FILE
 *   appendBotReply(chat.name, ...) → appendBotReply(chatId, ...)
 *
 * 错误统一转中文（bot 错误自动引导硬规则）
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ensureTasklist,
  ensureSection,
  createTask,
  createSubtask,
  markTaskDone,
  deleteTask,
  isTaskGoneError,
  listTasks,
  getTaskDetail,
  listTasklists,
  listTasklistTasks,
  listSections,
  listSectionTasks,
  updateTask,
  setTaskMembers,
  moveTaskToTasklist,
  deleteSection,
  deleteTasklist,
  addTaskComment,
  listTaskComments,
  type TaskBrief,
} from "../feishu/feishu-task.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
} from "../feishu/feishu-token.js";
import {
  insertFeishuTaskMap,
  listOpenFeishuTaskMaps,
  getFeishuTaskMap,
  markFeishuTaskMapDone,
  deleteFeishuTaskMap,
  resolveOpenId,
  listKnownUsers,
} from "../db/database.js";
import {
  writeLedger,
  findOpenLedgerSubtasks,
  markLedgerSubtaskDone,
  collectLedgerSubtaskGuids,
  removeLedgerTask,
  appendLedgerSubtasks,
  applyTaskDoneToOB,
} from "../utils/ob-task-writeback.js";
import { appendBotReply } from "../utils/chat-log.js";
import { dateYYYYMMDD } from "../utils/helper.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const textErr = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });
const textOk = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

// ───────────────────────────────────────────────────────────
// feishu_authorize / feishu_submit_auth_code
// ───────────────────────────────────────────────────────────

export const FEISHU_AUTHORIZE_TOOL: Tool = {
  name: "feishu_authorize",
  description:
    "Owner说『授权飞书任务』时调：生成授权链接发给她，她点完同意后复制地址栏 code= 后那串发回，" +
    "你再调 feishu_submit_auth_code 完成。一年一次。",
  inputSchema: { type: "object", properties: {} },
};

export async function handleFeishuAuthorize(): Promise<ToolResult> {
  try {
    const { url } = buildAuthorizeUrl();
    return textOk(
      `好的～点这个链接授权飞书任务（一年就这一次）：\n${url}\n\n` +
        `点完「同意」后浏览器会跳到一个网址（打不开是正常的，别管），` +
        `把那个网址里 code= 后面那一串复制下来发我就行。`,
    );
  } catch (e) {
    return textErr(e instanceof Error ? e.message : String(e));
  }
}

export const FEISHU_SUBMIT_AUTH_CODE_TOOL: Tool = {
  name: "feishu_submit_auth_code",
  description:
    "Owner把飞书授权码发回时调（她会发一串字母数字或说『授权码是 xxx』），把 code 原样传入完成授权。失败返回的引导话术转述给Owner。",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "Owner从浏览器地址栏 code= 后复制的授权码串" },
    },
    required: ["code"],
  },
};

export async function handleFeishuSubmitAuthCode(args: { code: string }): Promise<ToolResult> {
  try {
    await exchangeCodeForToken(args.code);
    return textOk(
      "飞书任务授权成功啦～管一年，到期我会私聊提醒你再点一次。",
    );
  } catch (e) {
    return textErr(e instanceof Error ? e.message : String(e));
  }
}

// ───────────────────────────────────────────────────────────
// 人名→open_id 反查辅助
// ───────────────────────────────────────────────────────────

function resolveNames(names?: string[]): { ids: string[]; bad: string[] } {
  const ids: string[] = [];
  const bad: string[] = [];
  for (const n of names ?? []) {
    const id = resolveOpenId(n);
    if (id) ids.push(id);
    else bad.push(n);
  }
  return { ids, bad };
}

function getChatId(): string {
  return process.env.PINPIN_CHAT_ID ?? "unknown";
}

function getObFile(): string | undefined {
  const p = process.env.DAILY_BRIEFING_TASK_FILE;
  return p && p.trim() ? p.trim() : undefined;
}

// ───────────────────────────────────────────────────────────
// feishu_task_create
// ───────────────────────────────────────────────────────────

export const FEISHU_TASK_CREATE_TOOL: Tool = {
  name: "feishu_task_create",
  description:
    "建飞书自带任务（以Owner身份，需先授权）+ 同步写本地台账（双写自动，存真实 guid 锚）。" +
    "用于Owner说『建个任务 X』『给User A派任务下周五截止』。tasklist_name/section_name 同名自动复用；" +
    "subtasks 逐个建为子任务+台账缩进行。\n" +
    "**新建任务时先确认 已有清单，同分类建在同清单下**\n" +
    "**不确定分类时主动回问Owner，对齐再建**",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "任务标题" },
      due_iso: {
        type: "string",
        description: "截止 ISO8601 如 2026-05-20T18:00:00+08:00；无截止传空字符串",
      },
      owner_names: {
        type: "array",
        items: { type: "string" },
        description: "（可选）负责人名字列表，自动反查飞书账号；不传默认负责人Owner",
      },
      follower_names: {
        type: "array",
        items: { type: "string" },
        description: "（可选）关注人名字列表，自动反查",
      },
      tasklist_name: {
        type: "string",
        description: "（可选）清单/项目名，同名自动复用；也作本地台账 ## 项目，不传归「未分类」",
      },
      section_name: {
        type: "string",
        description: "（可选）清单下分组名，同名自动复用",
      },
      subtasks: {
        type: "array",
        items: { type: "string" },
        description: "（可选）子步骤描述列表，按顺序建为飞书子任务 + 台账缩进子步骤行",
      },
    },
    required: ["summary", "due_iso"],
  },
};

export async function handleFeishuTaskCreate(args: {
  summary: string;
  due_iso: string;
  owner_names?: string[];
  follower_names?: string[];
  tasklist_name?: string;
  section_name?: string;
  subtasks?: string[];
}): Promise<ToolResult> {
  const chatId = getChatId();
  const o = resolveNames(args.owner_names);
  const f = resolveNames(args.follower_names);
  const bad = [...o.bad, ...f.bad];
  if (bad.length > 0) {
    const known = listKnownUsers().map((u) => u.name).join("、");
    return textErr(
      `这些人我还不认识飞书账号，没法加进任务：${bad.join("、")}。` +
        `我目前认识：${known || "（还没记住任何人）"}。让 ta 在群里说句话我就记住了～`,
    );
  }
  const obFile = getObFile();
  if (!obFile) {
    return textErr(
      "还没配本地任务台账文件（DAILY_BRIEFING_TASK_FILE），没法两边同步。" +
        "先在 .env 把台账路径配好我再建任务，免得飞书建了本地没记上。",
    );
  }
  let taskGuid: string | undefined;
  const createdSubGuids: string[] = [];
  try {
    let tlGuid: string | undefined;
    let secGuid: string | undefined;
    let groupNote = "";
    if (args.tasklist_name && args.tasklist_name.trim()) {
      try {
        tlGuid = await ensureTasklist(args.tasklist_name);
        if (args.section_name && args.section_name.trim()) {
          secGuid = await ensureSection(tlGuid, args.section_name);
        }
      } catch (e) {
        groupNote = `（注：分组没归上——${e instanceof Error ? e.message : e}，任务已建好只是暂未分类）`;
        tlGuid = undefined;
        secGuid = undefined;
      }
    }
    taskGuid = await createTask({
      summary: args.summary,
      dueIso: args.due_iso || undefined,
      ownerOpenIds: o.ids,
      followerOpenIds: f.ids,
      tasklistGuid: tlGuid,
      sectionGuid: secGuid,
    });
    const subLines: string[] = [];
    for (const desc of args.subtasks ?? []) {
      const d = desc.trim();
      if (!d) continue;
      const subGuid = await createSubtask(taskGuid, { summary: d });
      createdSubGuids.push(subGuid);
      subLines.push(`    - [ ] ${d} <!--fts:${subGuid}-->`);
    }
    const today = dateYYYYMMDD();
    const ownerLabel =
      args.owner_names && args.owner_names.length > 0 ? args.owner_names.join("、") : "Owner";
    let dueSeg = "";
    if (args.due_iso && args.due_iso.trim()) {
      const dms = Date.parse(args.due_iso);
      if (!Number.isNaN(dms)) dueSeg = `｜截止:${dateYYYYMMDD(new Date(dms))}`;
    }
    const parentLine =
      `- [ ] ${args.summary}｜负责：${ownerLabel}｜状态：进行中${dueSeg}` +
      `｜[创建:${today}] <!--ft:${taskGuid}-->`;
    const project =
      args.tasklist_name && args.tasklist_name.trim()
        ? args.tasklist_name.trim()
        : "未分类";
    try {
      writeLedger(obFile, project, args.section_name, parentLine, subLines);
    } catch (we) {
      return textErr(
        `飞书任务「${args.summary}」建好了（含 ${subLines.length} 个子步骤），` +
          `但本地台账没写成：${we instanceof Error ? we.message : we}。` +
          `这条暂没进本地清单——请让品品删除该任务后重建，或手动补到「${project}」台账。`,
      );
    }
    insertFeishuTaskMap({
      taskGuid,
      summary: args.summary,
      obFile,
      obMarker: taskGuid,
    });
    appendBotReply(
      chatId,
      `[建飞书任务「${args.summary}」+${subLines.length}子步骤] guid=${taskGuid}`,
    );
    const subNote = subLines.length > 0 ? `，含 ${subLines.length} 个子步骤` : "";
    return textOk(
      `已在飞书任务中心建好「${args.summary}」${subNote}${groupNote}，` +
        `本地台账「${project}」${args.section_name && args.section_name.trim() ? `分组「${args.section_name.trim()}」` : ""}也同步写好了（带隐藏锚，Owner飞书勾完成同步回来）。本次无需文字复述。`,
    );
  } catch (e) {
    if (taskGuid) {
      // 倒序删已建子任务（官方未明确删父是否级联，走最稳路径），每个失败吞错继续
      for (const sg of [...createdSubGuids].reverse()) {
        try { await deleteTask(sg); } catch { /* 吞错继续 */ }
      }
      try { await deleteTask(taskGuid); } catch { /* 吞错继续 */ }
    }
    return textErr(
      `建飞书任务没成：${e instanceof Error ? e.message : String(e)}。` +
        `本地台账没动，等飞书那边好了再让我重建。`,
    );
  }
}

// ───────────────────────────────────────────────────────────
// feishu_task_done
// ───────────────────────────────────────────────────────────

export const FEISHU_TASK_DONE_TOOL: Tool = {
  name: "feishu_task_done",
  description:
    "标飞书任务或子步骤完成 + 同步本地台账。keyword 同时匹配任务标题和子步骤描述：命中子步骤=只完成那一步；命中整任务=直接整条完成。",
  inputSchema: {
    type: "object",
    properties: {
      keyword: {
        type: "string",
        description: "任务标题或子步骤描述关键词（匹配品品建过、还没完成的）",
      },
    },
    required: ["keyword"],
  },
};

export async function handleFeishuTaskDone(args: { keyword: string }): Promise<ToolResult> {
  const chatId = getChatId();
  try {
    const obFile = getObFile() ?? "";
    const k = args.keyword.trim().toLowerCase();
    const subHits = obFile ? findOpenLedgerSubtasks(obFile, args.keyword) : [];
    const parentHits = listOpenFeishuTaskMaps().filter((r) =>
      r.summary.toLowerCase().includes(k),
    );
    const total = subHits.length + parentHits.length;
    if (total === 0) {
      return textOk(`没找到我建过、还没完成、含「${args.keyword}」的飞书任务或子步骤（可能已完成或不是我建的）。`);
    }
    if (total > 1) {
      const subDesc = subHits.map((s) => `子步骤「${s.desc}」`);
      const parDesc = parentHits.map((p) => `任务「${p.summary}」`);
      return textOk(`匹配到多条：${[...parDesc, ...subDesc].join(" / ")}。说具体点是哪条？`);
    }

    // 子步骤路径
    if (subHits.length === 1) {
      const sub = subHits[0];
      try {
        await markTaskDone(sub.subGuid);
      } catch (e) {
        if (!isTaskGoneError(e)) throw e;
      }
      const r = markLedgerSubtaskDone(obFile, sub.subGuid);
      if (!r) {
        return textOk(`飞书子步骤「${sub.desc}」标完成了，但本地台账里没找到它对应的行（可能被手动改过），台账这步没勾上，其它不受影响。`);
      }
      if (r.allDone && r.parentMarker) {
        const pm = getFeishuTaskMap(r.parentMarker);
        try {
          await markTaskDone(r.parentMarker);
        } catch (e) {
          if (!isTaskGoneError(e)) throw e;
        }
        try {
          applyTaskDoneToOB(obFile, r.parentMarker);
        } catch (e) {
          console.warn(
            "[feishu_task_done] 父任务本地回写失败（飞书已标完成）:",
            e instanceof Error ? e.message : e,
          );
        }
        if (pm) markFeishuTaskMapDone(r.parentMarker);
        appendBotReply(chatId, `[子步骤完成→父任务联动完成「${pm?.summary ?? r.parentMarker}」]`);
        return textOk(`子步骤「${sub.desc}」完成～这条任务所有子步骤都做完了，我把整个任务也标完成了，两边同步好了。`);
      }
      appendBotReply(chatId, `[子步骤完成「${sub.desc}」]`);
      return textOk(`子步骤「${sub.desc}」标完成了，飞书和本地都勾上～这条任务还有没做完的子步骤，整体先不算完。`);
    }

    // 整任务路径
    const t = parentHits[0];
    try {
      await markTaskDone(t.task_guid);
    } catch (e) {
      if (!isTaskGoneError(e)) throw e;
    }
    if (t.ob_file && t.ob_marker) {
      try {
        applyTaskDoneToOB(t.ob_file, t.ob_marker);
      } catch (e) {
        console.warn(
          "[feishu_task_done] 本地台账回写失败（飞书侧已标完成）:",
          e instanceof Error ? e.message : e,
        );
      }
    }
    markFeishuTaskMapDone(t.task_guid);
    appendBotReply(chatId, `[飞书任务标完成「${t.summary}」]`);
    return textOk(`已把飞书任务「${t.summary}」标完成，本地台账也同步勾上了。`);
  } catch (e) {
    return textErr(e instanceof Error ? e.message : String(e));
  }
}

// ───────────────────────────────────────────────────────────
// feishu_task_delete
// ───────────────────────────────────────────────────────────

export const FEISHU_TASK_DELETE_TOOL: Tool = {
  name: "feishu_task_delete",
  description:
    "删飞书任务（含所有子步骤）+ 删本地台账行 + 删映射——两边不留痕。",
  inputSchema: {
    type: "object",
    properties: {
      keyword: { type: "string", description: "任务标题关键词（匹配品品建过、还在的飞书任务）" },
    },
    required: ["keyword"],
  },
};

export async function handleFeishuTaskDelete(args: { keyword: string }): Promise<ToolResult> {
  const chatId = getChatId();
  try {
    const k = args.keyword.trim().toLowerCase();
    const hits = listOpenFeishuTaskMaps().filter((r) =>
      r.summary.toLowerCase().includes(k),
    );
    if (hits.length === 0) {
      return textOk(`没找到我建过、含「${args.keyword}」的飞书任务（可能已删/已完成或不是我建的）。`);
    }
    if (hits.length > 1) {
      return textOk(`匹配到多条：${hits.map((h) => h.summary).join(" / ")}。说具体点是哪条？`);
    }
    const t = hits[0];
    const subGuids = t.ob_file ? collectLedgerSubtaskGuids(t.ob_file, t.task_guid) : [];
    for (const sg of subGuids) {
      try {
        await deleteTask(sg);
      } catch (e) {
        if (isTaskGoneError(e)) continue;
        return textErr(`删子步骤时飞书报错：${e instanceof Error ? e.message : String(e)}。本地台账没动，等飞书那边好了再删一次。`);
      }
    }
    try {
      await deleteTask(t.task_guid);
    } catch (e) {
      if (!isTaskGoneError(e)) {
        return textErr(`删飞书任务报错：${e instanceof Error ? e.message : String(e)}。本地台账没动，等飞书那边好了再删一次。`);
      }
    }
    const removed = t.ob_file ? removeLedgerTask(t.ob_file, t.task_guid) : false;
    deleteFeishuTaskMap(t.task_guid);
    appendBotReply(chatId, `[删飞书任务「${t.summary}」+${subGuids.length}子步骤]`);
    const localNote = removed
      ? "本地台账那条（含子步骤）也删了"
      : "（本地台账里没找到对应行，可能已被手动清过）";
    return textOk(`已把飞书任务「${t.summary}」连同 ${subGuids.length} 个子步骤删掉，${localNote}，两边都不留痕。`);
  } catch (e) {
    return textErr(e instanceof Error ? e.message : String(e));
  }
}

// ───────────────────────────────────────────────────────────
// feishu_subtask_add
// ───────────────────────────────────────────────────────────

export const FEISHU_SUBTASK_ADD_TOOL: Tool = {
  name: "feishu_subtask_add",
  description:
    "给品品建过的飞书任务追加子步骤（边做边拆）。同步建飞书子任务 + 写台账缩进行（带真实 guid 锚）。",
  inputSchema: {
    type: "object",
    properties: {
      task_keyword: { type: "string", description: "父任务标题关键词（匹配品品建过、还在的飞书任务）" },
      subtasks: { type: "array", items: { type: "string" }, description: "要追加的子步骤描述列表（≥1 条）", minItems: 1 },
    },
    required: ["task_keyword", "subtasks"],
  },
};

export async function handleFeishuSubtaskAdd(args: {
  task_keyword: string;
  subtasks: string[];
}): Promise<ToolResult> {
  const chatId = getChatId();
  try {
    const k = args.task_keyword.trim().toLowerCase();
    const hits = listOpenFeishuTaskMaps().filter((r) =>
      r.summary.toLowerCase().includes(k),
    );
    if (hits.length === 0) {
      return textOk(`没找到我建过、含「${args.task_keyword}」的飞书任务（可能已删/完成或不是我建的）。`);
    }
    if (hits.length > 1) {
      return textOk(`匹配到多条：${hits.map((h) => h.summary).join(" / ")}。说具体点是哪条？`);
    }
    const t = hits[0];
    const clean = args.subtasks.map((s) => s.trim()).filter((s) => s);
    if (clean.length === 0) {
      return textOk("没收到有效的子步骤描述（都是空的），没加。");
    }
    const created: { guid: string; desc: string }[] = [];
    try {
      for (const desc of clean) {
        const sg = await createSubtask(t.task_guid, { summary: desc });
        created.push({ guid: sg, desc });
      }
    } catch (e) {
      for (const c of created) {
        try {
          await deleteTask(c.guid);
        } catch {
          /* 回滚失败吞掉 */
        }
      }
      return textErr(`追加子步骤时飞书报错：${e instanceof Error ? e.message : String(e)}。本地台账没动，等飞书那边好了再加一次。`);
    }
    const subLines = created.map((c) => `    - [ ] ${c.desc} <!--fts:${c.guid}-->`);
    const wrote = t.ob_file ? appendLedgerSubtasks(t.ob_file, t.task_guid, subLines) : false;
    appendBotReply(chatId, `[追加子步骤「${t.summary}」+${created.length}]`);
    const localNote = wrote
      ? "本地台账也接上了"
      : "（本地台账里没找到这条父任务的锚，子步骤进了飞书但台账没接上——请让品品删除该任务后重建，或手动在飞书侧处理）";
    return textOk(`已给「${t.summary}」追加 ${created.length} 个子步骤，飞书子任务建好了，${localNote}。本次无需文字复述。`);
  } catch (e) {
    return textErr(`追加子步骤时出了点问题（${e instanceof Error ? e.message : String(e)}）。本地台账没动，过会儿再试一次，或跟我说下具体哪步要加我重来。`);
  }
}

// ───────────────────────────────────────────────────────────
// feishu_task_query —— 看飞书任务系统全貌（只读，含非品品建的任务）
// ───────────────────────────────────────────────────────────

function fmtBriefList(items: TaskBrief[]): string {
  if (items.length === 0) return "（空）";
  return items
    .map((t, i) => {
      const due = t.due_ms ? `｜截止 ${dateYYYYMMDD(new Date(Number(t.due_ms)))}` : "";
      return `${i + 1}. [${t.completed ? "✓已完成" : "进行中"}] ${t.summary}${due}  #${t.guid}`;
    })
    .join("\n");
}

export const FEISHU_TASK_QUERY_TOOL: Tool = {
  name: "feishu_task_query",
  description: "读查飞书任务系统（含别人/非品品建的）。需先授权。guid 从上一次 list 结果的 #guid 拿。",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["my_tasks", "task_detail", "tasklists", "tasklist_tasks", "sections", "section_tasks", "comments"],
        description: "my_tasks=列任务 / task_detail=查详情(需task_guid) / tasklists=列清单 / tasklist_tasks=列清单任务(需tasklist_guid) / sections=列分组(需tasklist_guid) / section_tasks=列分组任务(需section_guid) / comments=列评论(需task_guid)",
      },
      task_guid: { type: "string", description: "task_detail / comments 用" },
      tasklist_guid: { type: "string", description: "tasklist_tasks / sections 用" },
      section_guid: { type: "string", description: "section_tasks 用" },
      include_completed: { type: "boolean", description: "my_tasks 是否含已完成（默认否）" },
    },
    required: ["mode"],
  },
};

export async function handleFeishuTaskQuery(args: {
  mode: string;
  task_guid?: string;
  tasklist_guid?: string;
  section_guid?: string;
  include_completed?: boolean;
}): Promise<ToolResult> {
  try {
    switch (args.mode) {
      case "my_tasks": {
        const items = await listTasks(args.include_completed ?? false);
        return textOk(`你的任务（${items.length} 条）：\n${fmtBriefList(items)}`);
      }
      case "task_detail": {
        if (!args.task_guid) return textErr("查任务详情要传 task_guid（从列表的 #guid 拿）。");
        const t = await getTaskDetail(args.task_guid);
        return textOk(JSON.stringify(t, null, 2));
      }
      case "tasklists": {
        const tls = await listTasklists();
        const body = tls.length ? tls.map((t, i) => `${i + 1}. ${t.name}  #${t.guid}`).join("\n") : "（空）";
        return textOk(`所有清单（${tls.length} 个）：\n${body}`);
      }
      case "tasklist_tasks": {
        if (!args.tasklist_guid) return textErr("列清单任务要传 tasklist_guid（从 tasklists 结果拿）。");
        const items = await listTasklistTasks(args.tasklist_guid);
        return textOk(`该清单下任务（${items.length} 条）：\n${fmtBriefList(items)}`);
      }
      case "sections": {
        if (!args.tasklist_guid) return textErr("列分组要传 tasklist_guid（从 tasklists 结果拿）。");
        const secs = await listSections(args.tasklist_guid);
        const body = secs.length ? secs.map((s, i) => `${i + 1}. ${s.name}  #${s.guid}`).join("\n") : "（空）";
        return textOk(`该清单的分组（${secs.length} 个）：\n${body}`);
      }
      case "section_tasks": {
        if (!args.section_guid) return textErr("列分组任务要传 section_guid（从 sections 结果拿）。");
        const items = await listSectionTasks(args.section_guid);
        return textOk(`该分组下任务（${items.length} 条）：\n${fmtBriefList(items)}`);
      }
      case "comments": {
        if (!args.task_guid) return textErr("列评论要传 task_guid。");
        const cs = await listTaskComments(args.task_guid);
        const body = cs.length ? cs.map((c, i) => `${i + 1}. ${c}`).join("\n") : "（无评论）";
        return textOk(`任务评论（${cs.length} 条）：\n${body}`);
      }
      default:
        return textErr(`未知 mode：${args.mode}`);
    }
  } catch (e) {
    return textErr(e instanceof Error ? e.message : String(e));
  }
}

// ───────────────────────────────────────────────────────────
// feishu_task_manage —— 改任务 / 改负责人 / 移分组 / 建删分组 / 评论
// ───────────────────────────────────────────────────────────

export const FEISHU_TASK_MANAGE_TOOL: Tool = {
  name: "feishu_task_manage",
  description: "管理飞书任务（改/移/分组/评论，直接动飞书侧，不走本地台账）。需先授权。",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["update", "set_assignee", "move", "create_section", "delete_section", "delete_tasklist", "comment"],
        description: "update=改标题/截止/备注(task_guid+任一summary/due_iso/description；due_iso空串=清截止) / set_assignee=改负责人(task_guid+add_names/remove_names) / move=真移动任务到目标清单(task_guid+tasklist_guid，可选section_guid；从原清单移除+加入目标，移动后原清单不再有它) / create_section=建分组(tasklist_name+section_name) / delete_section=删分组(section_guid，任务不删) / delete_tasklist=删清单(tasklist_guid，任务不删，慎用) / comment=加评论(task_guid+comment_text)",
      },
      task_guid: { type: "string", description: "update/set_assignee/move/comment 用" },
      summary: { type: "string", description: "update：新标题" },
      due_iso: { type: "string", description: "update：新截止 ISO8601；空串=清除截止" },
      description: { type: "string", description: "update：新备注" },
      add_names: { type: "array", items: { type: "string" }, description: "set_assignee：要加的负责人名字" },
      remove_names: { type: "array", items: { type: "string" }, description: "set_assignee：要去掉的负责人名字" },
      tasklist_guid: { type: "string", description: "move：目标清单 guid" },
      section_guid: { type: "string", description: "move：目标分组 guid（可选）/ delete_section：要删的分组" },
      tasklist_name: { type: "string", description: "create_section：分组所属清单名（同名复用）" },
      section_name: { type: "string", description: "create_section：新分组名（同名复用）" },
      comment_text: { type: "string", description: "comment：评论内容" },
    },
    required: ["action"],
  },
};

export async function handleFeishuTaskManage(args: {
  action: string;
  task_guid?: string;
  summary?: string;
  due_iso?: string;
  description?: string;
  add_names?: string[];
  remove_names?: string[];
  tasklist_guid?: string;
  section_guid?: string;
  tasklist_name?: string;
  section_name?: string;
  comment_text?: string;
}): Promise<ToolResult> {
  try {
    switch (args.action) {
      case "update": {
        if (!args.task_guid) return textErr("改任务要传 task_guid。");
        if (args.summary === undefined && args.due_iso === undefined && args.description === undefined) {
          return textErr("改任务至少传一个 summary / due_iso / description。");
        }
        await updateTask(args.task_guid, {
          ...(args.summary !== undefined ? { summary: args.summary } : {}),
          ...(args.due_iso !== undefined ? { dueIso: args.due_iso } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
        });
        return textOk("任务改好了。");
      }
      case "set_assignee": {
        if (!args.task_guid) return textErr("改负责人要传 task_guid。");
        const add = resolveNames(args.add_names);
        const rem = resolveNames(args.remove_names);
        const bad = [...add.bad, ...rem.bad];
        if (bad.length > 0) {
          const known = listKnownUsers().map((u) => u.name).join("、");
          return textErr(`这些人我还不认识飞书账号：${bad.join("、")}。我认识：${known || "（还没记住谁）"}。让 ta 群里说句话我就记住了。`);
        }
        if (add.ids.length === 0 && rem.ids.length === 0) return textErr("改负责人至少传一个 add_names 或 remove_names。");
        await setTaskMembers(args.task_guid, add.ids, rem.ids, "assignee");
        return textOk("负责人改好了。");
      }
      case "move": {
        if (!args.task_guid || !args.tasklist_guid) return textErr("移动任务要传 task_guid + tasklist_guid。");
        await moveTaskToTasklist(args.task_guid, args.tasklist_guid, args.section_guid);
        return textOk(`任务移到目标清单${args.section_guid ? "的指定分组" : ""}了（原清单已不再有它）。`);
      }
      case "create_section": {
        if (!args.tasklist_name || !args.section_name) return textErr("建分组要传 tasklist_name + section_name。");
        const tlGuid = await ensureTasklist(args.tasklist_name);
        const secGuid = await ensureSection(tlGuid, args.section_name);
        return textOk(`分组「${args.section_name}」建好了（在清单「${args.tasklist_name}」下）。#${secGuid}`);
      }
      case "delete_section": {
        if (!args.section_guid) return textErr("删分组要传 section_guid（从 sections 结果拿）。");
        await deleteSection(args.section_guid);
        return textOk("分组删了（里面的任务还在，只是不归这个分组了）。");
      }
      case "delete_tasklist": {
        if (!args.tasklist_guid) return textErr("删清单要传 tasklist_guid（从 tasklists 结果拿）。");
        await deleteTasklist(args.tasklist_guid);
        return textOk("清单删了（里面的任务还在，只是不归这个清单了）。");
      }
      case "comment": {
        if (!args.task_guid || !args.comment_text) return textErr("评论要传 task_guid + comment_text。");
        await addTaskComment(args.task_guid, args.comment_text);
        return textOk("评论加好了。");
      }
      default:
        return textErr(`未知 action：${args.action}`);
    }
  } catch (e) {
    return textErr(e instanceof Error ? e.message : String(e));
  }
}
