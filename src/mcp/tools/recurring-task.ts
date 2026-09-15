// recurring_task tool（MCP 版，2026-09-15 固定任务引擎）
// 品品在自己所在频道用它登记/查看/停用/删除固定任务——落盘 recurring-tasks.json，
// 由启动器级 RecurringTaskRunner（supervisor/recurring-tasks.ts）统一调度到点推送，
// 加新固定任务不用再改代码。

import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  recurringTasksPath,
  readRecurringTasks,
  writeRecurringTasksAtomic,
  validateRule,
  type RecurringTask,
} from "../../shared/recurring-tasks-store.js";
import { getVaultRoot, safeName } from "../utils/helper.js";
import { logBackground } from "../utils/background-log.js";

// 同 src/mcp/db/database.ts 的 DB_PATH 兜底逻辑（本工具不便直接 import database.ts 的私有常量，
// 独立算一份——PINPIN_DB_PATH 由 supervisor 透传，两边算出来的路径必然一致）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.PINPIN_DB_PATH
  ? process.env.PINPIN_DB_PATH
  : path.join(__dirname, "..", "..", "..", "data.db");
const TASKS_PATH = recurringTasksPath(DB_PATH);

export const recurringTaskTool: Tool = {
  name: "recurring_task",
  description:
    "登记/查看/停用/删除本频道的固定任务（到点自动推 SOP 让你照做，不用豆姐口头催、也不用改代码）。" +
    "action=upsert：无 id=新建，传已登记的 id=改；list：列本频道已登记的全部；disable/enable：停用/恢复（保留记录）；remove：彻底删除。" +
    "新建必须给 name / rule / sop_path。rule = {kind:'daily'|'weekly'|'monthly', at:'HH:MM', days?:0-6 数组(weekly 必填,0=周日), day?:1-31(monthly 必填)}。" +
    "sop_path 是 vault 内相对路径（如「Client/固定任务/开工简报.md」）或绝对路径，必须是已存在的文件——SOP 没写好先别登记。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["upsert", "list", "disable", "enable", "remove"] },
      id: { type: "string", description: "改/停/删时指定；upsert 新建时不传" },
      name: { type: "string" },
      rule: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["daily", "weekly", "monthly"] },
          at: { type: "string", description: "HH:MM，24 小时制" },
          days: { type: "array", items: { type: "number" }, description: "weekly 必填，0-6，0=周日" },
          day: { type: "number", description: "monthly 必填，1-31" },
        },
      },
      sop_path: { type: "string" },
      catch_up_hours: { type: "number", description: "离线补跑窗口（小时），缺省 3" },
    },
    required: ["action"],
  },
};

interface RecurringTaskArgs {
  action: "upsert" | "list" | "disable" | "enable" | "remove";
  id?: string;
  name?: string;
  rule?: unknown;
  sop_path?: string;
  catch_up_hours?: number;
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

function textResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] };
}

// 复用 helper.ts 的 safeName（文件名安全化）做字符清洗，空格额外折成 "-" 保持 id 短横线风格。
function safeIdFromName(name: string): string {
  const base = safeName(name.trim().replace(/\s+/g, "-")).slice(0, 24);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base}-${suffix}`;
}

export async function handleRecurringTask(args: RecurringTaskArgs) {
  const chatId = process.env.PINPIN_CHAT_ID;
  if (!chatId) return errorResult("本频道 PINPIN_CHAT_ID 未注入，无法登记（联系Owner检查启动器）");

  const all = readRecurringTasks(TASKS_PATH);

  switch (args.action) {
    case "list": {
      const mine = all.filter((t) => t.chat_id === chatId);
      return textResult({ count: mine.length, tasks: mine });
    }

    case "disable":
    case "enable":
    case "remove": {
      if (!args.id) return errorResult(`${args.action} 必须传 id（先 list 查看本频道任务清单）`);
      const idx = all.findIndex((t) => t.id === args.id && t.chat_id === chatId);
      if (idx === -1) return errorResult(`没找到本频道 id=${args.id} 的固定任务`);
      if (args.action !== "remove") {
        all[idx] = { ...all[idx], enabled: args.action === "enable" };
      } else {
        all.splice(idx, 1);
      }
      try {
        writeRecurringTasksAtomic(TASKS_PATH, all);
      } catch (e) {
        return errorResult(`落盘失败：${e instanceof Error ? e.message : e}`);
      }
      logBackground("recurring-task", `${args.action} chat=${chatId.slice(-6)} id=${args.id}`);
      return textResult({ ok: true, action: args.action, id: args.id });
    }

    case "upsert": {
      const existingIdx = args.id ? all.findIndex((t) => t.id === args.id && t.chat_id === chatId) : -1;
      if (args.id && existingIdx === -1) {
        return errorResult(`没找到本频道 id=${args.id} 的固定任务（改内容前先 list 确认 id）`);
      }
      const existing = existingIdx >= 0 ? all[existingIdx] : undefined;

      const name = args.name ?? existing?.name;
      if (!name) return errorResult("新建固定任务必须给 name");

      const rule = args.rule ?? existing?.rule;
      const ruleCheck = validateRule(rule);
      if (!ruleCheck.ok) return errorResult(`rule 不合法：${ruleCheck.error}`);

      const sopPathRaw = args.sop_path ?? existing?.sop_path;
      if (!sopPathRaw) return errorResult("新建固定任务必须给 sop_path");
      const sopAbs = path.isAbsolute(sopPathRaw) ? sopPathRaw : path.join(getVaultRoot(), sopPathRaw);
      if (!existsSync(sopAbs)) {
        return errorResult(`sop_path 指向的文件不存在：${sopPathRaw}（先把 SOP 写好再登记）`);
      }

      const task: RecurringTask = {
        id: existing?.id ?? safeIdFromName(name),
        name,
        chat_id: chatId,
        rule: ruleCheck.rule,
        sop_path: sopPathRaw,
        enabled: existing?.enabled ?? true,
        last_fired_at: existing?.last_fired_at,
        catch_up_hours: args.catch_up_hours ?? existing?.catch_up_hours ?? 3,
      };

      const next = existingIdx >= 0 ? all.map((t, i) => (i === existingIdx ? task : t)) : [...all, task];
      try {
        writeRecurringTasksAtomic(TASKS_PATH, next);
      } catch (e) {
        return errorResult(`落盘失败：${e instanceof Error ? e.message : e}`);
      }
      logBackground("recurring-task", `upsert chat=${chatId.slice(-6)} id=${task.id} name=${task.name}`);
      return textResult({ ok: true, task });
    }

    default:
      return errorResult(`未知 action: ${(args as { action: string }).action}`);
  }
}
