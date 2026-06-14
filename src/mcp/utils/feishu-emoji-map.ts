/** 飞书表情 emoji_type —— 权威全集 + 大小写解析 + (兜底) unicode 映射
 *
 * 整体搬自 早期版本 src/utils/feishu-emoji-map.ts（讨喜机制 v8.0 步骤 17 根治版）。
 * 改了的：console.warn → process.stderr.write（避免污染 MCP stdio JSON-RPC）。
 *
 * 三块：
 *  1) FEISHU_EMOJI_TYPES —— 权威 171 个 emoji_type 全集（精确大小写）
 *     双源交叉验证：go-lark/lark + illacloud/larksdk emoji.go 逐行字字一致
 *  2) resolveEmojiType(input) —— 大小写不敏感解析 + 去标点
 *  3) EMOJI_MAP / mapEmojiToFeishu —— unicode emoji 兜底
 *
 * 命名混合规范（大小写敏感）：多数 ALL_UPPERCASE，少数 PascalCase
 *   （Fire/EatingFood/ThumbsDown/BubbleTea/XmasTree/CheckMark 等）
 */
const EMOJI_MAP: Record<string, string> = {
  // ── 原 12 个：早期实测 server.ts 实证有效 ──
  "🌸": "ROSE",
  "😄": "SMILE",
  "❤️": "HEART",
  "❤": "HEART",
  "🔥": "FIRE",
  "👌": "OK",
  "👍": "THUMBSUP",
  "👏": "CLAP",
  "😢": "CRY",
  "🤦": "FACEPALM",
  "😂": "LOL",
  "🤗": "HUG",

  // 肯定 / 鼓励
  "🙏": "THANKS",
  "💪": "MUSCLE",
  "🫰": "FINGERHEART",
  "👊": "FISTBUMP",
  "✅": "DONE",
  "✊": "STRIVE",
  "🤝": "SHAKE",
  "🫡": "SALUTE",
  "🙌": "HIGHFIVE",
  "👎": "ThumbsDown",

  // 笑 / 开心
  "😊": "BLUSH",
  "😆": "LAUGH",
  "😏": "SMIRK",
  "😍": "LOVE",
  "🥰": "LOVE",
  "😉": "WINK",
  "😜": "WITTY",
  "🤓": "SMART",
  "😇": "INNOCENTSMILE",
  "😮": "WOW",
  "😈": "TRICK",
  "✌️": "YEAH",
  "😝": "TEASE",
  "😎": "SHOWOFF",
  "🙂": "SLIGHT",
  "😛": "TONGUE",
  "😌": "EYESCLOSED",
  "🤭": "CHUCKLE",
  "🤪": "CRAZY",

  // 否定 / 不满
  "😣": "SCOWL",
  "❌": "ERROR",
  "😤": "PROUD",
  "🙅": "ENOUGH",
  "👀": "GLANCE",
  "😑": "DULL",
  "❓": "WHAT",
  "☹️": "FROWN",
  "😒": "LOOKDOWN",
  "🤐": "SILENT",
  "🤫": "SHHH",
  "😶": "SPEECHLESS",
  "😠": "ANGRY",
  "😡": "ANGRY",
  "🔨": "HAMMER",

  // 悲伤 / 哭
  "🤔": "THINKING",
  "😭": "SOB",
  "🥹": "TEARS",
  "😅": "EMBARRASSED",
  "😔": "WHIMPER",
  "🥺": "WRONGED",
  "😫": "WAIL",
  "😩": "BLUBBER",

  // 惊恐 / 不适
  "😱": "SHOCKED",
  "😨": "TERROR",
  "😰": "PETRIFIED",
  "💀": "SKULL",
  "😓": "SWEAT",
  "😴": "SLEEP",
  "😪": "DROWSY",
  "🥱": "YAWN",
  "🤒": "SICK",
  "🤮": "PUKE",
  "💔": "HEARTBROKEN",

  // 亲昵 / 其他表情
  "😘": "KISS",
  "💋": "SMOOCH",
  "🤤": "DROOL",
  "🤑": "MONEY",
  "👋": "WAVE",
  "😳": "SHY",
  "😵": "DIZZY",
  "🐮": "CALF",
  "🐻": "BEAR",
  "🐂": "BULL",

  // 物品 / 食物
  "🌹": "ROSE",
  "🎉": "PARTY",
  "🎊": "PARTY",
  "👄": "LIPS",
  "🍺": "BEER",
  "🎂": "CAKE",
  "🎁": "GIFT",
  "🥒": "CUCUMBER",
  "🍗": "Drumstick",
  "🌶️": "Pepper",
  "🧋": "BubbleTea",
  "☕": "Coffee",
  "🍋": "Lemon",
  "😋": "EatingFood",
  "🎧": "HEADSET",
  "💩": "POOP",
  "🔪": "CLEAVER",
  "⚽": "Soccer",
  "🏀": "Basketball",

  // 工作 / 状态符号
  "💯": "Hundred",
  "✔️": "CheckMark",
  "📌": "Pin",
  "⏰": "Alarm",
  "📢": "Loudspeaker",
  "🏆": "Trophy",
  "💣": "BOMB",
  "🎵": "Music",
  "😮‍💨": "Sigh",

  // 节日 / 季节
  "🎄": "XmasTree",
  "⛄": "Snowman",
  "🎆": "FIREWORKS",
  "🧧": "REDPACKET",
  "🍀": "LUCK",
  "🧨": "FIRECRACKER",
  "🔞": "18X",
};

export function mapEmojiToFeishu(unicode: string): string | null {
  return EMOJI_MAP[unicode] ?? null;
}

// emoji_type → unicode 反查（展示用：把飞书事件里的 "OK"/"THUMBSUP" 还原成 👌/👍）。
// 反向索引一次性构建自 EMOJI_MAP（单源，不另维护表）；同一 type 多 unicode 取首个。
// EMOJI_MAP 未覆盖的 type（171 全集里大部分冷门表情）返 null，调用方原样显示 type 字符串。
const TYPE_TO_UNICODE: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [uni, type] of Object.entries(EMOJI_MAP)) {
    if (!(type in out)) out[type] = uni;
  }
  return out;
})();
export function feishuEmojiTypeToUnicode(emojiType: string): string | null {
  return TYPE_TO_UNICODE[emojiType] ?? null;
}

// ──────────────────────────────────────────
// 权威 emoji_type 全集（171，精确大小写）
// 来源：go-lark/lark + illacloud/larksdk emoji.go 双源逐字一致
// ──────────────────────────────────────────
const FEISHU_EMOJI_TYPES: ReadonlySet<string> = new Set<string>([
  "OK", "THUMBSUP", "THANKS", "MUSCLE", "FINGERHEART", "APPLAUSE", "FISTBUMP",
  "JIAYI", "DONE", "SMILE", "BLUSH", "LAUGH", "SMIRK", "LOL", "FACEPALM", "LOVE",
  "WINK", "PROUD", "WITTY", "SMART", "SCOWL", "THINKING", "SOB", "CRY", "ERROR",
  "NOSEPICK", "HAUGHTY", "SLAP", "SPITBLOOD", "TOASTED", "GLANCE", "DULL",
  "INNOCENTSMILE", "JOYFUL", "WOW", "TRICK", "YEAH", "ENOUGH", "TEARS",
  "EMBARRASSED", "KISS", "SMOOCH", "DROOL", "OBSESSED", "MONEY", "TEASE",
  "SHOWOFF", "COMFORT", "CLAP", "PRAISE", "STRIVE", "XBLUSH", "SILENT", "WAVE",
  "WHAT", "FROWN", "SHY", "DIZZY", "LOOKDOWN", "CHUCKLE", "WAIL", "CRAZY",
  "WHIMPER", "HUG", "BLUBBER", "WRONGED", "HUSKY", "SHHH", "SMUG", "ANGRY",
  "HAMMER", "SHOCKED", "TERROR", "PETRIFIED", "SKULL", "SWEAT", "SPEECHLESS",
  "SLEEP", "DROWSY", "YAWN", "SICK", "PUKE", "BETRAYED", "HEADSET", "EatingFood",
  "MeMeMe", "Sigh", "Typing", "Lemon", "Get", "LGTM", "OnIt", "OneSecond",
  "VRHeadset", "YouAreTheBest", "SALUTE", "SHAKE", "HIGHFIVE", "UPPERLEFT",
  "ThumbsDown", "SLIGHT", "TONGUE", "EYESCLOSED", "RoarForYou", "CALF", "BEAR",
  "BULL", "RAINBOWPUKE", "ROSE", "HEART", "PARTY", "LIPS", "BEER", "CAKE",
  "GIFT", "CUCUMBER", "Drumstick", "Pepper", "CANDIEDHAWS", "BubbleTea",
  "Coffee", "Yes", "No", "OKR", "CheckMark", "CrossMark", "MinusOne", "Hundred",
  "AWESOMEN", "Pin", "Alarm", "Loudspeaker", "Trophy", "Fire", "BOMB", "Music",
  "XmasTree", "Snowman", "XmasHat", "FIREWORKS", "2022", "REDPACKET", "FORTUNE",
  "LUCK", "FIRECRACKER", "StickyRiceBalls", "HEARTBROKEN", "POOP",
  "StatusFlashOfInspiration", "18X", "CLEAVER", "Soccer", "Basketball",
  "GeneralDoNotDisturb", "Status_PrivateMessage", "GeneralInMeetingBusy",
  "StatusReading", "StatusInFlight", "GeneralBusinessTrip", "GeneralWorkFromHome",
  "StatusEnjoyLife", "GeneralTravellingCar", "StatusBus", "GeneralSun",
  "GeneralMoonRest", "PursueUltimate", "Patient", "Ambitious", "CustomerSuccess",
  "Responsible", "Reliable",
]);

const CANONICAL_BY_LOWER: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const name of FEISHU_EMOJI_TYPES) {
    const key = name.toLowerCase();
    if (m[key] && m[key] !== name) {
      process.stderr.write(`[feishu-emoji] emoji_type 大小写碰撞，保留先到: ${m[key]} (忽略 ${name})\n`);
      continue;
    }
    m[key] = name;
  }
  return m;
})();

// 语义别名表（lowercase cleaned → 规范名）——品品常猜错但语义明确的名字
const EMOJI_ALIAS: Record<string, string> = {
  "handshake": "SHAKE",  // 品品猜 HANDSHAKE，飞书实际名 SHAKE（握手 🤝）
};

/**
 * 品品输出的 emoji_type 名 → 规范名。大小写不敏感 + 容标点。
 * 不认识返回 null（react handler 据此走 unicode 兜底或短文本）。
 */
export function resolveEmojiType(input: string): string | null {
  const cleaned = input.replace(/[^A-Za-z0-9]/g, "");
  if (!cleaned) return null;
  if (FEISHU_EMOJI_TYPES.has(cleaned)) return cleaned;
  const lower = cleaned.toLowerCase();
  return CANONICAL_BY_LOWER[lower] ?? EMOJI_ALIAS[lower] ?? null;
}
