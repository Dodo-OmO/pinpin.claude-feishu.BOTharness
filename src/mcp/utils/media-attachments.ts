// 任务D：入站图片/文件处理（下载 → 图片压缩省 token / 文件存盘不读）
// 参考 早期版本 src/feishu/handlers/message.ts 的压缩策略（静态≤384px、GIF≤256px、Q80），
// 按 CLI 架构适配：下载走 MCP 版 feishu-send.downloadMessageResource，存盘到 vault。

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { dateYYYYMM, timeHHMM, getVaultRoot, ensureDir, safeName } from "./helper.js";
import { downloadMessageResource } from "../tools/feishu-send.js";

const VAULT_ROOT = getVaultRoot();
const IMG_DIR = path.join(VAULT_ROOT, "对话附件", "图片");
const FILE_DIR = path.join(VAULT_ROOT, "他人附件");

const STATIC_MAX_EDGE = 384;
const GIF_MAX_EDGE = 256;
const JPEG_QUALITY = 80;

// 超此尺寸不压缩（直接存原图）——避免超大图 sharp 解压吃爆内存（libjpeg 峰值约原图×几倍）
const COMPRESS_SIZE_LIMIT = 30 * 1024 * 1024;

/**
 * 入站图片：下载 → sharp 压缩（静态≤384px Q80 jpeg / GIF≤256px）→ 存 vault\对话附件\图片\YYYY-MM\。
 * 返回压缩后本地路径（供注入 channel 让品品 Read）。压缩失败则退回存原图。
 */
export async function saveInboundImage(messageId: string, imageKey: string): Promise<string> {
  const dir = path.join(IMG_DIR, dateYYYYMM());
  ensureDir(dir);
  const stem = `${timeHHMM().replace(":", "")}_${imageKey.slice(-8)}`;
  const tmpPath = path.join(dir, `${stem}.orig`);
  await downloadMessageResource(messageId, imageKey, "image", tmpPath);
  // 超大图不进 sharp（防 OOM）→ 直接存原图
  try {
    if (fs.statSync(tmpPath).size > COMPRESS_SIZE_LIMIT) {
      const fallback = path.join(dir, `${stem}.img`);
      fs.renameSync(tmpPath, fallback);
      process.stderr.write(`[media] 图片超 ${COMPRESS_SIZE_LIMIT / 1024 / 1024}MB，存原图不压缩\n`);
      return fallback;
    }
  } catch {
    /* statSync 失败则继续走压缩路径 */
  }
  try {
    const meta = await sharp(tmpPath).metadata();
    const isGif = meta.format === "gif";
    const maxEdge = isGif ? GIF_MAX_EDGE : STATIC_MAX_EDGE;
    const ext = isGif ? "gif" : "jpg";
    const finalPath = path.join(dir, `${stem}.${ext}`);
    const pipeline = sharp(tmpPath, { animated: isGif }).resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    });
    const buf = isGif
      ? await pipeline.gif().toBuffer()
      : await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer();
    fs.writeFileSync(finalPath, buf);
    fs.rmSync(tmpPath, { force: true });
    return finalPath;
  } catch (e) {
    // 压缩失败（非常规格式等）→ 保留原图不丢，改名去掉 .orig 后缀
    process.stderr.write(
      `[media] 图片压缩失败，存原图: ${e instanceof Error ? e.message : e}\n`,
    );
    const fallback = path.join(dir, `${stem}.img`);
    try {
      fs.renameSync(tmpPath, fallback);
    } catch {
      return tmpPath;
    }
    return fallback;
  }
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
