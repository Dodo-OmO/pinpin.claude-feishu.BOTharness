# 架构 · Architecture

品品是一个飞书（Lark）里的 AI 伙伴。核心理念：**每个聊天频道跑一个独立的、长期存活的交互式 Claude Code CLI 进程**，由一个 Supervisor 统一拉消息、分发、管理生命周期。本文讲清楚各部件怎么搭起来。

> ⚠️ 本仓不可一键运行（见 [README](README.md)）。以下是架构说明，不是部署教程。

---

## 全景图

```
┌─────────────────────────────────────────────────────────────┐
│ Electron 启动器 (launcher/)                                   │
│   main 进程内嵌 ↓                                              │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Supervisor (supervisor/index.ts)                         │ │
│ │   • FeishuPoll          —— 轮询拉群消息（bot 消息）        │ │
│ │   • FeishuEventSubscriber —— wss 长连接（user 消息含单聊） │ │
│ │   • ChannelCli 池        —— Map<chat_id, ChannelCli>      │ │
│ │   • IPC Server           —— 本机 TCP，子进程回连           │ │
│ │   • CronRunner           —— Supervisor 级定时任务         │ │
│ │   • 崩溃熔断 crashState   —— 5min 崩 N 次停自动重启        │ │
│ └───────────────┬─────────────────────────────────────────┘ │
│                 │ spawn (node-pty, 交互式 claude)             │
│   ┌─────────────┴───────────┬───────────────────────┐        │
│   ▼                         ▼                       ▼         │
│ ChannelCli(群A)        ChannelCli(单聊)       ChannelCli(群B)  │
│   = claude CLI 进程       = claude CLI 进程      = claude CLI   │
│       └─ stdio MCP server (src/mcp/server.ts)                 │
│            飞书工具 / 心境 / 记忆 / 任务 / work…               │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. MCP server —— 工具与人格的承载

入口 `src/mcp/server.ts`，用 `@modelcontextprotocol/sdk` 的 `StdioServerTransport` 跟它的宿主 `claude` 进程通信。它注册了几十个工具（`src/mcp/tools/`），按域分：

- **飞书收发**：`pinpin-reply-text` / `pinpin-reply-voice` / `pinpin-react`（表情回应）/ `pinpin-no-reply`（明确不回但留痕）/ `cross-chat-message`（主动跨频道发言）。
- **飞书能力**：建群 / 解散群、确认卡片。云文档 / 任务 / 日历 / 邮件等飞书业务能力不在 MCP 里，交给官方 lark-cli（见 §5）。
- **人格机制**：`mood-appraise`（心境评估）、`memory-rewrite`（永存记忆重写）、`write-diary`、`trigger-free-activity`。
- **后台 work**：`pinpin-spawn-work-session` / `peek` / `send-to` / `end`（"传话筒"，见 §6）。

飞书 SDK（`@larksuiteoapi/node-sdk`）在 `src/mcp/tools/feishu-send.ts` 单例懒加载，凭据从 env 读。

**核心理念**：CLI + MCP server 是"管道 + 工具"——品品的人格与决策逻辑几乎都在注入 MCP 的 prompt 上下文里（人格 + 协议 + 永存记忆 + 人物画像 + 心境）。所以**改品品的行为，大头改 prompt、小头改代码**。

## 2. 多频道 CLI 隔离

这是品品架构的核心选择：**不是一个进程处理所有频道，而是一聊一进程**。

- `supervisor/channel-cli.ts`：一个 `ChannelCli` = 一个飞书 `chat_id` 对应的交互式 `claude` 子进程，用 `node-pty` spawn（伪终端，不走 shell）。
- 子进程通过 vault 的 `.mcp.json` 自启 `dist/mcp/server.js` 作为它的 stdio MCP server；通过 env `PINPIN_CHAT_ID` + `PINPIN_SUPERVISOR_PORT` 回连 Supervisor 的 IPC。
- 好处：每个频道独立的上下文、独立的人格注入、互不串扰；某个频道崩了不影响其它频道。
- **约束**：只 spawn 交互式 `claude`，不用 `-p` / `--print`——品品依赖持续的交互式会话（人格注入、上下文累积、原生 `/compact`），一次性 print 模式承载不了。

## 3. Supervisor 多进程编排

`supervisor/index.ts` 是 Electron main 进程内嵌的核心控制器：

- **消息单点入口**：FeishuPoll（群 bot 消息）+ FeishuEventSubscriber（wss 推 user 消息，含 P2P 单聊）双轨并存——这是飞书生态的平台约束（`chat.list` 不返单聊、事件订阅不推 bot 消息），双源用 `message_id` 去重。
- **分发**：`onFeishuMessage` 按 `chat_id` 找到/创建对应 `ChannelCli`，把消息推进去。
- **生命周期**：start / stop / restart / compact，频道配置（model / effort）持久化到 `userData/channel-config.json`。
- **崩溃熔断**（`crashState`）：同一频道 5 分钟内崩溃达阈值 → 停止自动重试，等人工恢复，防无限重启风暴。
- **forget 守卫**：用户主动删除的频道不再自动 spawn。

## 4. IPC 协议

`src/ipc/protocol.ts` 定义 Supervisor ↔ 频道子进程的消息格式（如 `client-hello` / `work.send` / `work.end` / inbound 推送 / work 状态回报 / 账号用量额度等）。传输是本机 TCP。

## 5. 鉴权

- **lark-cli 身份隔离**（`launcher/main/main.ts` + `supervisor/channel-cli.ts`）：云文档 / 任务 / 日历 / 邮件等飞书业务能力走官方 lark-cli（内嵌的 AI skills 由 `scripts/lark-skills-sync.cjs` 同步到本机 Claude Code 的 skills 目录）。品品全家（Supervisor / 频道 CLI / MCP 子进程 / 工人 CLI）通过 `LARKSUITE_CLI_CONFIG_DIR` 指向一个品品专用配置目录——同一飞书应用、strict-mode 机器人身份、永不持有 OWNER 的用户 token；只有 OWNER 私聊频道去掉该 env，回落到 OWNER 本人的 `~/.lark-cli`（用户身份）。`scripts/lark-guard.cjs` 是注册在全局的 PreToolUse 守门 hook：全机禁止 `lark-cli event`（同一应用的长连接是集群模式，再起一个会抢走 Supervisor 的消息）；品品进程（env `PINPIN_LARK_GUARD=1`）再禁切 profile / 覆盖 `LARKSUITE_CLI_*` / 改配置 / 登录登出 / 自升级。
- **OWNER 硬鉴权**（`src/mcp/owner-auth.ts`）：危险工具（重启 / 下线 / 跨频道发言等）校验"本频道最近 inbound 发送者是否为 OWNER"，fail-closed（识别不到就拒绝，引导去单聊触发）。

## 6. 后台任务（cron）与"传话筒"

- **Supervisor 级 cron**（`supervisor/cron-runner.ts`）：心境衰减、OWNER 用户身份保活（每天以 OWNER 本人的 lark-cli 配置跑一次用户接口触发续期；失效则品品自己发起设备码授权、把链接私聊给 OWNER 点一下、后台轮询到完成）——由主进程单点跑，避免 N 个频道争抢写锁。
- **频道级 cron**（`src/mcp/cron/`）：日记（每日 00:00）、早报 / 新闻 / 周回顾 / 记忆自检、自由活动——按 `chat_id` 归属分发到对应频道（`cron-owner.ts` 判定，避免重复触发）。
- **临时 job**（`scheduled-jobs-tick.ts`）：轮询 DB 的 scheduled_job 表，到期 fire（提醒 timer / 等某人开口 / 传话转达）。
- **传话筒 work session**（`supervisor/work-session.ts`）：品品可以 spawn 一个独立的后台 claude code 进程去某目录干活，监听它的 transcript（jsonl）判断"停下等指示"，完工后通过 IPC 把结果回报到原频道，由品品转告用户。

## 7. Electron 启动器

`launcher/` 是个 vanilla JS + IPC 的桌面控制台：实时显示各频道状态、统一日志流、每个频道的终端（xterm 渲染 PTY raw 输出）、用量额度展示、启动前配模型 / effort、手动启停 / 重启 / 删除频道。

## 8. 持久化

**SQLite（`better-sqlite3`，仅频道子进程持有）** —— 7 张表：`scheduled_tasks`（周期任务 catch-up）/ `scheduled_jobs`（一次性 timer + speak_watch + relay 传话，按 type 区分）/ `known_users`（认人：open_id↔显示名，单一权威源）/ `app_meta`（bot 持久 kv / 去重）/ `diy_polls` + `diy_poll_votes`（投票卡）/ `pinpin_created_groups`（建群 / 解散群追踪）。入口消息去重已改为纯内存 Set，不再落表。

**为什么 DB 只由频道子进程持有、Supervisor 不碰 DB**：Supervisor 跑在 Electron 内置 node（原生模块 ABI 与系统 node 不同），让 `better-sqlite3` 只被系统 node 的频道子进程持有，从架构上消除双 ABI 冲突；Supervisor 需要的 DB 操作（如投票计票）经 IPC 路由到对应 chat 子进程执行。唯一需为 Electron ABI 重编的原生模块是 `node-pty`（postinstall 跑 `electron-rebuild --only node-pty`）。

**心境 / 记忆 / 日记 / 对话记录等"内容"不在 DB**，以 Markdown 落在 vault（不在本仓，骨架见 [DESIGN-personality.md](DESIGN-personality.md)）。

---

## 关键依赖

| 依赖 | 用途 |
|---|---|
| `@larksuiteoapi/node-sdk` | 飞书开放平台 SDK（消息 / 事件订阅 / 建群 / 联系人） |
| `lark-cli`（官方飞书 CLI，本机安装、非 npm 依赖） | 云文档 / 任务 / 日历 / 邮件等飞书业务能力 + 内嵌 AI skills（品品以机器人身份、OWNER 私聊以用户身份调用） |
| `@modelcontextprotocol/sdk` | MCP 通信框架 |
| `better-sqlite3` | 同步 SQLite |
| `node-pty` | 伪终端，spawn 交互式 CLI 子进程 |
| `electron` / `electron-vite` | 启动器宿主 |
| `@elevenlabs/elevenlabs-js` | 语音 TTS / STT |
| `sharp` / `music-metadata` | 图像缩略 / 音频元数据 |
