// 每日定时重启 cron（MCP 版）
// 多 CLI 架构（2026-05-28 Owner决策）：旧版"每个 CLI 各自 process.exit"暴力路径已废弃。
// 现由 supervisor 主进程编排：03:55 stop 所有 CLI / 04:10 start 所有 CLI
// （详 supervisor/cron-runner.ts）。supervisor 主进程跑 cron 时按 channel-config.json
// 列表逐个 stop/start，留出 token-keepalive 04:00 单独 supervisor 内执行的窗口。
//
// 本文件 CLI 子进程内 **行为层关**——保留代码不调 registerCron（CLAUDE.md "弃用默认留码"规则）。

// import { registerCron } from "./registry.js";
// registerCron("daily-restart", { kind: "daily", h: 6, m: 0 }, () => { ... process.exit(0) });

export {};
