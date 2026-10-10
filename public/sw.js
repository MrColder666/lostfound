// public/sw.js —— 部署后必须立即拿到新代码：代码类资源网络优先、离线回退缓存；字体/图标等不变资源走缓存
const CACHE = 'lf-v3';
const SHELL = ['/', '/css/tokens.css', '/css/fonts.css', '/css/app.css', '/js/app.js', '/js/idb.js', '/js/canvas-image.js', '/js/i18n-inline.js', '/kiosk.html', '/css/kiosk.css', '/js/kiosk.js', '/js/vendor/jsQR.js'];
self.addEventListener('install', (e) => {
  self.skipWaiting();   // 新版 SW 立即接管，不等待旧页关闭
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())
));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;                       // API 直连（不缓存个人数据）
  if (/\.(woff2|png|jpg|jpeg|svg|ico)$/.test(url.pathname)) {          // 不变资源：缓存优先
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
    return;
  }
  // 代码与页面：网络优先（保证部署后立刻生效），失败回退缓存（离线可用）
  e.respondWith(fetch(e.request).then((r) => {
    if (r && r.ok && e.request.method === 'GET') {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return r;
  }).catch(() => caches.match(e.request)));
});
