// 任务D：入站图片/文件处理（下载 → 存原图 / 文件存盘不读）
// 下载走 MCP 版 feishu-send.downloadMessageResource，存盘到 vault。

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { dateYYYYMM, timeHHMM, getVaultRoot, ensureDir, safeName } from "./helper.js";
import { downloadMessageResource } from "../tools/feishu-send.js";

const VAULT_ROOT = getVaultRoot();
const IMG_DIR = path.join(VAULT_ROOT, "对话附件", "图片");
const FILE_DIR = path.join(VAULT_ROOT, "他人附件");

/**
 * 入站图片：下载 → 存原图不压缩不重编码 → 存 vault\对话附件\图片\YYYY-MM\。
 * 用 sharp 探测格式只为定扩展名（jpeg→jpg，其它按格式名），探测失败回落 `.img`。
 * 返回本地路径（供注入 channel 让品品 Read 原图）。
 */
export async function saveInboundImage(messageId: string, imageKey: string): Promise<string> {
  const dir = path.join(IMG_DIR, dateYYYYMM());
  ensureDir(dir);
  const stem = `${timeHHMM().replace(":", "")}_${imageKey.slice(-8)}`;
  const tmpPath = path.join(dir, `${stem}.orig`);
  await downloadMessageResource(messageId, imageKey, "image", tmpPath);
  let ext = "img";
  try {
    const meta = await sharp(tmpPath).metadata();
    if (meta.format) ext = meta.format === "jpeg" ? "jpg" : meta.format;
  } catch (e) {
    process.stderr.write(
      `[media] 图片格式探测失败，存为 .img: ${e instanceof Error ? e.message : e}\n`,
    );
  }
  const finalPath = path.join(dir, `${stem}.${ext}`);
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

/**
 * 入站文件：下载存 vault\他人附件\YYYY-MM\，不读取内容（默认备份未读）。
 * 返回本地路径。
 */
export async function saveInboundFile(
  messageId: string,
  fileKey: string,
  fileName: string,
): Promise<string> {
  const dir = path.join(FILE_DIR, dateYYYYMM());
  ensureDir(dir);
  const finalPath = path.join(dir, `${timeHHMM().replace(":", "")}_${safeName(fileName)}`);
  await downloadMessageResource(messageId, fileKey, "file", finalPath);
  return finalPath;
}
