/**
 * 品品 DIY 纯展示卡片构造器（channel 版搬自 早期版本精简核心）
 *
 * - 纯展示无按钮无回调
 * - 品品填结构化参数（标题/小标题/正文/落款），不手写飞书 JSON
 * - schema 复用 ask-user-question / 早报卡已在 SDK 1.64.0 + 当前租户跑通的安全子集
 *
 * buildPollCard：投票卡（V2 schema，按钮带 behaviors callback 回调，支持实时刷票）
 * buildApprovalCard：审批卡（同款 callback 按钮，resolved 后灰头去按钮；取代旧 buildConfirmCard 文字回复降级版）
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

// ────────────────────────────────────────────────────────────
// 审批卡（B4：真按钮回调，取代旧 buildConfirmCard 文字回复降级版）
// ────────────────────────────────────────────────────────────

/** 卡片按钮回调 value 结构（同时是 cardAction 回传给 subscriber 的字段） */
export interface ApprovalCardValue {
  approval_id: string;
  origin_chat_id: string;
  choice: string;
  tag?: string;
  only_owner?: boolean;
  /** 卡片标题（≤80），随按钮回传，省得 onApprovalAction 反查卡片内容 */
  title: string;
  /** 正文行（总长截 600），supervisor 刷卡时原样带回，避免点后正文丢失 */
  lines?: string[];
  /** 按钮定义，supervisor 刷"仅豆姐可点"提示时原样保留按钮 */
  buttons?: ApprovalButton[];
}

/** 一个审批按钮：显示文案 + 点击后回传的 choice 值 */
export interface ApprovalButton {
  label: string;
  choice: string;
  style?: "default" | "primary" | "danger";
}

/**
 * 构建（或刷新）审批卡
 * @param title  卡头标题（≤80字，原样进 ApprovalCardValue.title）
 * @param lines  正文行数组（换行拼接）
 * @param buttons 按钮数组（未 resolved 时渲染）
 * @param value  按钮 callback value 的公共部分（不含 choice，choice 按各按钮自己的填）
 * @param resolved
 *   - `{by, choice_label}`：已有人选择 → 卡片变灰头、去掉按钮，footer 显示"✅ 已由 X 选择 Y"
 *   - `{note}`：未resolved但要提示（如"仅豆姐可点"）→ 保留按钮，加一行 note
 */
export function buildApprovalCard(
  title: string,
  lines: string[],
  buttons: ApprovalButton[],
  value: Omit<ApprovalCardValue, "choice">,
  resolved?: { by: string; choice_label: string } | { note: string },
): object {
  const elements: object[] = [
    { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
  ];
  // value 里带正文与按钮定义（正文截 600 字），刷卡时不依赖发卡进程
  let joined = "";
  const keptLines: string[] = [];
  for (const l of lines) {
    if (joined.length + l.length + 1 > 600) break;
    keptLines.push(l);
    joined += l + "\n";
  }
  value = { ...value, lines: keptLines, buttons: buttons.map(({ label, choice, style }) => ({ label, choice, style })) };

  if (resolved && "by" in resolved) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "note",
      elements: [
        { tag: "lark_md", content: `✅ 已由 ${resolved.by} 选择 ${resolved.choice_label}` },
      ],
    });
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: title }, template: "grey" },
      elements,
    };
  }

  elements.push({ tag: "hr" });
  elements.push({
    tag: "column_set",
    flex_mode: "none",
    background_style: "default",
    columns: buttons.map((btn) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [
        {
          tag: "button",
          text: { tag: "plain_text", content: btn.label },
          type: btn.style ?? "default",
          disabled: false,
          behaviors: [
            {
              type: "callback",
              value: { ...value, choice: btn.choice } as ApprovalCardValue,
            },
          ],
        },
      ],
    })),
  });

  if (resolved && "note" in resolved) {
    elements.push({
      tag: "note",
      elements: [{ tag: "lark_md", content: resolved.note }],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: title }, template: "orange" },
    elements,
  };
}
