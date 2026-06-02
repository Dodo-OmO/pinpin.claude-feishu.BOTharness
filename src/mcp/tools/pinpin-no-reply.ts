// pinpin_no_reply tool handler——防串台三层之"不回留痕"
// 统一口径（Owner 2026-05-30 拍板）：每轮收到消息 → 二选一必调一个工具：
//   回 = pinpin_reply_text / pinpin_reply_voice / pinpin_react
//   不回 = pinpin_no_reply（本工具，空操作）
// 作用：给"故意不回"留一个可观测信号，让 channel-stop-gate Stop hook 能区分
//   "品品判断不回"（调了 no_reply = 放行）vs "串台漏发"（什么都没调 = 拦截补发）。
// 设计：零参数、空操作、不外发给飞书用户。品品的判断留在 CLI 内部（自言自语），
//   本工具只落一个"我看过、决定不回"的痕。

export const PINPIN_NO_REPLY_TOOL = {
  name: "pinpin_no_reply",
  description:
    "决定这轮不回飞书时调（空操作，不外发给用户）。给「我看过、决定不回」留个痕——是真不该回时用（纯噪声 / 别人正事 / 近5条全AI），不是偷懒挡箭牌。每轮收到消息：回就调 pinpin_reply_text/voice/react，不回就调本工具，二选一必调一个。",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export async function handlePinpinNoReply(): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  process.stderr.write(`[pinpin_no_reply] 本轮判定不回（已留痕）\n`);
  return {
    content: [{ type: "text", text: JSON.stringify({ no_reply: true }) }],
  };
}
