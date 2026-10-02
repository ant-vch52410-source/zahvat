// Service worker «Захвата» (задача 1): держит файлы приложения в кэше, чтобы оно открывалось без сети.
// Стратегия «сначала кэш»: файлы берутся из кэша, сеть — только если файла там нет.
// Выпускаете новую версию — увеличьте VERSION, иначе телефон продолжит показывать старую.

const VERSION = 'zahvat-v2';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './core.js',
  './db.js',
  './speech.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// Новая версия включилась — удаляем старые кэши
self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
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
