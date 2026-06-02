/**
 * 品品 DIY 纯展示卡片构造器（channel 版搬自 早期版本精简核心）
 *
 * - 纯展示无按钮无回调
 * - 品品填结构化参数（标题/小标题/正文/落款），不手写飞书 JSON
 * - schema 复用 ask-user-question / 早报卡已在 SDK 1.64.0 + 当前租户跑通的安全子集
 *
 * buildPollCard：投票卡（V2 schema，按钮带 behaviors callback 回调，支持实时刷票）
 */

export interface DiyCardSection {
  heading?: string;
  body: string;
}

export function buildDiyCard(
  title: string,
  sections: DiyCardSection[],
  footer?: string,
): object {
  const elements: object[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const content = s.heading ? `**${s.heading}**\n${s.body}` : s.body;
    elements.push({ tag: "div", text: { tag: "lark_md", content } });
    if (i < sections.length - 1) elements.push({ tag: "hr" });
  }
  if (footer) {
    elements.push({
      tag: "note",
      elements: [{ tag: "lark_md", content: footer }],
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: title },
      template: "blue",
    },
    elements,
  };
}

// ────────────────────────────────────────────────────────────
// 投票卡（V2 schema，按钮带 callback behaviors）
// ────────────────────────────────────────────────────────────

export interface PollCardVoteCounts {
  [optionIdx: number]: number;
}

/**
 * 构建（或刷新）投票卡
 * @param pollId  DB poll_id（同时作 action.value.poll_id 回传）
 * @param question 投票问题
 * @param options  选项文字数组
 * @param votes   各选项得票数 { optionIdx: count }
 * @param closed  是否已关闭（关闭后按钮变灰不可点）
 */
export function buildPollCard(
  pollId: string,
  question: string,
  options: string[],
  votes: PollCardVoteCounts,
  closed = false,
): object {
  const total = Object.values(votes).reduce((s, n) => s + n, 0);

  // 每个选项一行：[序号 文字] 票数 + 按钮
  const optionRows = options.map((opt, idx) => {
    const count = votes[idx] ?? 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const label = `${idx + 1}. ${opt}   **${count} 票**${total > 0 ? ` (${pct}%)` : ""}`;
    return {
      tag: "column_set",
      flex_mode: "none",
      background_style: "default",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 4,
          elements: [
            { tag: "div", text: { tag: "lark_md", content: label } },
          ],
        },
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: closed
            ? [{ tag: "div", text: { tag: "lark_md", content: "已关闭" } }]
            : [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "投票" },
                  type: "primary",
                  disabled: false,
                  behaviors: [
                    {
                      type: "callback",
                      value: {
                        poll_id: pollId,
                        option_idx: idx,
                      },
                    },
                  ],
                },
              ],
        },
      ],
    };
  });

  const footerText = closed
    ? `投票已结束 · 共 ${total} 票`
    : `点击「投票」选择选项 · 已有 ${total} 人投票（可改票）`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `📊 ${question}` },
      template: closed ? "grey" : "green",
    },
    elements: [
      ...optionRows,
      { tag: "hr" },
      {
        tag: "note",
        elements: [{ tag: "lark_md", content: footerText }],
      },
    ],
  };
}

/** confirm_dangerous_action 用的确认卡（绿同意红拒绝双按钮的降级版） */
export function buildConfirmCard(actionSummary: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "⚠️ 危险操作请确认" },
      template: "orange",
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**操作**：${actionSummary}` } },
      { tag: "hr" },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            "**请回复**：\n- 同意 → 回复『同意』『可以』『嗯』\n- 拒绝 → 回复『拒绝』『不行』『算了』\n\n（卡片回调机制 channel 版暂未接入，需文字回复）",
        },
      },
    ],
  };
}
