#!/usr/bin/env node
import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { handleInboundMessage, setBotAppId } from './notifications/chat-message.js';
import { seedKnownUsersFromEnv } from './utils/sender-names.js';
import { initNameMapStore } from '../shared/name-map-store.js';
import { SupervisorClient } from '../ipc/supervisor-client.js';
import { setSupervisorClient } from '../ipc/client-singleton.js';
import { IPC_METHODS, type PollVoteParams, type PollVoteResult } from '../ipc/protocol.js';
import { getDiyPoll, upsertPollVote, countPollVotes } from './db/database.js';
import { initFeishuClient } from './tools/feishu-send.js';
import { sanitizeToolResult, sanitizeChannelParams } from './utils/sanitize-surrogates.js';
// 阶段 5 步骤 4：诉求 B 传话筒 3 tools
import {
  pinpinSpawnWorkSessionTool,
  handlePinpinSpawnWorkSession,
} from './tools/pinpin-spawn-work-session.js';
import {
  pinpinSendToWorkSessionTool,
  handlePinpinSendToWorkSession,
} from './tools/pinpin-send-to-work-session.js';
import {
  pinpinEndWorkSessionTool,
  handlePinpinEndWorkSession,
} from './tools/pinpin-end-work-session.js';
// P3.Q7：peek work session（品品主动观察后台 work 跑到哪一步）
import {
  pinpinPeekWorkSessionTool,
  handlePinpinPeekWorkSession,
} from './tools/pinpin-peek-work-session.js';
// 阶段 3 批 2：4 tool 拆分作废 zzzpin 字符串协议
import { PINPIN_REPLY_TEXT_TOOL, handlePinpinReplyText } from './tools/pinpin-reply-text.js';
import { PINPIN_REPLY_VOICE_TOOL, handlePinpinReplyVoice } from './tools/pinpin-reply-voice.js';
import { PINPIN_REACT_TOOL, handlePinpinReact } from './tools/pinpin-react.js';
import { PINPIN_MEMORIZE_TOOL, handlePinpinMemorize } from './tools/pinpin-memorize.js';
import { PINPIN_NO_REPLY_TOOL, handlePinpinNoReply } from './tools/pinpin-no-reply.js';
import { PINPIN_SEND_FILE_TOOL, handlePinpinSendFile } from './tools/pinpin-send-file.js';
import { PINPIN_SAVE_FILE_TOOL, handlePinpinSaveFile } from './tools/pinpin-save-file.js';
// 阶段 4：DB 初始化 + cron 注册（import 触发 registerCron 副作用）
import { initDatabase, closeDatabase } from './db/database.js';
import { startAllCrons, stopAllCrons } from './cron/registry.js';
import { logBackground } from './utils/background-log.js';
import { setServerInstance } from './utils/push-channel.js';
// 阶段 4 批次 2：定时播报类 cron（import 触发 registerCron 副作用）
import './cron/daily-news.js';
import './cron/weekly-recap.js';
import './cron/memory-audit.js';
import './cron/free-activity.js';
import './cron/daily-diary.js';
import './cron/ball-partner-tasks.js';
import { schedulerStart, schedulerStop } from './cron/scheduled-jobs-tick.js';
// 阶段 4 批次 1 步骤 1.5：read_chat_log tool
import { readChatLogTool, handleReadChatLog } from './tools/read-chat-log.js';
// 阶段 4 批次 2 tools（13 个）
import { sendPrivateMessageTool, handleSendPrivateMessage } from './tools/send-private-message.js';
import { createGroupTool, handleCreateGroup } from './tools/create-group.js';
import { disbandGroupTool, handleDisbandGroup } from './tools/disband-group.js';
import { listActiveChatsTool, handleListActiveChats } from './tools/list-active-chats.js';
import { listChatTabsTool, handleListChatTabs } from './tools/list-chat-tabs.js';
import { deleteCloudDocTool, handleDeleteCloudDoc } from './tools/delete-cloud-doc.js';
import { readDocTodosTool, handleReadDocTodos, setDocTodoTool, handleSetDocTodo } from './tools/doc-todos.js';
import { writeSheetTool, handleWriteSheet } from './tools/write-sheet.js';
import { writeBitableTool, handleWriteBitable } from './tools/write-bitable.js';
import { listWikiSpacesTool, handleListWikiSpaces } from './tools/list-wiki-spaces.js';
import { writeDiaryTool, handleWriteDiary } from './tools/write-diary.js';
import { writeWeeklyRecapTool, handleWriteWeeklyRecap } from './tools/write-weekly-recap.js';
import { readPushedNewsUrlsTool, handleReadPushedNewsUrls } from './tools/read-pushed-news-urls.js';
import { sendDailyNewsCardTool, handleSendDailyNewsCard } from './tools/send-daily-news-card.js';
import { memoryAuditReadTool, handleMemoryAuditRead } from './tools/memory-audit-read.js';
import { memoryRewriteTool, handleMemoryRewrite } from './tools/memory-rewrite.js';
import { createCloudDocTool, handleCreateCloudDoc } from './tools/create-cloud-doc.js';
import { readAttachmentTool, handleReadAttachment } from './tools/read-attachment.js';
import { readCloudDocTool, handleReadCloudDoc, editCloudDocTool, handleEditCloudDoc } from './tools/cloud-doc-rw.js';
import { writeJourneyLogTool, handleWriteJourneyLog } from './tools/write-journey-log.js';
import { triggerFreeActivityTool, handleTriggerFreeActivity } from './tools/trigger-free-activity.js';
// 阶段 4 批次 3 tools（6 个）
import { moodAppraiseTool, handleMoodAppraise } from './tools/mood-appraise.js';
import { moodGetCurrentTool, handleMoodGetCurrent } from './tools/mood-get-current.js';
import { scheduleReminderTool, handleScheduleReminder } from './tools/schedule-reminder.js';
import { cancelScheduledTool, handleCancelScheduled } from './tools/cancel-scheduled.js';
import { notifyWhenSpeaksTool, handleNotifyWhenSpeaks } from './tools/notify-when-speaks.js';
// 2026-05-28 多 CLI 落地：跨频道发言 tool（free-activity 茶水间触发后品品自决跨群用）
import { CROSS_CHAT_MESSAGE_TOOL, handleCrossChatMessage } from './tools/cross-chat-message.js';
// 传话主动催 relay tool
import { relayMessageTool, handleRelayMessage } from './tools/relay-message.js';
// 2026-05-28 阶段补齐：飞书自带任务 6 tool（task CRUD + OAuth）
import {
  FEISHU_AUTHORIZE_TOOL,
  FEISHU_SUBMIT_AUTH_CODE_TOOL,
  FEISHU_TASK_CREATE_TOOL,
  FEISHU_TASK_DONE_TOOL,
  FEISHU_TASK_DELETE_TOOL,
  FEISHU_SUBTASK_ADD_TOOL,
  FEISHU_TASK_QUERY_TOOL,
  FEISHU_TASK_MANAGE_TOOL,
  handleFeishuAuthorize,
  handleFeishuSubmitAuthCode,
  handleFeishuTaskCreate,
  handleFeishuTaskDone,
  handleFeishuTaskDelete,
  handleFeishuSubtaskAdd,
  handleFeishuTaskQuery,
  handleFeishuTaskManage,
} from './tools/feishu-task.js';
// 2026-05-28 阶段补齐：OWNER 命令 3 tool
import {
  RESTART_SELF_TOOL,
  SLEEP_SELF_TOOL,
  COMPACT_CHAT_TOOL,
  handleRestartSelf,
  handleSleepSelf,
  handleCompactChat,
} from './tools/owner-commands.js';
// 2026-05-28 阶段补齐：辅助 2 tool
import {
  RESOLVE_OPEN_ID_TOOL,
  ARCHIVE_SEARCH_TOOL,
  handleResolveOpenId,
  handleArchiveSearch,
} from './tools/misc-tools.js';
// 2026-05-28 阶段补齐：卡片家族 4 tool（含 confirm_dangerous_action 降级版）
import {
  SEND_CARD_TOOL,
  SEND_POLL_CARD_TOOL,
  CONFIRM_DANGEROUS_ACTION_TOOL,
  handleSendCard,
  handleSendPollCard,
  handleConfirmDangerousAction,
} from './tools/cards.js';

async function main() {
  const server = new Server(
    {
      name: 'feishu-channel',
      version: '0.0.1',
    },
    {
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
        },
      },
      // 全量人格/协议/记忆改走 supervisor 的 --append-system-prompt-file（突破本字段 2KB 截断，
      // 详见 instructions.ts 文件头）。此处仅留极简兜底——万一注入文件生成失败，品品至少知道 channel 机制。
      instructions:
        '飞书消息以 <channel ...> 标签到达。完整人格/行为协议/永存记忆/人物画像/心境见 system prompt。' +
        '收到用户消息每轮必调一个工具回应：pinpin_reply_text / pinpin_reply_voice / pinpin_react 或 pinpin_no_reply。',
    },
  );

  // ── tool 注册 ──

  // alwaysLoad 白名单：ENABLE_TOOL_SEARCH=true 下所有 MCP tool 默认折叠（按需 ToolSearch），
  // 仅本名单内 tool 注入 _meta['app/alwaysLoad'] 豁免常驻。
  // 划分依据：① 每轮回话必调 ② 每轮 reply 后 trigger 自动触发（心情/记忆）③ cron 必成功
  // ④ work-stopped 被动触发——这些自动场景多数无法即时实测，保常驻防"搜不到→静默哑"。
  // 其余（建群/云文档/飞书任务/owner/chrome 等）= 主动随机用，折叠按需（主动场景 ToolSearch 可靠）。
  const ALWAYS_LOAD = new Set<string>([
    'pinpin_reply_text', 'pinpin_reply_voice', 'pinpin_react', 'pinpin_no_reply',
    'pinpin_memorize', 'mood_appraise', 'read_chat_log',
    'write_diary', 'send_daily_news_card', 'write_weekly_recap',
    'write_journey_log', 'memory_rewrite', 'pinpin_peek_work_session',
    // weekly-recap cron 还调 create_cloud_doc + send_private_message；ball-tasks cron 调 read_doc_todos；
    // relay-nudge/callback 调 send_private_message——均自动触发、无法即时实测，保常驻防静默哑。
    'create_cloud_doc', 'send_private_message', 'read_doc_todos',
  ]);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      PINPIN_REPLY_TEXT_TOOL,
      PINPIN_REPLY_VOICE_TOOL,
      PINPIN_REACT_TOOL,
      PINPIN_MEMORIZE_TOOL,
      PINPIN_NO_REPLY_TOOL,
      PINPIN_SEND_FILE_TOOL,
      PINPIN_SAVE_FILE_TOOL,
      readChatLogTool,
      // 阶段 4 批次 2（13 个）
      sendPrivateMessageTool,
      listActiveChatsTool,
      listChatTabsTool,
      writeDiaryTool,
      writeWeeklyRecapTool,
      readPushedNewsUrlsTool,
      sendDailyNewsCardTool,
      memoryAuditReadTool,
      memoryRewriteTool,
      createCloudDocTool,
      readCloudDocTool,
      editCloudDocTool,
      deleteCloudDocTool,
      readDocTodosTool,
      setDocTodoTool,
      readAttachmentTool,
      writeJourneyLogTool,
      triggerFreeActivityTool,
      // 阶段 4 批次 3（6 个）
      moodAppraiseTool,
      moodGetCurrentTool,
      scheduleReminderTool,
      cancelScheduledTool,
      notifyWhenSpeaksTool,
      // 阶段 5 步骤 4：诉求 B 传话筒 work session 3 tools + P3.Q7 peek
      pinpinSpawnWorkSessionTool,
      pinpinSendToWorkSessionTool,
      pinpinEndWorkSessionTool,
      pinpinPeekWorkSessionTool,
      // 2026-05-28 多 CLI 跨频道发言
      CROSS_CHAT_MESSAGE_TOOL,
      // 2026-05-29 建群 / 解散群
      createGroupTool,
      disbandGroupTool,
      // 传话主动催
      relayMessageTool,
      // 2026-05-28 阶段补齐：飞书自带任务 6 tool
      FEISHU_AUTHORIZE_TOOL,
      FEISHU_SUBMIT_AUTH_CODE_TOOL,
      FEISHU_TASK_CREATE_TOOL,
      FEISHU_TASK_DONE_TOOL,
      FEISHU_TASK_DELETE_TOOL,
      FEISHU_SUBTASK_ADD_TOOL,
      // C3 扩权：看全貌(query) + 改/移/分组/评论(manage)
      FEISHU_TASK_QUERY_TOOL,
      FEISHU_TASK_MANAGE_TOOL,
      // 2026-05-28 阶段补齐：OWNER 命令 3 tool
      RESTART_SELF_TOOL,
      SLEEP_SELF_TOOL,
      COMPACT_CHAT_TOOL,
      // 2026-05-28 阶段补齐：辅助 2 tool
      RESOLVE_OPEN_ID_TOOL,
      ARCHIVE_SEARCH_TOOL,
      // 2026-05-28 阶段补齐：卡片家族 4 tool（send_poll_card 已实装，重新加回）
      SEND_CARD_TOOL,
      SEND_POLL_CARD_TOOL,
      CONFIRM_DANGEROUS_ACTION_TOOL,
      // 群云文档：填电子表格 / 填多维表 / 列知识库（create_cloud_doc 已含建表+挂群+权限）
      writeSheetTool,
      writeBitableTool,
      listWikiSpacesTool,
    ].map((t) =>
      ALWAYS_LOAD.has(t.name)
        ? {
            ...t,
            _meta: {
              ...((t as { _meta?: Record<string, unknown> })._meta ?? {}),
              'app/alwaysLoad': true,
            },
          }
        : t,
    ),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // 总闸门：所有 tool 返回送进 Claude 前净化落单 surrogate（防半 emoji 致 API 400）
    const result = await (async () => {
    switch (name) {
      // 阶段 3 批 2 新 4 tool
      case 'pinpin_reply_text':
        return handlePinpinReplyText(args as unknown as Parameters<typeof handlePinpinReplyText>[0]);
      case 'pinpin_reply_voice':
        return handlePinpinReplyVoice(args as unknown as Parameters<typeof handlePinpinReplyVoice>[0]);
      case 'pinpin_react':
        return handlePinpinReact(args as unknown as Parameters<typeof handlePinpinReact>[0]);
      case 'pinpin_memorize':
        return handlePinpinMemorize(args as unknown as Parameters<typeof handlePinpinMemorize>[0]);
      case 'pinpin_no_reply':
        return handlePinpinNoReply();
      case 'pinpin_send_file':
        return handlePinpinSendFile(args as unknown as Parameters<typeof handlePinpinSendFile>[0]);
      case 'pinpin_save_file':
        return handlePinpinSaveFile(args as unknown as Parameters<typeof handlePinpinSaveFile>[0]);
      case 'read_chat_log':
        return handleReadChatLog(args as unknown as Parameters<typeof handleReadChatLog>[0]);
      // 阶段 4 批次 2
      case 'send_private_message':
        return handleSendPrivateMessage(args as unknown as Parameters<typeof handleSendPrivateMessage>[0]);
      case 'create_group':
        return handleCreateGroup(args as unknown as Parameters<typeof handleCreateGroup>[0]);
      case 'disband_group':
        return handleDisbandGroup(args as unknown as Parameters<typeof handleDisbandGroup>[0]);
      case 'list_active_chats':
        return handleListActiveChats();
      case 'list_chat_tabs':
        return handleListChatTabs(args as unknown as Parameters<typeof handleListChatTabs>[0]);
      case 'write_diary':
        return handleWriteDiary(args as unknown as Parameters<typeof handleWriteDiary>[0]);
      case 'write_weekly_recap':
        return handleWriteWeeklyRecap(args as unknown as Parameters<typeof handleWriteWeeklyRecap>[0]);
      case 'read_pushed_news_urls':
        return handleReadPushedNewsUrls(args as unknown as Parameters<typeof handleReadPushedNewsUrls>[0]);
      case 'send_daily_news_card':
        return handleSendDailyNewsCard(args as unknown as Parameters<typeof handleSendDailyNewsCard>[0]);
      case 'memory_audit_read':
        return handleMemoryAuditRead();
      case 'memory_rewrite':
        return handleMemoryRewrite(args as unknown as Parameters<typeof handleMemoryRewrite>[0]);
      case 'create_cloud_doc':
        return handleCreateCloudDoc(args as unknown as Parameters<typeof handleCreateCloudDoc>[0]);
      case 'read_attachment':
        return handleReadAttachment(args as unknown as Parameters<typeof handleReadAttachment>[0]);
      case 'read_cloud_doc':
        return handleReadCloudDoc(args as unknown as Parameters<typeof handleReadCloudDoc>[0]);
      case 'edit_cloud_doc':
        return handleEditCloudDoc(args as unknown as Parameters<typeof handleEditCloudDoc>[0]);
      case 'delete_cloud_doc':
        return handleDeleteCloudDoc(args as unknown as Parameters<typeof handleDeleteCloudDoc>[0]);
      case 'read_doc_todos':
        return handleReadDocTodos(args as unknown as Parameters<typeof handleReadDocTodos>[0]);
      case 'set_doc_todo':
        return handleSetDocTodo(args as unknown as Parameters<typeof handleSetDocTodo>[0]);
      case 'write_journey_log':
        return handleWriteJourneyLog(args as unknown as Parameters<typeof handleWriteJourneyLog>[0]);
      case 'trigger_free_activity':
        return handleTriggerFreeActivity(args as unknown as Parameters<typeof handleTriggerFreeActivity>[0]);
      // 阶段 4 批次 3
      case 'mood_appraise':
        return handleMoodAppraise(args as unknown as Parameters<typeof handleMoodAppraise>[0]);
      case 'mood_get_current':
        return handleMoodGetCurrent();
      case 'schedule_reminder':
        return handleScheduleReminder(args as unknown as Parameters<typeof handleScheduleReminder>[0]);
      case 'cancel_scheduled':
        return handleCancelScheduled(args as unknown as Parameters<typeof handleCancelScheduled>[0]);
      case 'notify_when_speaks':
        return handleNotifyWhenSpeaks(args as unknown as Parameters<typeof handleNotifyWhenSpeaks>[0]);
      // 阶段 5 步骤 4：诉求 B 传话筒 work session 3 tools
      case 'pinpin_spawn_work_session':
        return handlePinpinSpawnWorkSession(args as unknown as Parameters<typeof handlePinpinSpawnWorkSession>[0]);
      case 'pinpin_send_to_work_session':
        return handlePinpinSendToWorkSession(args as unknown as Parameters<typeof handlePinpinSendToWorkSession>[0]);
      case 'pinpin_end_work_session':
        return handlePinpinEndWorkSession(args as unknown as Parameters<typeof handlePinpinEndWorkSession>[0]);
      // P3.Q7: peek work session（品品主动观察）
      case 'pinpin_peek_work_session':
        return handlePinpinPeekWorkSession(args as unknown as Parameters<typeof handlePinpinPeekWorkSession>[0]);
      // 2026-05-28 多 CLI 跨频道发言
      case 'cross_chat_message':
        return handleCrossChatMessage(args as unknown as Parameters<typeof handleCrossChatMessage>[0]);
      // 传话主动催
      case 'relay_message':
        return handleRelayMessage(args as unknown as Parameters<typeof handleRelayMessage>[0]);
      // 2026-05-28 阶段补齐：飞书自带任务 6 tool
      case 'feishu_authorize':
        return handleFeishuAuthorize();
      case 'feishu_submit_auth_code':
        return handleFeishuSubmitAuthCode(args as unknown as Parameters<typeof handleFeishuSubmitAuthCode>[0]);
      case 'feishu_task_create':
        return handleFeishuTaskCreate(args as unknown as Parameters<typeof handleFeishuTaskCreate>[0]);
      case 'feishu_task_done':
        return handleFeishuTaskDone(args as unknown as Parameters<typeof handleFeishuTaskDone>[0]);
      case 'feishu_task_delete':
        return handleFeishuTaskDelete(args as unknown as Parameters<typeof handleFeishuTaskDelete>[0]);
      case 'feishu_subtask_add':
        return handleFeishuSubtaskAdd(args as unknown as Parameters<typeof handleFeishuSubtaskAdd>[0]);
      case 'feishu_task_query':
        return handleFeishuTaskQuery(args as unknown as Parameters<typeof handleFeishuTaskQuery>[0]);
      case 'feishu_task_manage':
        return handleFeishuTaskManage(args as unknown as Parameters<typeof handleFeishuTaskManage>[0]);
      // 2026-05-28 阶段补齐：OWNER 命令 3 tool
      case 'restart_self':
        return handleRestartSelf();
      case 'sleep_self':
        return handleSleepSelf();
      case 'compact_chat':
        return handleCompactChat();
      // 2026-05-28 阶段补齐：辅助 3 tool
      case 'resolve_open_id':
        return handleResolveOpenId(args as unknown as Parameters<typeof handleResolveOpenId>[0]);
      case 'archive_search':
        return handleArchiveSearch(args as unknown as Parameters<typeof handleArchiveSearch>[0]);
      // 2026-05-28 阶段补齐：卡片家族 4 tool
      case 'send_card':
        return handleSendCard(args as unknown as Parameters<typeof handleSendCard>[0]);
      case 'write_sheet':
        return handleWriteSheet(args as unknown as Parameters<typeof handleWriteSheet>[0]);
      case 'write_bitable':
        return handleWriteBitable(args as unknown as Parameters<typeof handleWriteBitable>[0]);
      case 'list_wiki_spaces':
        return handleListWikiSpaces();
      case 'send_poll_card':
        return handleSendPollCard(args as unknown as Parameters<typeof handleSendPollCard>[0]);
      case 'confirm_dangerous_action':
        return handleConfirmDangerousAction(args as unknown as Parameters<typeof handleConfirmDangerousAction>[0]);
      default:
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `未知 tool: ${name}（可用：pinpin_reply_text / pinpin_reply_voice / pinpin_react / pinpin_memorize）` }],
        };
    }
    })();
    return sanitizeToolResult(result);
  });

  // ── 飞书 Client 初始化 ──

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID / FEISHU_APP_SECRET 未配置（.env 缺字段）');
  }
  initFeishuClient(appId, appSecret);
  setBotAppId(appId);

  // ── 阶段 4：DB 初始化 ──
  initDatabase();
  process.stderr.write('[feishu-channel] DB initialized\n');

  // C2 身份归一：把 FEISHU_KNOWN_USERS 种子灌入 known_users DB（DB 是真人映射单一运行时权威源）
  seedKnownUsersFromEnv();

  // 人名/bot名共享映射：绑定 supervisor 传来的 name-mappings.json（读端，mtime 热重载=实时）
  if (process.env.PINPIN_NAME_MAP_PATH) initNameMapStore(process.env.PINPIN_NAME_MAP_PATH);

  // F1：启动时打实际读到的关键 env（脱敏）——证明"某 CLI 某点在线" + 排查 env 透传漏配
  // （stderr 进 Claude Code 内部 debug 文件查不到，故走 logBackground → 系统日志\后台账本 这一处可查通道）
  logBackground(
    "mcp-boot",
    `本CLI[…${(process.env.PINPIN_CHAT_ID ?? "?").slice(-6)}] 启动` +
      ` | TEA=${process.env.PINPIN_TEA_CHAT_ID ? "✓" : "✗"}` +
      ` OWNER=${process.env.PINPIN_OWNER_CHAT_ID ? "✓" : "✗"}` +
      ` OWNER=${process.env.FEISHU_OWNER_OPEN_ID ? "✓" : "✗"}` +
      ` SUPERVISOR=${process.env.PINPIN_SUPERVISOR_PORT ? "✓" : "✗"}`,
  );

  // ── 传输连接 ──

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdio MCP server 禁止往 stdout 写日志（会污染 JSON-RPC 协议帧）
  process.stderr.write('[feishu-channel] MCP server started\n');

  // ── 多 CLI 频道隔离架构（step 3）：连 supervisor IPC，接收按 chat_id 路由过来的飞书消息 ──
  // 砍掉本进程飞书 poll（破立同步——supervisor 集中 poll 单点）。
  const chatId = process.env.PINPIN_CHAT_ID;
  const supervisorPort = Number(process.env.PINPIN_SUPERVISOR_PORT);
  let ipcClient: SupervisorClient | null = null;
  if (chatId && supervisorPort) {
    ipcClient = new SupervisorClient(chatId, supervisorPort);
    setSupervisorClient(ipcClient);
    // 方案A：supervisor 把投票记票路由到本（有 DB 的）子进程执行，回票数给 supervisor 刷卡
    ipcClient.setRequestHandler(IPC_METHODS.POLL_VOTE, async (raw): Promise<PollVoteResult> => {
      const { poll_id, option_idx, voter_open_id } = raw as PollVoteParams;
      try {
        const poll = getDiyPoll(poll_id);
        if (!poll) return { ok: false, error: `poll not found: ${poll_id}` };
        const options: string[] = JSON.parse(poll.options_json);
        if (option_idx < 0 || option_idx >= options.length) {
          return { ok: false, error: `invalid option_idx=${option_idx} for poll ${poll_id}` };
        }
        upsertPollVote(poll_id, voter_open_id, option_idx);
        const votes: Record<number, number> = {};
        for (const row of countPollVotes(poll_id)) votes[row.option_idx] = row.count;
        return { ok: true, question: poll.question, options, votes };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
    ipcClient.on('feishu-message', (p: { message: Parameters<typeof handleInboundMessage>[1] }) => {
      void handleInboundMessage(server, p.message);
    });
    // 重连兜底耗尽（supervisor 彻底失联）才会触发——不退出进程，保住上下文，仅打日志便于排查
    ipcClient.on('disconnect', () => {
      process.stderr.write(
        `[feishu-channel] ⚠️ IPC 彻底失联 (chat=${chatId})，重连已耗尽；降级运行（tools 可用、无入站消息），等 supervisor 重启重建本 CLI\n`,
      );
    });
    ipcClient.on('chat-trigger', async (p: { body: string; meta?: Record<string, string> }) => {
      try {
        await server.notification({
          method: 'notifications/claude/channel',
          params: sanitizeChannelParams(p.body, { source: 'feishu-channel', chat_id: chatId, ...(p.meta ?? {}) }),
        });
      } catch (e) {
        process.stderr.write(`[feishu-channel] chat-trigger notification 失败: ${e instanceof Error ? e.message : e}\n`);
      }
    });
    // work session stop signal：supervisor push WORK_STOPPED → channel notification 给本 CLI
    ipcClient.on('work-stopped', async (p: {
      session_id: string;
      is_error: boolean;
      stop_reason?: string;
      duration_ms?: number;
      total_cost_usd?: number;
    }) => {
      try {
        // 完工通知保持轻 + 封闭单步（防 high-effort thinking 螺旋：开放指令是螺旋燃料）。
        // 一句封闭指令——调 peek 看本 turn 全程 → 用自己的话把最新进展汇报Owner → 不必深度思考。
        // 不带摘要（让品品自己 peek 看全程；旧版 800 字大段 + 多分支强制指令曾致品品 high 螺旋、
        // tool call malformed、卡死 10min）。
        const summary =
          `【工作 CLI 停下等指示｜${p.session_id}】` +
          (p.duration_ms ? `已跑 ${(p.duration_ms / 1000).toFixed(0)}s。` : '') +
          `它停下工作了， pinpin_peek_work_session 查看本turn全程，然后用你自己的话把最新进展飞书汇报给Owner。不必深度思考。`;
        await server.notification({
          method: 'notifications/claude/channel',
          params: sanitizeChannelParams(summary, {
            source: 'feishu-channel',
            chat_id: chatId,
            trigger: 'work-stopped',
            session_id: p.session_id,
            is_error: String(p.is_error),
          }),
        });
      } catch (e) {
        process.stderr.write(`[feishu-channel] work-stopped notification 失败: ${e instanceof Error ? e.message : e}\n`);
      }
    });
    await ipcClient.connect();
    process.stderr.write(`[feishu-channel] IPC connected to supervisor (chat=${chatId}, port=${supervisorPort})\n`);
  } else {
    // 兼容旧路径（vault \.mcp.json spawn 时无 supervisor env）：不连 IPC，仅 tools 可用
    // 这种情况下不会收到飞书消息——属于"degraded mode"，本进程仍可被 claude CLI 调 tool
    process.stderr.write(
      `[feishu-channel] PINPIN_CHAT_ID / PINPIN_SUPERVISOR_PORT 未设，degraded mode（tools only，无入站消息流）\n`,
    );
  }

  // 阶段 4：注入 server 实例供 push-channel.ts 推 trigger
  setServerInstance(server);

  // cron + timer scheduler 在本子进程跑；多子进程同名 cron 靠 scheduled_tasks last_run_at 去重。
  startAllCrons();
  schedulerStart();
  process.stderr.write('[feishu-channel] cron + timer scheduler started\n');

  // 优雅关闭
  const shutdown = (signal: string) => {
    process.stderr.write(`[feishu-channel] 收到 ${signal}，清理 IPC + cron + scheduler + DB...\n`);
    ipcClient?.shutdown();
    stopAllCrons();
    schedulerStop();
    closeDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`[feishu-channel] fatal: ${err}\n`);
  process.exit(1);
});
