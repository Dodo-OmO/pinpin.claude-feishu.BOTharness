/**
 * 管家(warden)进程配置常量。
 *
 * 管家 = 独立系统 node 进程（tsx 跑），开机自启、活在 Electron 启动器之外。
 * 它开一个手机网页仪表盘(HTTP)，并作客户端连入 supervisor 的固定端口桥接口借用 CLI 能力。
 * 全部 HTTP/WS 仅绑 127.0.0.1——只允许 Cloudflare 隧道转发进来，不裸暴露局域网(R6 安全)。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 管家网页/API HTTP 端口（手机经 Cloudflare 隧道访问此端口） */
export const HTTP_PORT = Number(process.env.WARDEN_HTTP_PORT) || 47800;

/** 代码包根目录（warden/ 在其下；拉起启动器 / 定位脚本用） */
export const CODE_ROOT = path.resolve(__dirname, '..');

/** 前端静态资源目录 */
export const PUBLIC_DIR = path.join(__dirname, 'public');
