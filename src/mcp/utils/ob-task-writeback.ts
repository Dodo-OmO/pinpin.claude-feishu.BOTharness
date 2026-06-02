/**
 * 本地台账「完成回写」——把Owner日程台账里某条任务**就地**标完成（不挪区）。
 *
 * 从 早期版本 src/utils/ob-task-writeback.ts 整文件搬迁（无 SDK 依赖，纯本地 fs + dateYYYYMMDD）。
 * 飞书自带任务勾完成 → 回写本地台账复用本函数。是确定性代码（不走 LLM——省 token，
 * 同协议 #36/#50 先例）。
 *
 * 方案 B 4 级镜像：本地台账全镜像飞书 4 级，GTD 状态用 `[ ]/[x]` 表达，**取消 `### 已完成` 分区**——
 * 故完成动作改为**就地** `[ ]`→`[x]` + 删"状态/截止"字段 + 加完成日期，**不再挪区**。
 * 父任务标完成时，其下方连续缩进子步骤行**一并** `[ ]`→`[x]`（父完成=步骤都完成的心智模型）。
 * 无子步骤的普通任务=仅父行就地勾。
 *
 * 多重 guard：文件不存在 / 锚找不到 → 不损坏文件（跳过并 warn），绝不写坏Owner台账。
 */

import fs from "node:fs";
import { dateYYYYMMDD } from "./helper.js";

/**
 * 把本地台账里带 `<!--ft:marker-->` 隐藏锚的那条任务**就地**标完成（方案 B：不挪区）。
 * 父行 `[ ]`→`[x]`+完成日期，其下连续缩进子步骤行一并 `[ ]`→`[x]`。
 */
export function applyTaskDoneToOB(obFile: string, marker: string): void {
  if (!fs.existsSync(obFile)) {
    console.warn(`[ob-task-writeback] 台账文件不存在，跳过回写: ${obFile}`);
    return;
  }
  const markerToken = `<!--ft:${marker}-->`;
  const content = fs.readFileSync(obFile, "utf-8");
  const lines = content.split(/\r?\n/);

  const idx = lines.findIndex((l) => l.includes(markerToken));
  if (idx < 0) {
    console.warn(
      `[ob-task-writeback] 台账里找不到锚 ${markerToken}，跳过回写（不损坏文件）`,
    );
    return;
  }
  const original = lines[idx];
  if (original.includes("- [x]")) return; // 已是完成态，幂等

  const doneDate = dateYYYYMMDD();
  let nl = original.replace("- [ ]", "- [x]");
  nl = nl
    .replace(/｜\s*状态[:：][^｜]*/g, "")
    .replace(/｜\s*截止[:：][^｜]*/g, "");
  if (/｜\s*\[创建[:：]/.test(nl)) {
    nl = nl.replace(/(｜\s*\[创建[:：])/, `｜完成:${doneDate}$1`);
  } else if (nl.includes(markerToken)) {
    nl = nl.replace(markerToken, `｜完成:${doneDate} ${markerToken}`);
  } else {
    nl = `${nl}｜完成:${doneDate}`;
  }
  lines[idx] = nl;

  // 父任务下方连续缩进行 = 它的子步骤，父完成时一并就地勾
  for (let i = idx + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) {
    if (lines[i].includes("- [ ]")) {
      lines[i] = lines[i].replace("- [ ]", "- [x]");
    }
  }

  fs.writeFileSync(obFile, lines.join("\n"), "utf-8");
}

/**
 * 把一条新任务（父行 + 可选缩进子步骤行）写进本地台账。方案 B 4 级镜像。
 */
export function writeLedger(
  obFile: string,
  project: string,
  sectionName: string | undefined,
  parentLine: string,
  subtaskLines: string[],
): void {
  if (!fs.existsSync(obFile)) {
    throw new Error(`本地台账文件不存在，没法双写：${obFile}`);
  }
  const proj = project.trim();
  const section = sectionName?.trim() || "";
  const content = fs.readFileSync(obFile, "utf-8");
  const lines = content.split(/\r?\n/);
  const block = [parentLine, ...subtaskLines];

  const ps = lines.findIndex(
    (l) =>
      /^##\s/.test(l) && l.replace(/^##\s*/, "").trim().includes(proj),
  );
  if (ps < 0) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }
    lines.push(`## ${proj}`, "");
    if (section) lines.push(`### ${section}`);
    lines.push(...block);
    fs.writeFileSync(obFile, lines.join("\n"), "utf-8");
    return;
  }
  let projEnd = lines.length;
  for (let i = ps + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      projEnd = i;
      break;
    }
  }

  if (section) {
    let secHeading = -1;
    for (let i = ps + 1; i < projEnd; i++) {
      if (
        /^###\s/.test(lines[i]) &&
        lines[i].replace(/^###\s*/, "").trim() === section
      ) {
        secHeading = i;
        break;
      }
    }
    if (secHeading >= 0) {
      let subEnd = projEnd;
      for (let i = secHeading + 1; i < projEnd; i++) {
        if (/^###?\s/.test(lines[i])) {
          subEnd = i;
          break;
        }
      }
      let lastContent = secHeading;
      for (let i = secHeading + 1; i < subEnd; i++) {
        if (lines[i].trim() !== "") lastContent = i;
      }
      lines.splice(lastContent + 1, 0, ...block);
    } else {
      const ins: string[] = [];
      if (projEnd > ps + 1 && lines[projEnd - 1].trim() !== "") ins.push("");
      ins.push(`### ${section}`, ...block);
      lines.splice(projEnd, 0, ...ins);
    }
  } else {
    let zoneStart = ps + 1;
    while (
      zoneStart < projEnd &&
      (lines[zoneStart].trim() === "" ||
        lines[zoneStart].trim().startsWith(">"))
    ) {
      zoneStart++;
    }
    let zoneEnd = projEnd;
    for (let i = zoneStart; i < projEnd; i++) {
      if (/^###\s/.test(lines[i])) {
        zoneEnd = i;
        break;
      }
    }
    let lastContent = zoneStart - 1;
    for (let i = zoneStart; i < zoneEnd; i++) {
      if (lines[i].trim() !== "") lastContent = i;
    }
    lines.splice(lastContent + 1, 0, ...block);
  }

  fs.writeFileSync(obFile, lines.join("\n"), "utf-8");
}

const SUBTASK_LINE = /^\s+- \[( |x)\]\s*(.*?)\s*<!--fts:([0-9a-fA-F-]+)-->/;

/** 扫台账里**未完成**(`- [ ]`)的缩进子步骤行，desc 含 keyword 的（feishu_task_done 用） */
export function findOpenLedgerSubtasks(
  obFile: string,
  keyword: string,
): { subGuid: string; desc: string }[] {
  if (!fs.existsSync(obFile)) return [];
  const lines = fs.readFileSync(obFile, "utf-8").split(/\r?\n/);
  const k = keyword.trim().toLowerCase();
  const out: { subGuid: string; desc: string }[] = [];
  for (const l of lines) {
    const m = l.match(SUBTASK_LINE);
    if (!m || m[1] !== " ") continue;
    const desc = m[2].trim();
    if (desc.toLowerCase().includes(k)) out.push({ subGuid: m[3], desc });
  }
  return out;
}

/**
 * 把某条子步骤行 `- [ ]`→`- [x]`，并判其父任务下所有子步骤是否都已完成。
 * 返回 { parentMarker, allDone }；子步骤锚找不到返 null（不损坏文件）。
 */
export function markLedgerSubtaskDone(
  obFile: string,
  subGuid: string,
): { parentMarker: string | null; allDone: boolean } | null {
  if (!fs.existsSync(obFile)) return null;
  const lines = fs.readFileSync(obFile, "utf-8").split(/\r?\n/);
  const subToken = `<!--fts:${subGuid}-->`;
  const idx = lines.findIndex((l) => l.includes(subToken));
  if (idx < 0) return null;
  if (lines[idx].includes("- [ ]")) {
    lines[idx] = lines[idx].replace("- [ ]", "- [x]");
  }
  let parentMarker: string | null = null;
  let parentIdx = -1;
  for (let i = idx - 1; i >= 0; i--) {
    if (/^\s+\S/.test(lines[i])) continue;
    const pm = lines[i].match(/<!--ft:([0-9a-fA-F-]+)-->/);
    if (pm) {
      parentMarker = pm[1];
      parentIdx = i;
    }
    break;
  }
  let allDone = false;
  if (parentIdx >= 0) {
    allDone = true;
    for (let i = parentIdx + 1; i < lines.length; i++) {
      if (!/^\s+\S/.test(lines[i])) break;
      if (/^\s+- \[ \]/.test(lines[i])) {
        allDone = false;
        break;
      }
    }
  }
  fs.writeFileSync(obFile, lines.join("\n"), "utf-8");
  return { parentMarker, allDone };
}

/** 读出某父任务（`<!--ft:marker-->`）下所有子步骤的 fts guid */
export function collectLedgerSubtaskGuids(
  obFile: string,
  marker: string,
): string[] {
  if (!fs.existsSync(obFile)) return [];
  const lines = fs.readFileSync(obFile, "utf-8").split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes(`<!--ft:${marker}-->`));
  if (idx < 0) return [];
  const guids: string[] = [];
  for (let i = idx + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) {
    const sm = lines[i].match(/<!--fts:([0-9a-fA-F-]+)-->/);
    if (sm) guids.push(sm[1]);
  }
  return guids;
}

/** 从台账整块删除某父任务行 + 其连续缩进子步骤行（两边删不留痕）。 */
export function removeLedgerTask(obFile: string, marker: string): boolean {
  if (!fs.existsSync(obFile)) return false;
  const lines = fs.readFileSync(obFile, "utf-8").split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes(`<!--ft:${marker}-->`));
  if (idx < 0) return false;
  let end = idx + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
  lines.splice(idx, end - idx);
  fs.writeFileSync(obFile, lines.join("\n"), "utf-8");
  return true;
}

/** 动态追加子步骤：插到某父任务已有子步骤块末尾，父锚找不到返 false（不损坏文件）。 */
export function appendLedgerSubtasks(
  obFile: string,
  marker: string,
  subtaskLines: string[],
): boolean {
  if (subtaskLines.length === 0) return true;
  if (!fs.existsSync(obFile)) return false;
  const lines = fs.readFileSync(obFile, "utf-8").split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes(`<!--ft:${marker}-->`));
  if (idx < 0) return false;
  let end = idx + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
  lines.splice(end, 0, ...subtaskLines);
  fs.writeFileSync(obFile, lines.join("\n"), "utf-8");
  return true;
}
