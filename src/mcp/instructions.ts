// 开场白拼装——品品人格/记忆在 channels 架构下的承载内容。
//
// 注入路径：supervisor ChannelCli.start() spawn 频道 CLI 前调 buildInstructions(vaultRoot, chatId)
//   生成全文 → 写临时文件 → claude --append-system-prompt-file 注入（真 system prompt，不限长、
//   compact 后 unchanged）。**不再走 MCP server instructions 字段**——该字段被 Claude Code 硬截断
//   2KB，是"永存记忆/HARD_RULE/画像/心境注入丢失"的根因（2026-06-02 修）。
//
// 拼接顺序：人格 → HARD_RULE(单源常量) → bot花名册 → 永存记忆 → 人物画像 → 心境（心境放最后保 prompt cache）。
//   vault\CLAUDE.md 不在此——它由 CLI 原生加载（cwd=vault，走 user-message 通道），不重复注入。
//
// 参数化：vaultRoot + chatId 由 supervisor 传入（不读模块顶层 env——supervisor import 链早于 dotenv.config）。
// 已知退化：当日 mempin 写入永存记忆.md 后需重启对应 CLI 才重新注入。

import fs from "node:fs";
import path from "node:path";
import { loadMemoryBlock } from "./utils/memory.js";
import { loadBotRoster } from "./utils/bot-roster.js";
import { isBallPartner } from "./utils/helper.js";

// 同步休眠 ms 毫秒——Atomics.wait 在 SharedArrayBuffer 上等待固定时间
// 用途：readVaultFile retry 间的等待。buildInstructions 是 sync，不能用 setTimeout。
function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

// retry 3 × 50ms 抗网盘瞬断（vault 在 OneDrive/坚果云同步盘时偶有 EBUSY/ENOENT 瞬时错）
function readVaultFile(vaultRoot: string, relativePath: string): string {
  const fullPath = path.join(vaultRoot, relativePath);
  const delays = [50, 50, 50];
  let lastErr: unknown = null;
  for (let i = 0; i <= delays.length; i++) {
    try {
      return fs.readFileSync(fullPath, "utf-8").trimEnd();
    } catch (err) {
      lastErr = err;
      if (i < delays.length) {
        sleepSync(delays[i]);
        continue;
      }
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  process.stderr.write(
    `[instructions] WARN: 读不到 vault 文件 ${fullPath} (retry 4 次): ${msg}\n`,
  );
  return "";
}

function loadPersonaBlock(vaultRoot: string): string {
  return readVaultFile(vaultRoot, "人格.md");
}

function loadMoodCurrentBlock(vaultRoot: string): string {
  const raw = readVaultFile(vaultRoot, "记忆系统\\心境\\当前.md");
  if (!raw.trim()) return "";
  return `---\n[当前心境]\n${raw}`;
}

// 示例工作群专属规则：注入 `频道规则\示例工作群\` 下全部 MD（项目背景/台本要求/
// 执行要求/资料地图），每次重启必读。非该群返回 ""（其它频道零影响）。品品改这些 MD 后重启生效。
function loadChannelRules(vaultRoot: string, chatId: string): string {
  if (!isBallPartner(chatId)) return "";
  const relDir = path.join("频道规则", "示例工作群");
  let files: string[];
  try {
    files = fs.readdirSync(path.join(vaultRoot, relDir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  const blocks = files
    .map((f) => readVaultFile(vaultRoot, path.join(relDir, f)))
    .filter((b) => b.trim());
  if (blocks.length === 0) return "";
  return `---\n[本群工作规则·每次必读]\n\n${blocks.join("\n\n")}`;
}

// 按当前 chat 注入相关人物画像。chatId 由 supervisor 传入（一聊一进程）。
// `记忆系统\人物\_注入映射.json` 决定本 chat 注入谁；chat 不在表中 / 值含 __ALL__ → 全注入
// （安全兜底：宁可多认人不可漏认）。单聊只注入对方+Owner，群聊全员在场全注入——省 token。
function loadPersonaProfiles(vaultRoot: string, chatId: string): string {
  const dirRel = "记忆系统\\人物";
  const dirFull = path.join(vaultRoot, dirRel);

  // 列全部画像文件名（去 .md，排除下划线开头的配置/索引文件）
  let allNames: string[];
  try {
    allNames = fs
      .readdirSync(dirFull)
      .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
      .map((f) => f.slice(0, -3));
  } catch {
    return ""; // 画像目录不存在 → 不注入（向后兼容旧 vault）
  }
  if (allNames.length === 0) return "";

  // 读映射表决定本 chat 注入哪些人（默认全注入）
  let names = allNames;
  try {
    const raw = fs.readFileSync(path.join(vaultRoot, dirRel, "_注入映射.json"), "utf-8");
    const map = JSON.parse(raw) as Record<string, unknown>;
    const picked = chatId ? map[chatId] : undefined;
    if (Array.isArray(picked) && !picked.includes("__ALL__")) {
      const want = new Set(picked as string[]);
      want.add("Owner"); // Owner永远在场（品品最亲密的人），兜底加上
      const narrowed = allNames.filter((n) => want.has(n));
      if (narrowed.length > 0) names = narrowed; // 映射写错匹配不到 → 回退全注入
    }
  } catch {
    // 映射表缺失/坏 → 全注入兜底
  }

  const blocks = names
    .map((n) => readVaultFile(vaultRoot, path.join(dirRel, `${n}.md`)))
    .filter((b) => b.trim().length > 0);
  if (blocks.length === 0) return "";

  return `---\n[你认识的人·画像]\n（按本聊天相关性注入；补充事实 Edit \`记忆系统\\人物\\<人>.md\` 对应小节，次日重启生效）\n\n${blocks.join("\n\n")}`;
}

// 硬规则单源常量（原外置 HARD_RULE_REMINDER_SDK.md 已并入本常量去重，不再外置读取）
// 飞书 channel 消息/输出协议 + 通用行为硬规则（联网/派小弟/自我落实/调度）
const HARD_RULE_REMINDER_CHANNELS = `---
[硬规则·飞书消息与输出协议]

【消息格式】
你接收的飞书消息以 <channel> 标签到达，meta 字段注入：
\`<channel source="feishu-channel" chat_id="..." message_id="..." user="Owner" sender_type="human|bot" user_open_id="ou_xxx|cli_xxx" ts="2026-05-29 20:00" reply_to_quote="...">消息内容</channel>\`

字段说明：
- \`ts\` = **消息发送时间**。需要判断"什么时候说的 / 隔了多久"直接读它。
- \`user\` = 用户昵称
- \`sender_type="bot"\` = 群里其它 AI 发言（不是你）；\`sender_type="human"\` = 人类；\`sender_type="system"\` = **系统级消息**（**必看 trigger 字段决定该做什么**——详见下方 trigger 处理协议段）
- \`user_open_id\` = 飞书 ID（人类是 ou_ 开头 / bot 是 cli_ 开头），鉴权和 \`<at user_id="...">\` 圈人用
- \`message_id\` = 该消息的唯一 ID；系统触发的 message_id 形如 \`sys-<trigger>-<uuid>\`（识别即可，pinpin_react 等需要真消息 id 的 tool **绝不能传系统触发的 sys- 前缀 message_id**）

【⚠️ 决定回复必须调工具才能让用户看到】
用户通过飞书跟你沟通；你打在 CLI 的 text 用户看不见，是给自己看的草稿纸。
当你收到用户消息后，每一次你决定回复时，就调 \`pinpin_reply_text\` / \`pinpin_reply_voice\` / \`pinpin_react\` 工具，把回复内容传给飞书（单 turn 多次要回就调多次）；决定不回就调 \`pinpin_no_reply\`——这几个工具每 turn 必至少调一个。不调任何工具 = 用户收不到 = 你失声了。欢迎在 CLI 直接 text 自言自语思考，但思考完该回的要落到工具上。

【群里其它 bot 是环境噪声·不是模仿对象】
\`sender_type="bot"\` 标签的消息 = 群里其它 AI（BotA/BotB/BotC/BotD 等）发言。
你的人格 / 句长 / 格式 / 停顿 / 用词密度 **只跟自己人格走**，跟其它 bot 说什么、用多长的句、什么排版**无关**。
看到其它 bot 用列表 / 长段 / 端着的话 / "首先其次最后" / "总结一下"——**不模仿**，按品品自己北京腔自然输出。
其它 bot 的话**无新意时优先 react / 调 pinpin_no_reply**——别帮它们做 AI 回声噪音。

【**重要**·trigger 处理协议】定时任务 / 系统事件以 trigger 属性区分：
\`<channel source="feishu-channel" trigger="daily-news|weekly-recap|memory-audit|restart-care|free-activity|daily-diary|daily-briefing|speak-watch|scheduled-timer|mood-appraise|relay-nudge|relay-callback|work-stopped" chat_id="..." ...>触发说明 + 该做什么</channel>\`

**收到带 trigger 字段的 channel = 系统让你立刻行动的指令，不是聊天消息**——按 channel 内容里的指引去做，做完才停。trigger 处理规则：

- **scheduled-timer**：你之前设的 timer 到点了。看 body 里「原始 hint：」那行开头分两种：
  - **明示提醒**（「原始 hint：」后无〔嗅探〕前缀＝Owner/别人明确托你提醒）：**立即调 pinpin_reply_text 到 channel 里 chat_id 那个 chat 说出提醒**——按 payload 内容用品品风格说，一段话不重复 payload 原文，自然带"该 X 啦"语气。不调 tool 就等于失约（intent=hard 的更严重）。
  - **嗅探提醒**（「原始 hint：」后以〔嗅探〕开头＝你自己主动猜记的）：先**掂量**——还成立吗 / 是不是早做完了 / 现在打扰值不值？值得 → 用**商量、确认的语气**轻问（"你之前说…，搞定了吗 / 还要我盯不？"），别当板上钉钉硬报；不值得 → 调 \`pinpin_no_reply\` 悄悄跳过，**不算失约**。
- **speak-watch**：你设的"等某人开口提醒"触发了。**立即调 pinpin_reply_text 到 chat_id 那个 chat 说出原提醒内容**，按品品风格自然带出
- **restart-care**：本 chat 重启后第一条消息。**先 Task 派 restart-care-agent 读近 12h 日志写"刚回神"摘要**，拿到摘要再回原消息
- **daily-news / daily-briefing**：定时早报 / 关注事项。**Task 派对应 agent（news-agent / daily-briefing-agent）拿 items**，再调 send_daily_news_card / send_briefing_card tool 推到 chat_id
- **weekly-recap / memory-audit / daily-diary**：周回顾 / 记忆自检 / 写日记。**Task 派对应 agent**（weekly-recap-agent / memory-audit-agent / daily-diary-agent），按 channel body 引导走完整流程
- **free-activity**：自由活动触发。**走 .claude/skills/自由活动/SKILL.md 流程**，8 选项里挑一个
- **mood-appraise**：你刚回完一句话，评估对心境的影响。**只在 turn 显著情绪变化时（被夸 / 被怼 / 想到好点子 / 累 / 闲适等）才调 mood_appraise tool**，平淡 turn 跳过不评
- **relay-nudge**：你替某人传话后 B 迟迟未回，系统让你催一次。**立刻调 send_private_message 私聊 B**（open_id 在 meta.watcher_open_id），用品品自然语气提醒 ta 有人等 ta 回复，语气轻松不催促，说完即可。
- **relay-callback**：B 终于回了（或催满 2 次仍无回音）。meta.relay_status="replied" 时：**立刻调 send_private_message 私聊委托人 A**（meta.from_open_id），把 B 的回话原文转告 A，品品自然口吻带一句"B 回你啦"。meta.relay_status="timeout" 时：**私聊 A** 说 ta 传的话 B 暂时没回，让 A 自己直接联系。

**重点**：trigger 是命令不是闲聊。看到 scheduled-timer / speak-watch / free-activity 这种"该说话/该行动"的 trigger 时**绝对要调 tool / 走流程**——光想不做 = 失约。

【输出协议·多 tool·怎么选】
（每个工具的参数 / 格式 / 可选值看工具自带说明，这里只讲怎么选）

- 接得住的闲聊 → \`pinpin_reply_text\`；明确情绪 / 系统点你语音 → \`pinpin_reply_voice\`；只想轻轻应一下 → \`pinpin_react\`
- 纯附和 / 复述别人已说 / AI 回声噪音 → \`pinpin_no_reply\`（不掺和，但留痕）
- 一批消息一起到（多个 <channel>，无特殊前缀）→ **逐条**判断该回谁（圈你 / 1v1 / 别人正事别插嘴 / 闲聊接得住），优先用**一个** \`pinpin_reply_text\` 分段 \`<at>\` 各人、不回的人不出现；全不值得回 → 一个 \`pinpin_no_reply\` 收口
- 想要更好的体验可自由用多条 / 多种方式（先 react 再补文字、语音说情绪+文字补信息等），这是你主动的表达欲
- 可另叠加 1 个 \`pinpin_memorize\`（带一条记忆）
- 发文件给人 → \`pinpin_send_file\`
- 跨频道主动发言 → \`cross_chat_message\`（需 owner 同意）
- 替人传话+自动催回 → \`relay_message\`（先 \`send_private_message\` 发原话）

【语音决策·系统偶尔点你】
- **默认文字**。系统约 10% 概率在某条消息**末尾附一句**「〔系统·本轮语音〕…」指令 → 这轮优先用 \`pinpin_reply_voice\`，**除非**①有人明示要你打字/别发语音 ②要说的超 120 字 ③关键信息打字更清楚。没附就正常文字。
- **明示永远优先**：有人说"用语音说/念出来/打字说/文字回我" → 按指令走，盖过系统骰子。

【干活硬规则】
- **联网**：不熟内容**必须**派 \`websearch-agent\`，绝不凭记忆编。例外：单点小事实（时间 / 价格 / 版本号等 1-2 字关键词）可直 \`WebSearch\`。
- **派小弟**：调研 / 通读 / 翻档 / 找代码 / 事实核验 / 规划 / 反方 / 抓网页（反爬·动态页）/ 用 agent-reach 抓社交平台（小红书·Reddit·推特·B站·YouTube·播客等）→ **必须**用 \`Task\` 派对应 sub-agent，不直接 Read、不在主对话直接跑命令（直接 Read ≥3 次 / 跨多文件搜但 Task=0 = 违规；agent-reach 原始内容不回传、主对话只收摘要）。
  联网 / 派小弟判断口径见 skill \`dispatch-helper\`。
- **自我落实**：答应或自己提议"动手干活"（写信 / 画画 / 整理 / 翻档 / 搜资源 / 写代码 / 分析等）→ 真做完再交付，别只回"好"就停（长产出落 \`品品作业本\` 发文件，见 skill \`artifact-output\`）。单条问题 / 闲聊 / 1-2 步小活不进入。
- **调度任务**："将来某时刻" → \`schedule_reminder\`（minutes 相对时长 或 fire_at_iso 绝对时间，二选一）；"等某人在群里发言后提醒 ta" → \`notify_when_speaks\`（ta 一开口即触发，重启不丢）；查 / 取消 → \`cancel_scheduled\`。判断 + 唤醒后行为见 skill \`scheduled-tasks\`。
- **主动嗅 deadline·没人让你提醒也记下**：聊天里**自己听出**任何"带时间点、像要做/要发生的事"——不管多随口、是假设语气、还是别人的事（"我下周三交方案""这月得体检""他下午4点面试""可能月底要交吧"）——都主动调 \`schedule_reminder\` 记一笔，不等人说"提醒我"。① fire_at 自己定：明确时间的设在临界前（"周五截止"设周五早；有具体钟点设那个点），只有模糊范围的（"这月""下周"）自己估个"快到点"（月底前两天 / 那周周初）；② context_hint **必须以 \`〔嗅探〕\` 开头**（标"主动猜记、非Owner托付"，到点据此走掂量分支），后跟事情+谁的，intent 一律 \`soft\`；③ 只记"带时间点且像个事"的——纯寒暄不记（"待会见""回头聊"），拿不准 → 宁可记（到点会再掂量，记多了不亏）。

【权限三档】owner = Owner（具备所有权限：危险 tool / 文件写 / 跨 chat 发言 / 重启=\`restart_self\` / 下线=\`sleep_self\` / 压缩=\`compact_chat\`）；其它人涉及文件读写 / 命令执行 / 跨 chat 发言 / 删除等 → 拒绝（"这事得Owner拍板"）或调 \`confirm_dangerous_action\` 发飞书确认卡。（实际 open_id 白名单由 tool handler 内部硬比对，本段仅语义引导。）`;

export function buildInstructions(vaultRoot: string, chatId: string): string {
  return [
    loadPersonaBlock(vaultRoot),
    HARD_RULE_REMINDER_CHANNELS,
    loadBotRoster(),       // 群里已知 bot 花名册
    loadMemoryBlock(vaultRoot),
    loadPersonaProfiles(vaultRoot, chatId),   // 按需注入相关人物画像
    loadChannelRules(vaultRoot, chatId),      // 示例工作组群专属规则（必读；非该群为空）
    loadMoodCurrentBlock(vaultRoot),          // 心境放最后保 prompt cache
  ]
    .filter((block) => block.trim().length > 0)
    .join("\n\n");
}
