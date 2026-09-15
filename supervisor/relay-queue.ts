/**
 * 传话口队列——条子（本机 Claude 窗口 → 品品）与来信（品品 → 本机 Claude 窗口）的持久化状态。
 * supervisor 独占写；JSON tmp+rename 原子落盘；终态记录保留 7 天。纯状态 + 纯函数，网络与投递在 relay-bridge.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  RelayAckParams,
  RelayNoteStatus,
  RelayReceipt,
  RelaySubmitParams,
} from '../src/ipc/protocol.js';

/** 投递窗口（本机时区）：给Owner以外的人只在 [9,22) 点送 */
export const WINDOW_START_HOUR = 9;
export const WINDOW_END_HOUR = 22;
/** 投出后多久没 ack 重投 / 判 no_ack */
export const ACK_TIMEOUT_MS = 30 * 60_000;
/** 来信多久没人取判过期 */
export const LETTER_EXPIRE_MS = 2 * 3600_000;
/** 投递连续失败多少轮（每轮约 1 分钟）判 failed */
export const MAX_PUSH_FAILS = 30;
const RETAIN_MS = 7 * 24 * 3600_000;

export interface NoteRoute {
  /** 投给哪个频道 */
  chat_id: string;
  /** 投给Owner本人私聊 → 不受时段限制 */
  anytime: boolean;
  /** 解析出的对象（给正文用） */
  person_ids?: string[];
  at?: Array<{ name: string; ids: string[] }>;
  chat_name?: string;
  /** reply_to 条子：投 desktop-reply 而非 desktop-note */
  is_reply?: boolean;
}

export interface NoteRecord extends RelaySubmitParams {
  route: NoteRoute;
  status: RelayNoteStatus;
  submitted_at: number;
  updated_at: number;
  deliver_after?: number;
  delivered_at?: number;
  /** 已投出次数（含重投） */
  attempts: number;
  push_fails: number;
  sent_text?: string;
  reason?: string;
  reply?: string;
}

export type LetterStatus = 'pending' | 'taken' | 'replied' | 'expired';

export interface LetterRecord {
  id: string;
  created_at: number;
  updated_at: number;
  from_chat_id: string;
  requester: string;
  target: string;
  content: string;
  need_reply: boolean;
  status: LetterStatus;
  taken_by?: string;
}

/** 传话员在线痕迹（过期自诊断用） */
export interface RelaySeen {
  last_hello_at?: number;
  last_hello_title?: string;
  last_close_at?: number;
}

interface QueueFile {
  notes: Record<string, NoteRecord>;
  letters: Record<string, LetterRecord>;
  seen: RelaySeen;
}

const NOTE_FINAL: ReadonlySet<RelayNoteStatus> = new Set(['sent', 'deferred', 'skipped', 'failed', 'no_ack']);

export function isNoteFinal(s: RelayNoteStatus): boolean {
  return NOTE_FINAL.has(s);
}

export function inWindow(now: Date): boolean {
  const h = now.getHours();
  return h >= WINDOW_START_HOUR && h < WINDOW_END_HOUR;
}

/** now 不在窗口内时，下一个窗口开始时刻（本机时区） */
export function nextWindowStart(now: Date): Date {
  const d = new Date(now);
  if (d.getHours() >= WINDOW_END_HOUR) d.setDate(d.getDate() + 1);
  d.setHours(WINDOW_START_HOUR, 0, 0, 0);
  return d;
}

export function receiptOf(n: NoteRecord): RelayReceipt {
  return {
    id: n.id,
    status: n.status,
    ...(n.sent_text ? { sent_text: n.sent_text } : {}),
    ...(n.reason ? { reason: n.reason } : {}),
    ...(n.reply ? { reply: n.reply } : {}),
    ...(n.deliver_after ? { deliver_after: new Date(n.deliver_after).toISOString() } : {}),
    updated_at: new Date(n.updated_at).toISOString(),
  };
}

export class RelayQueue {
  private data: QueueFile = { notes: {}, letters: {}, seen: {} };

  constructor(private filePath: string) {}

  load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<QueueFile>;
      this.data = { notes: raw.notes ?? {}, letters: raw.letters ?? {}, seen: raw.seen ?? {} };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`[relay-queue] 读 ${this.filePath} 失败，从空队列起: ${e instanceof Error ? e.message : e}\n`);
      }
    }
    this.prune(Date.now());
  }

  save(): void {
    const tmp = `${this.filePath}.tmp`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  /** 删 7 天前的终态记录；返回是否有删除 */
  prune(now: number): boolean {
    let changed = false;
    for (const [id, n] of Object.entries(this.data.notes)) {
      if (isNoteFinal(n.status) && now - n.updated_at > RETAIN_MS) { delete this.data.notes[id]; changed = true; }
    }
    for (const [id, l] of Object.entries(this.data.letters)) {
      if (l.status !== 'pending' && now - l.updated_at > RETAIN_MS) { delete this.data.letters[id]; changed = true; }
    }
    return changed;
  }

  get seen(): RelaySeen {
    return this.data.seen;
  }

  getNote(id: string): NoteRecord | undefined {
    return this.data.notes[id];
  }

  getLetter(id: string): LetterRecord | undefined {
    return this.data.letters[id];
  }

  notes(): NoteRecord[] {
    return Object.values(this.data.notes);
  }

  letters(): LetterRecord[] {
    return Object.values(this.data.letters);
  }

  /** 新条子入队（调用方已查重 + 解析路由）。窗口外 → scheduled。 */
  addNote(p: RelaySubmitParams, route: NoteRoute, now: Date): NoteRecord {
    const scheduled = !route.anytime && !inWindow(now);
    const rec: NoteRecord = {
      ...p,
      route,
      status: scheduled ? 'scheduled' : 'queued',
      submitted_at: now.getTime(),
      updated_at: now.getTime(),
      ...(scheduled ? { deliver_after: nextWindowStart(now).getTime() } : {}),
      attempts: 0,
      push_fails: 0,
    };
    this.data.notes[p.id] = rec;
    return rec;
  }

  /** 品品 ack。首次 ack 定终态；已终态再 ack 只补 reply / sent_text（对方回话）。 */
  ack(p: RelayAckParams, now: number): NoteRecord | undefined {
    const n = this.data.notes[p.note_id];
    if (!n) return undefined;
    if (!isNoteFinal(n.status) || n.status === 'no_ack') n.status = p.status;
    if (p.sent_text) n.sent_text = p.sent_text;
    if (p.reason) n.reason = p.reason;
    if (p.reply) n.reply = p.reply;
    n.updated_at = now;
    return n;
  }

  addLetter(l: Omit<LetterRecord, 'status' | 'updated_at'>): LetterRecord {
    const rec: LetterRecord = { ...l, status: 'pending', updated_at: l.created_at };
    this.data.letters[l.id] = rec;
    return rec;
  }
}
