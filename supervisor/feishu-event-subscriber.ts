/**
 * Feishu 事件订阅长连接 —— P3.Q3 单聊 P2P 监听 + 群聊 user 消息实时推送 + 卡片回调
 *
 * 为什么存在：飞书 chat.list API 天然不返 P2P 单聊 → poll 路径永远拉不到单聊消息。
 * 飞书原生事件订阅（im.message.receive_v1）通过 SDK WSClient 长连接推送 user 消息（含 P2P）。
 *
 * 跟 poll 关系：**双轨并存**（飞书生态唯一可行架构，早期版本同款，1 年生产验证）：
 *   - 本订阅器：接 user 消息（含 P2P 单聊 + 群聊用户消息）+ cardAction（投票卡点击）
 *   - feishu-poll.ts：接 bot 消息（群聊 bot-to-bot；WSClient 不推 bot 消息是平台限制）
 *   - 群聊 user 消息双源（双方都推）→ supervisor.onFeishuMessage 入口 message_id 去重
 *
 * 实装参考：早期版本 src/feishu/client.ts createLarkChannel 模式（SDK 1.55+ 高层封装）。
 *
 * **纯飞书消息通道**：WSClient 连飞书开放平台 wss://open.feishu.cn/...，只走飞书消息，不承担推理。
 * 纯消息通道，不承担推理。
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import type { CardActionEvent, ReactionEvent, BotAddedEvent, CommentEvent } from '@larksuiteoapi/node-sdk';
import type { FeishuInboundMessage } from './feishu-poll.js';

/** 卡片投票回调结构（action.value.poll_id + option_idx） */
export interface PollActionValue {
  poll_id: string;
  option_idx: number;
}

export interface FeishuEventSubscriberOptions {
  appId: string;
  appSecret: string;
  /** 收到 user 消息时调用——会走 supervisor.onFeishuMessage 同款路径 */
  onMessage: (msg: FeishuInboundMessage) => void | Promise<void>;
  /** 收到卡片投票点击时调用（supervisor 处理计票 + 刷卡片） */
  onPollAction?: (evt: CardActionEvent, value: PollActionValue) => void | Promise<void>;
  /** 别人加/撤消息表情回复（reaction 无 chat_id，supervisor 侧反查路由） */
  onReaction?: (evt: ReactionEvent) => void | Promise<void>;
  /** 品品被拉进某群（evt.chatId 即新群） */
  onBotAdded?: (evt: BotAddedEvent) => void | Promise<void>;
  /** 云文档评论（无 chat_id，supervisor 侧投兜底频道） */
  onComment?: (evt: CommentEvent) => void | Promise<void>;
}

export class FeishuEventSubscriber {
  private channel: Lark.LarkChannel | null = null;
  private opts: FeishuEventSubscriberOptions;
  private started = false;

  constructor(opts: FeishuEventSubscriberOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.channel = Lark.createLarkChannel({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      transport: 'websocket',
      loggerLevel: Lark.LoggerLevel.warn,
      policy: {
        // 跟 早期版本同款配置：群聊无需 @bot 也响应 + 单聊默认 open
        requireMention: false,
        dmMode: 'open',
      },
      // 开 includeRawEvent：让 normalize 后 msg.raw 仍含原始飞书 event body（mentions 解析等用）
      includeRawEvent: true,
    });

    // policy reject（drop 原因）—— 调试用日志
    this.channel.on('reject', (evt) => {
      process.stderr.write(
        `[feishu-event] policy reject: reason=${evt.reason} chatId=${evt.chatId ?? '?'} msgId=${evt.messageId ?? '?'}\n`,
      );
    });

    // 消息事件 —— fire-and-forget（飞书 3 秒 ack 约束，handler 不阻塞）
    this.channel.on('message', (msg: Lark.NormalizedMessage) => {
      setImmediate(() => {
        try {
          const inbound = this.normalize(msg);
          Promise.resolve(this.opts.onMessage(inbound)).catch((e) => {
            process.stderr.write(
              `[feishu-event] onMessage 异步异常: ${e instanceof Error ? e.message : e}\n`,
            );
          });
        } catch (e) {
          process.stderr.write(
            `[feishu-event] message handler 同步异常: ${e instanceof Error ? e.message : e}\n`,
          );
        }
      });
    });

    // 卡片交互回调（投票按钮点击）—— 只处理携带 poll_id 的 callback action
    if (this.opts.onPollAction) {
      this.channel.on('cardAction', (evt: CardActionEvent) => {
        setImmediate(() => {
          try {
            const val = evt.action?.value as Partial<PollActionValue> | undefined;
            if (
              typeof val?.poll_id !== 'string' ||
              typeof val?.option_idx !== 'number'
            ) {
              // 非投票卡回调，忽略
              return;
            }
            Promise.resolve(
              this.opts.onPollAction!(evt, { poll_id: val.poll_id, option_idx: val.option_idx }),
            ).catch((e) => {
              process.stderr.write(
                `[feishu-event] onPollAction 异步异常: ${e instanceof Error ? e.message : e}\n`,
              );
            });
          } catch (e) {
            process.stderr.write(
              `[feishu-event] cardAction handler 同步异常: ${e instanceof Error ? e.message : e}\n`,
            );
          }
        });
      });
    }

    // 表情回复 / 被拉进群 / 云文档评论 —— 均 fire-and-forget（飞书 3s ack 约束，不阻塞）
    // SDK 封装层已归一化好事件（dispatcher 注册 im.message.reaction.*_v1 / im.chat.member.bot.added_v1 /
    // drive.notice.comment_add_v1），这里只把归一化 evt 转交 supervisor 路由投递。
    if (this.opts.onReaction) {
      this.channel.on('reaction', (evt: ReactionEvent) => {
        setImmediate(() => {
          Promise.resolve(this.opts.onReaction!(evt)).catch((e) => {
            process.stderr.write(`[feishu-event] onReaction 异步异常: ${e instanceof Error ? e.message : e}\n`);
          });
        });
      });
    }
    if (this.opts.onBotAdded) {
      this.channel.on('botAdded', (evt: BotAddedEvent) => {
        setImmediate(() => {
          Promise.resolve(this.opts.onBotAdded!(evt)).catch((e) => {
            process.stderr.write(`[feishu-event] onBotAdded 异步异常: ${e instanceof Error ? e.message : e}\n`);
          });
        });
      });
    }
    if (this.opts.onComment) {
      this.channel.on('comment', (evt: CommentEvent) => {
        setImmediate(() => {
          Promise.resolve(this.opts.onComment!(evt)).catch((e) => {
            process.stderr.write(`[feishu-event] onComment 异步异常: ${e instanceof Error ? e.message : e}\n`);
          });
        });
      });
    }

    this.channel.on('error', (err: { code?: string; message?: string }) => {
      process.stderr.write(
        `[feishu-event] LarkChannel error code=${err.code ?? '?'}: ${err.message ?? ''}\n`,
      );
    });
    this.channel.on('reconnecting', () => {
      process.stderr.write('[feishu-event] ⚠️ WS 断开，正在重连...\n');
    });
    this.channel.on('reconnected', () => {
      process.stderr.write('[feishu-event] ✅ WS 重连成功\n');
    });

    // 平台订阅但无业务处理的 3 个事件——注册空 handler 消 SDK "no xxx handle" warn 刷屏
    // SDK 升级需复查此 cast
    (this.channel as unknown as { dispatcher: { register(h: Record<string, () => void>): void } })
      .dispatcher.register({
        'im.chat.access_event.bot_p2p_chat_entered_v1': () => {},
        'im.message.message_read_v1': () => {},
        'im.message.recalled_v1': () => {},
      });

    // **关键**：createLarkChannel 只返回 channel 实例，不自动建 WS 握手——必须显式 connect()
    // (reviewer 实测发现：v1 漏 connect 导致 "买了手机从没开机"，所有事件永远不触发)
    await this.channel.connect();
    process.stderr.write('[feishu-event] WSClient 长连接已启动（im.message.receive_v1 订阅中）\n');
  }

  /** 更新已发送卡片内容（投票计票后刷新用） */
  async updateCard(messageId: string, card: object): Promise<void> {
    if (!this.channel) {
      throw new Error('FeishuEventSubscriber 未启动，无法调用 updateCard');
    }
    await this.channel.updateCard(messageId, card);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    try {
      // SDK LarkChannel 提供 disconnect() (types/index.d.ts 第 301122 行) —— 必须 await 释放 WS 连接
      // (v1 仅 null GC = WS 连接泄漏，每次 supervisor.stop()/restart 留一个僵尸连接)
      await this.channel?.disconnect();
    } catch (e) {
      process.stderr.write(
        `[feishu-event] disconnect 异常: ${e instanceof Error ? e.message : e}\n`,
      );
    }
    this.channel = null;
    process.stderr.write('[feishu-event] stopped\n');
  }

  /** NormalizedMessage → FeishuInboundMessage（跟 poll 同款协议，supervisor.onFeishuMessage 无感处理） */
  private normalize(msg: Lark.NormalizedMessage): FeishuInboundMessage {
    // SDK 归一化 msg.content 已是纯文本（text/post 已 normalize），msg.raw 含原始 event body
    // WSClient 平台层只推 user 消息（不推 bot 消息——飞书事件订阅平台限制），故 sender_type 固定 'user'
    // msg_type：从 rawContentType 映射回 FeishuInboundMessage.msg_type 协议（'text'/'image'/'post' 等）
    const msgType = msg.rawContentType || 'text';
    // _sdk_resources：SDK convertPost/convertImage 等已解析好的附件列表（type='image'|'file'|... fileKey=key）。
    // chat-message.ts 的 post/image 分支可直接用，无需重复手动解析原始 content JSON。
    // 对 image/file/audio 消息：resources 数组含该附件 key；对 post 富文本：含内嵌图片 key。
    const rawBase = msg.raw ?? msg;
    const raw = msg.resources && msg.resources.length > 0
      ? { ...(rawBase as object), _sdk_resources: msg.resources }
      : rawBase;
    return {
      chat_id: msg.chatId,
      message_id: msg.messageId,
      msg_type: msgType,
      sender_open_id: msg.senderId,
      sender_type: 'user',
      text: msg.content,
      create_time_ms: msg.createTime,
      raw,
    };
  }
}
