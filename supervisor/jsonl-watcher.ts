/**
 * JsonlWatcher —— 监听 claude code 自己写的 session jsonl 文件，增量读 + JSON.parse 每行。
 *
 * 背景：work session 之前用 `--output-format stream-json` 让 PTY stdout 输出 JSON 行，
 * 但 stream-json 在交互式 PTY 模式下不输出（实测Owner终端空白），是 -p print 模式专用。
 * 改用 claude code 自动写到 `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` 的文件，
 * fs.watch + 增量读 → 解析事件 → 翻译给终端窗。
 *
 * 实装要点：
 *   - fs.watch 触发频繁（每次 append 都触发），用 fileOffset 维护已读位置
 *   - 每次触发只读 offset 之后的新增字节
 *   - 行边界跨 chunk 用 bufferRemainder 累积（同 StreamJsonParser 思路）
 *   - 非 JSON 行 silent skip（jsonl 全是 JSON，但防御性写）
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';

export interface JsonlEvent {
  type: string;
  [key: string]: unknown;
}

export class JsonlWatcher extends EventEmitter {
  private filePath: string;
  private fileOffset = 0;
  private lineRemainder = '';
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  start(): void {
    if (this.closed) return;
    // 初始把已有内容读完一次（jsonl 已存在的事件回放给 consumer）
    this.readNewBytes();
    // fs.watch 监听文件变化
    try {
      this.watcher = fs.watch(this.filePath, { persistent: false }, () => {
        if (this.closed) return;
        this.readNewBytes();
      });
    } catch (e) {
      process.stderr.write(
        `[jsonl-watcher] fs.watch 失败 ${this.filePath}: ${e instanceof Error ? e.message : e}\n`,
      );
    }
    // 兜底轮询（fs.watch 在某些 Windows 文件系统/网络盘场景下不稳定）
    this.pollTimer = setInterval(() => {
      if (this.closed) return;
      this.readNewBytes();
    }, 2000);
  }

  stop(): void {
    this.closed = true;
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private readNewBytes(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      return;
    }
    if (stat.size <= this.fileOffset) return;
    let chunk: Buffer;
    try {
      const fd = fs.openSync(this.filePath, 'r');
      const buf = Buffer.alloc(stat.size - this.fileOffset);
      fs.readSync(fd, buf, 0, buf.length, this.fileOffset);
      fs.closeSync(fd);
      chunk = buf;
    } catch (e) {
      process.stderr.write(
        `[jsonl-watcher] read 失败 ${this.filePath}: ${e instanceof Error ? e.message : e}\n`,
      );
      return;
    }
    this.fileOffset = stat.size;
    this.lineRemainder += chunk.toString('utf8');
    const lines = this.lineRemainder.split('\n');
    this.lineRemainder = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith('{')) continue;
      try {
        const ev = JSON.parse(trimmed) as JsonlEvent;
        this.emit('event', ev);
      } catch (e) {
        process.stderr.write(
          `[jsonl-watcher] JSON.parse 失败 (skip line): ${e instanceof Error ? e.message : e}\n`,
        );
      }
    }
  }
}
