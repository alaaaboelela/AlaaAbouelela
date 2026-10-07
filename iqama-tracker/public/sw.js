// Service Worker: يخلي المنصة قابلة للتثبيت كتطبيق، ويفتح صفحة "غير متصل" بدل صفحة خطأ عند انقطاع النت.
// البيانات (/api) لا تُخزّن أبدًا؛ الملفات الثابتة: الشبكة أولًا (دايمًا أحدث نسخة) والمخزن احتياطي.
const CACHE = 'iqama-shell-v1';
const SHELL = [
  '/', '/index.html', '/login.html', '/offline.html', '/style.css', '/theme.js', '/hijri.js', '/app.js', '/modules.js',
  '/admin.js', '/planner.js', '/login.js', '/pwa.js', '/icons.svg', '/manifest.webmanifest', '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // الخطوط من Google: من المخزن أولًا (لا تتغير)
  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') caches.open(CACHE).then((c) => c.put(req, res.clone()));
      return res;
    })));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(async () => {
    const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit && req.mode !== 'navigate') return hit;
    // الصفحات بدون نت: صفحة "غير متصل" (المنصة تحتاج الخادم لعرض البيانات)
    if (req.mode === 'navigate') return caches.match('/offline.html');
    return hit || Response.error();
  }));
});
