// PreToolUse 写保护（2026-08-24，三兄弟提示词工作频道配套）：
// 拦 Write/Edit/NotebookEdit 落向Owner业务目录（品品对这些目录只读不写——所有频道一律适用）。
// 备胎机制：主闸是 vault settings.json 的 permissions.deny 路径规则；
// 若实测 deny 在 bypassPermissions 下不生效，才把本脚本挂进 settings.json 的 PreToolUse。
// exit 2 = 阻止该次工具调用（stderr 回喂模型）；任何解析异常 → exit 0 放行（fail-safe，不能瘫痪全部写入）。

const FORBIDDEN_PREFIXES = [
  "d:\\repo\\claude\\workspace\\code-base\\九州2608-三兄弟新娘",
  "d:\\repo\\工作\\九州文化",
];

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(raw);
    const input = j.tool_input || {};
    const p = String(input.file_path || input.notebook_path || "");
    if (!p) process.exit(0);
    const norm = p.replace(/\//g, "\\").toLowerCase();
    if (FORBIDDEN_PREFIXES.some((f) => norm.startsWith(f))) {
      process.stderr.write(
        "🚫 该目录是Owner的业务目录，品品只读不写（提示词等产出走群消息或作业本，不回写业务目录）。",
      );
      process.exit(2);
    }
  } catch {
    /* fail-safe */
  }
  process.exit(0);
});
