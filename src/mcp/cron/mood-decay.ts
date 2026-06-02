// 心境衰减 cron（MCP 版）
// 阶段 4 批次 3 步骤 3.2：每小时整点 → 直接调 decayMoodlets（轻活，不推 session）
//
// 多 CLI 架构（2026-05-28 Owner决策）：本 cron 搬到 supervisor 主进程跑
// （详 supervisor/cron-runner.ts），避免 N 个 CLI 整点同时写 mood-state 撞锁。
// 本文件 CLI 子进程内 **行为层关**——保留代码不调 registerCron（CLAUDE.md "弃用默认留码"规则）。

// import { registerCron } from "./registry.js";
// import { decayMoodlets } from "../utils/mood-state.js";
// registerCron("mood-decay", { kind: "hourly", m: 0 }, () => { decayMoodlets(); });

export {};
