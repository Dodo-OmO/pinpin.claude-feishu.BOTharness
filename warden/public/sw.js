// 最简 service worker：仅满足 PWA「可安装到桌面」条件。
// 管家是实时数据（状态/终端），不做离线缓存 → fetch 透传网络。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // 透传，不拦截
