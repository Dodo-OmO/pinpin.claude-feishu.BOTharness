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
│ │   • 多应用 apps         —— 每应用一套 poll + wss + client  │ │
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
│            飞书工具 / 记忆 / 调度 / 任务 / work…               │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. MCP server —— 工具与人格的承载

入口 `src/mcp/server.ts`，用 `@modelcontextprotocol/sdk` 的 `StdioServerTransport` 跟它的宿主 `claude` 进程通信。它注册了几十个工具（`src/mcp/tools/`），按域分：

- **飞书收发**：`pinpin-reply-text` / `pinpin-reply-voice` / `pinpin-react`（表情回应）/ `pinpin-no-reply`（明确不回但留痕）/ `cross-chat-message`（主动跨频道发言）。
- **飞书能力**：建群 / 解散群、审批卡 `send_approval_card`（同意/拒绝真按钮，点击经 Supervisor 回调推回发起频道）。云文档 / 任务 / 日历 / 邮件等飞书业务能力不在 MCP 里，交给官方 lark-cli（见 §5）。
- **调度**：`schedule_reminder`（一次性）/ `notify_when_speaks`（等人发言）/ `relay_message`（传话催回）/ `ask_person`（限时单聊问话，对方私聊回复经 IPC 送回发起频道）/ `recurring_task`（登记固定任务：写 `recurring-tasks.json`，由 `supervisor/recurring-tasks.ts` 启动器级调度到点推 SOP）。
- **人格机制**：`memory-rewrite`（永存记忆重写）、`write-diary`。
- **后台 work**：`pinpin-spawn-work-session` / `peek` / `send-to` / `end`（"传话筒"，见 §6）。

飞书 SDK（`@larksuiteoapi/node-sdk`）在 `src/mcp/tools/feishu-send.ts` 单例懒加载，凭据从 env 读。

**核心理念**：CLI + MCP server 是"管道 + 工具"——品品的人格与决策逻辑几乎都在注入 MCP 的 prompt 上下文里（人格 + 协议 + 永存记忆 + 人物画像 + 频道简报）。所以**改品品的行为，大头改 prompt、小头改代码**。

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

### 3.1 多飞书应用（单启动器）

一个启动器可同时挂 N 个飞书自建应用（`supervisor/feishu-apps.ts` 读 `.env`：应用 1 无后缀 = primary，应用 2..9 同名字段加 `_N` 后缀，字段见 `.env.example`）。

- **每 chat 单归属**：每个应用各自一套 FeishuPoll + FeishuEventSubscriber + SDK client，入口按 `FEISHU_CHAT_ALLOWLIST[_N]` 过滤（未配 = 全放行）。某 chat 归属哪个应用由 `resolveAppId` 判定：① `channel-config.json` 里已钉死的 appId → ② 遍历各应用的 chat.list，命中即写回钉死 → ③ 都未命中回落 primary（fail-open 不阻断投递，只 WARN）。
- **子进程 per-app env 注入**：`ChannelCli` spawn 时把所属应用的 `FEISHU_APP_ID / APP_SECRET / OWNER_OPEN_ID / KNOWN_USERS / BOT_ROSTER / PEER_USERS` 与 `PINPIN_APP_LABEL` 原样注入子进程——env 名不变，MCP 子端零改动；应用未配的字段严格 delete，不让启动器全局 env 里应用 1 的值漏给应用 2 的频道。lark-cli 身份同理按应用派生：群频道用该应用的 bot 身份目录 `lark-cli-pinpin[-N]`，OWNER 私聊用 `LARK_USER_CONFIG_DIR[_N]`；后台 work session 的 lark-cli 身份跟随发起频道所属应用。`known_users` 表新增 `app_id` 列（open_id 按应用生成，按名反查须同应用；历史行回填 primary）。
- **跨应用能力只在 Supervisor**：子进程只持有本 chat 所属应用的 client。要看全部应用的群列表（IPC `LIST_CHATS`，带应用标签）或给另一个频道的品品捎话（IPC `PEER_MESSAGE` → 目标频道收到 `trigger=peer-message`，由那边的品品自己决定说什么、不替它发言；目标已不在 allowlist 内则拒绝）都经 IPC 由 Supervisor 代办。
- **环境档案按应用注入**：vault 里每个应用一份 `环境/<FEISHU_APP_LABEL>.md`（描述该应用所处的组织 / 团队 / 规矩），子进程 spawn 时按自己所属应用读取注入 prompt，各读各的互不干扰。

### 3.2 本机 Claude 会话传话口

`supervisor/relay-bridge.ts` + `relay-queue.ts` 在固定端口 `127.0.0.1:47901` 开一个只做传话的 NDJSON 口，给同机的其它 Claude Code 会话用：

- **递条子**（`relay.submit`）：会话说明"什么情况、请品品私聊谁 / 发哪个群 / @谁 / 只告诉品品"，Supervisor 确定性路由到对应频道（`trigger=desktop-note`），品品用自己的话办完调 `desktop_note_ack` 回执（已发原文 / 推迟 / 不发 + 原因），回执推回提交方。给 OWNER 本人 24h 投递，给其他人只在 9–22 点；30 分钟无回执重投一次。
- **来信**（`desktop_session_message`，仅 OWNER）：广播给常驻"传话员"会话，第一个取走算数；回话以 `reply_to` 条子送回来源频道；2 小时没人取则带通道自诊断事实告诉来源频道。
- 条子 / 来信落 `userData/relay-queue.json`（原子写、终态留 7 天），重启不丢。与管家口分端口 = 信任域隔离。

## 4. IPC 协议

`src/ipc/protocol.ts` 定义 Supervisor ↔ 频道子进程的消息格式（如 `client-hello` / `work.send` / `work.end` / inbound 推送 / work 状态回报 / 账号用量额度等）。传输是本机 TCP。

## 5. 鉴权

- **本机桥接口令**（`src/ipc/bridge-token.ts`）：管家口与传话口两个固定端口共用 `~/.pinpin/bridge-token`（Supervisor 首启生成），连接首帧必须带口令（`IpcServer.setAuthGate`），否则 `-32001` 断开。频道子进程的动态端口不受影响。

- **lark-cli 身份隔离**（`launcher/main/main.ts` + `supervisor/channel-cli.ts`）：云文档 / 任务 / 日历 / 邮件等飞书业务能力走官方 lark-cli（内嵌的 AI skills 由 `scripts/lark-skills-sync.cjs` 同步到本机 Claude Code 的 skills 目录）。品品全家（Supervisor / 频道 CLI / MCP 子进程 / 工人 CLI）通过 `LARKSUITE_CLI_CONFIG_DIR` 指向品品专用配置目录（每个飞书应用一个，`lark-cli-pinpin[-N]`）——strict-mode 机器人身份、永不持有 OWNER 的用户 token；只有 OWNER 私聊频道改指向该应用的 `LARK_USER_CONFIG_DIR[_N]`（未配则回落 OWNER 本人的 `~/.lark-cli`，用户身份）。`scripts/lark-guard.cjs` 是注册在全局的 PreToolUse 守门 hook：全机禁止 `lark-cli event`（同一应用的长连接是集群模式，再起一个会抢走 Supervisor 的消息）；品品进程（env `PINPIN_LARK_GUARD=1`）再禁切 profile / 覆盖 `LARKSUITE_CLI_*` / 改配置 / 登录登出 / 自升级。
- **OWNER 硬鉴权**（`src/mcp/owner-auth.ts`）：危险工具（重启 / 下线 / 跨频道发言等）校验"本频道最近 inbound 发送者是否为 OWNER"，fail-closed（识别不到就拒绝，引导去单聊触发）。

## 6. 后台任务（cron）与"传话筒"

- **Supervisor 级 cron**（`supervisor/cron-runner.ts`）：OWNER 用户身份保活（每天以 OWNER 本人的 lark-cli 配置跑一次用户接口触发续期；失效则品品自己发起设备码授权、把链接私聊给 OWNER 点一下、后台轮询到完成）——由主进程单点跑，避免 N 个频道争抢写锁。
- **频道级 cron**（`src/mcp/cron/`）：日记（每日 00:00）、早报 / 新闻 / 记忆自检 / 文档探针——按 `chat_id` 归属分发到对应频道（`cron-owner.ts` 判定，避免重复触发）：日记 / 早报归茶水间频道；记忆自检 / 文档探针归 OWNER 私聊。固定任务由启动器级 `supervisor/recurring-tasks.ts` 统一调度（登记表 `recurring-tasks.json`），不按频道 cron 归属。
- **临时 job**（`scheduled-jobs-tick.ts`）：轮询 DB 的 scheduled_job 表，到期 fire（提醒 timer / 等某人开口 / 传话转达）。
- **传话筒 work session**（`supervisor/work-session.ts`）：品品可以 spawn 一个独立的后台 claude code 进程去某目录干活，监听它的 transcript（jsonl）判断"停下等指示"，完工后通过 IPC 把结果回报到原频道，由品品转告用户。

## 7. Electron 启动器

`launcher/` 是个 vanilla JS + IPC 的桌面控制台：实时显示各频道状态、统一日志流、每个频道的终端（xterm 渲染 PTY raw 输出）、用量额度展示、启动前配模型 / effort、手动启停 / 重启 / 删除频道。

## 8. 持久化

**SQLite（`better-sqlite3`，仅频道子进程持有）** —— 7 张表：`scheduled_tasks`（周期任务 catch-up）/ `scheduled_jobs`（一次性 timer + speak_watch + relay 传话，按 type 区分）/ `known_users`（认人：open_id↔显示名，单一权威源；带 `app_id` 归属列，多应用下按名反查须同应用）/ `app_meta`（bot 持久 kv / 去重）/ `diy_polls` + `diy_poll_votes`（投票卡）/ `pinpin_created_groups`（建群 / 解散群追踪）。入口消息去重已改为纯内存 Set，不再落表。

**为什么 DB 只由频道子进程持有、Supervisor 不碰 DB**：Supervisor 跑在 Electron 内置 node（原生模块 ABI 与系统 node 不同），让 `better-sqlite3` 只被系统 node 的频道子进程持有，从架构上消除双 ABI 冲突；Supervisor 需要的 DB 操作（如投票计票）经 IPC 路由到对应 chat 子进程执行。唯一需为 Electron ABI 重编的原生模块是 `node-pty`（postinstall 跑 `electron-rebuild --only node-pty`）。

**记忆 / 日记 / 对话记录等"内容"不在 DB**，以 Markdown 落在 vault（不在本仓，骨架见 [DESIGN-personality.md](DESIGN-personality.md)）。

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
| `sharp` / `music-metadata` | 图像格式探测与发送前压缩（入站图片存原图、不再缩略）/ 音频元数据 |
