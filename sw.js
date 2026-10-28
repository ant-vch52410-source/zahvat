// Шесть разделов и структурированный обмен с Органайзером (задача 7).
// Service worker «Захвата» (задачи 1, 3, 4, 5): держит файлы приложения в кэше, чтобы оно открывалось без сети.
// Стратегия «сначала кэш»: файлы берутся из кэша, сеть — только если файла там нет.
// Выпускаете новую версию — увеличьте VERSION, иначе телефон продолжит показывать старую.

const VERSION = 'zahvat-v9.1';   // та же цифра — APP_VERSION в app.js (видна в меню)
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './capture.js',
  './core.js',
  './db.js',
  './speech.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './lib/jsQR.js',
];

self.addEventListener('install', (ev) => {
  // cache: 'reload' — мимо кэша браузера, иначе новая версия могла взять старые файлы (задача 5)
  ev.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL.map(url => new Request(url, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

// Новая версия включилась — удаляем старые кэши
self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('zahvat-v') && k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  ev.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).catch(() =>
      // без сети и без кэша: для открытия страницы отдаём главный экран
      req.mode === 'navigate' ? caches.match('./index.html') : Response.error()
    ))
  );
});
