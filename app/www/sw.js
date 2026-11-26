// 极光 Aurora · Scramjet 服务工作线程
// controller.sw.js 提供 $scramjetController.shouldRoute / route：
// 命中 Scramjet 标签页前缀的请求会被转发给页面侧 Controller 处理，
// 其余请求（外壳、API、轻量代理）一律放行给网络。
importScripts('/controller/controller.sw.js');

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    if ($scramjetController.shouldRoute(event)) {
        event.respondWith($scramjetController.route(event));
    }
});
