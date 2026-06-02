// 飞书 OAuth user_access_token 保活 cron（MCP 版）
// 阶段 4 批次 1 步骤 1.3：协议 #49 子模块——每天 04:00 调 getUserToken({keepalive:true})
// 续期 refresh_token，防止 7 天 refresh_token_expires_in 过期断链。
//
// 多 CLI 架构（2026-05-28 Owner决策）：搬到 supervisor 主进程跑（详 supervisor/cron-runner.ts），
// 因为 daily-restart 编排会在 03:55 stop 所有 CLI，04:00 时刻所有 CLI 都不在线，
// CLI 端 cron 触发不到——必须 supervisor 主进程独立跑。
// 本文件 CLI 子进程内 **行为层关**——保留代码不调 registerCron（CLAUDE.md "弃用默认留码"规则）。

// import { registerCron } from "./registry.js";
// import { getUserToken } from "../feishu/feishu-token.js";
// registerCron("feishu-token-keepalive", { kind: "daily", h: 4, m: 0 }, async () => { ... });

export {};
