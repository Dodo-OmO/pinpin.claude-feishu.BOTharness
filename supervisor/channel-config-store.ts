/**
 * 频道级 + 全局默认配置持久化（model + effort）。
 *
 * Schema：
 *   {
 *     "__defaults__": { model?, effort? },    // P2.2 全局默认（spawn 新群时 fallback）
 *     "oc_xxx": { model?, effort? },          // per-chat 配置（P1.2）
 *     ...
 *   }
 *
 * 路径：`{dataDir}/channel-config.json`（dataDir = Electron app.getPath('userData')）。
 * 不用 sqlite（supervisor 进程不开 DB，避 NODE_MODULE_VERSION mismatch；详 supervisor/index.ts §1）。
 *
 * 安全特性（消化 devil-advocate v1 审视）：
 *   - 原子写 (write tmp + rename)，防半写崩溃
 *   - parse 失败 fallback 空对象 + 备份 corrupt 文件 + warn log
 *   - 单写者（supervisor 进程内串行写），不上 proper-lockfile
 */

const DEFAULTS_KEY = '__defaults__';
const WORK_DEFAULTS_KEY = '__work_defaults__';

/** 自动压缩阈值默认值（上下文用量百分比）。per-channel 未配 + 全局默认未设时的兜底，与历史硬编码一致。 */
export const DEFAULT_AUTOCOMPACT_PCT = 25;

import fs from 'node:fs';
import path from 'node:path';

export interface ChannelConfig {
  model?: string;
  effort?: string;
  /** P4.Q3 续: 用户自定义卡片显示名（飞书 P2P 无 chat.name + 群聊用户想改名时用）
   *  渲染 fallback 链：display_name > 飞书 chat_name > chat_id.slice(-12) */
  display_name?: string;
  /** 频道常驻持久化标记（2026-05-28）：spawn 过即写 true，下次启动遍历持久化列表自动 spawn，
   *  P2P 单聊不在飞书 chat.list 也能恢复 */
  seen?: boolean;
  /** 待机模式标记（2026-06-19）：true 时 spawnAllKnownChannels / 每日 4 点重启都不自动拉起该频道，
   *  但有人发消息会经 onFeishuMessage 的"!channels.has → 动态 spawn"热路径唤醒（触发消息走缓冲 flush 给品品读）。
   *  唤醒只临时 spawn、本标记不清，下次 4 点重启又回待机。 */
  standby?: boolean;
  /** 自动压缩阈值（上下文用量百分比，20-70）。缺省走 DEFAULT_AUTOCOMPACT_PCT。改完需重启该频道 CLI 生效。 */
  autoCompactPct?: number;
  /** 语音骰子开关（缺省=开）。false 时 spawn 注入 PINPIN_VOICE_DICE=off，该频道不掷语音骰。重启生效。 */
  voiceDice?: boolean;
  /** 外挂知识目录（绝对路径数组）。spawn 时逐个 --add-dir（其 .claude/skills 原生加载、文件访问放行），
   *  非空时注入 CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 让各目录 CLAUDE.md 原生加载。重启生效。 */
  addDirs?: string[];
  /** fast 模式（Opus 加速输出）。spawn 时注入 --settings 的 fastMode；改完需重启该频道 CLI 生效。
   *  per-channel / __defaults__ / __work_defaults__ 三处通用。 */
  fast?: boolean;
}

export type ChannelConfigMap = Record<string, ChannelConfig>;

export class ChannelConfigStore {
  private filePath: string;
  private cache: ChannelConfigMap = {};

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'channel-config.json');
  }

  /** 启动时调一次：load 进 cache。文件不存在 → 空 cache；parse 失败 → 备份 corrupt + 空 cache + log warn */
  load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.cache = {};
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      // 基本校验：必须是对象
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.cache = parsed as ChannelConfigMap;
      } else {
        throw new Error('channel-config.json root 不是对象');
      }
    } catch (e) {
      const corruptBackup = `${this.filePath}.corrupt.${Date.now()}`;
      try {
        fs.copyFileSync(this.filePath, corruptBackup);
        process.stderr.write(
          `[channel-config-store] 损坏的 channel-config.json 已 fallback 空对象，原文件备份至 ${corruptBackup}: ${e instanceof Error ? e.message : e}\n`,
        );
      } catch {
        process.stderr.write(
          `[channel-config-store] 损坏的 channel-config.json 已 fallback 空对象，备份失败: ${e instanceof Error ? e.message : e}\n`,
        );
      }
      this.cache = {};
    }
  }

  get(chatId: string): ChannelConfig | undefined {
    if (chatId === DEFAULTS_KEY || chatId === WORK_DEFAULTS_KEY) return undefined; // 保留 key，不让外部当 chat_id 用
    return this.cache[chatId];
  }

  /** 写一条 channel config + 原子持久化（write tmp + rename） */
  set(chatId: string, patch: ChannelConfig): void {
    if (chatId === DEFAULTS_KEY || chatId === WORK_DEFAULTS_KEY) return; // 同上保护
    const existing = this.cache[chatId] ?? {};
    this.cache[chatId] = { ...existing, ...patch };
    this.flush();
  }

  /** P2.2: 取全局默认 (model/effort)。spawn 新群时无 per-chat 配置 → fallback 这里 */
  getDefaults(): ChannelConfig | undefined {
    return this.cache[DEFAULTS_KEY];
  }

  /** P2.2: 写全局默认 + 原子持久化 */
  setDefaults(patch: ChannelConfig): void {
    const existing = this.cache[DEFAULTS_KEY] ?? {};
    this.cache[DEFAULTS_KEY] = { ...existing, ...patch };
    this.flush();
  }

  /** work session 全局默认 (model/effort)。spawn work session 时无显式参数 → fallback 这里 */
  getWorkDefaults(): ChannelConfig | undefined {
    return this.cache[WORK_DEFAULTS_KEY];
  }

  /** 写 work session 全局默认 + 原子持久化 */
  setWorkDefaults(patch: ChannelConfig): void {
    const existing = this.cache[WORK_DEFAULTS_KEY] ?? {};
    this.cache[WORK_DEFAULTS_KEY] = { ...existing, ...patch };
    this.flush();
  }

  /** 列出所有已识别频道 chat_id（过滤两个特殊 key） */
  listChatIds(): string[] {
    return Object.keys(this.cache).filter(
      (k) => k !== DEFAULTS_KEY && k !== WORK_DEFAULTS_KEY,
    );
  }

  /** 标 seen=true。spawnChannelCli 首次 spawn 时调，让该 chat 进入"常驻"持久列表 */
  markSeen(chatId: string): void {
    if (chatId === DEFAULTS_KEY || chatId === WORK_DEFAULTS_KEY) return;
    const existing = this.cache[chatId] ?? {};
    if (existing.seen === true) return;
    this.cache[chatId] = { ...existing, seen: true };
    this.flush();
  }

  /** 彻底删除某 chat 配置（disband 解散群后调，防 spawnAllKnownChannels 重拉已解散群）。 */
  remove(chatId: string): void {
    if (chatId === DEFAULTS_KEY || chatId === WORK_DEFAULTS_KEY) return;
    if (this.cache[chatId]) { delete this.cache[chatId]; this.flush(); }
  }

  /** 待机标记读写（2026-06-19）。set true = 该频道进待机；false = 恢复常驻。 */
  isStandby(chatId: string): boolean {
    return this.cache[chatId]?.standby === true;
  }

  setStandby(chatId: string, standby: boolean): void {
    if (chatId === DEFAULTS_KEY || chatId === WORK_DEFAULTS_KEY) return;
    const existing = this.cache[chatId] ?? {};
    this.cache[chatId] = { ...existing, standby };
    this.flush();
  }

  private flush(): void {
    const tmpPath = `${this.filePath}.tmp.${process.pid}`;
    const json = JSON.stringify(this.cache, null, 2);
    try {
      fs.writeFileSync(tmpPath, json, 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (e) {
      // tmp 写或 rename 失败 → 清 tmp。⚠️ 后果：本次改动只在内存、整启动器一重启就丢，
      // 必须显眼报错（旧版写"cache 仍内存有效"语气太轻，会被误当无害）。
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      process.stderr.write(
        `[channel-config-store] ❌ flush 失败：配置改动未落盘，重启将丢失！path=${this.filePath} err=${e instanceof Error ? e.message : e}\n`,
      );
    }
  }

}
