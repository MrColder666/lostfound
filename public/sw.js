// public/sw.js —— 静态壳缓存优先；API 一律网络直连（不缓存个人数据）
const SHELL = ['/', '/css/tokens.css', '/css/fonts.css', '/css/app.css', '/js/app.js', '/js/idb.js', '/js/canvas-image.js', '/js/i18n-inline.js', '/kiosk.html', '/css/kiosk.css', '/js/kiosk.js', '/js/vendor/jsQR.js'];
self.addEventListener('install', e => e.waitUntil(caches.open('lf-v1').then(c => c.addAll(SHELL))));
self.addEventListener('fetch', e => {
  if (new URL(e.request.url).pathname.startsWith('/api/')) return;  // 网络优先，失败交给 app 层队列
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
