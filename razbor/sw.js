// Service worker «Разбора» на телефоне (Органайзер КАА, задача 248.12).
// 1) Держит в кэше оболочку и Python для браузера (Pyodide) — после первого запуска всё работает без сети.
// 2) Запросы страницы «Разбор» (папка app/) не уходят в сеть: передаются окну оболочки, там их обрабатывает
//    тот же Python-код, что на компьютере (копия базы — только в телефоне).
// Выпускаете новую версию оболочки — увеличьте VERSION, иначе телефон продолжит показывать старую.

const VERSION = 'razbor-v2';
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'];
const APP = new URL('./app/', self.registration.scope).pathname;          // …/razbor/app/

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'pyodide').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (url.origin === location.origin && url.pathname.startsWith(APP)) { ev.respondWith(toPython(ev.request, url)); return; }
  if (url.href.startsWith(PYODIDE)) { ev.respondWith(cached('pyodide', ev.request)); return; }
  if (ev.request.method === 'GET' && url.origin === location.origin) {
    ev.respondWith(caches.match(ev.request, {ignoreSearch: true}).then((hit) => hit || fetch(ev.request)));
  }
});

// Сначала кэш; нет — из сети и положить в кэш (Python скачивается один раз)
async function cached(name, req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(name)).put(req, res.clone());
  return res;
}

// Запрос страницы → окно оболочки (там Python) → ответ
async function toPython(req, url) {
  const body = req.method === 'POST' ? await req.text() : '';
  const wins = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
  const scope = new URL(self.registration.scope).pathname;               // окно оболочки, не «Захват» и не сама страница
  const shell = wins.find((c) => { const p = new URL(c.url).pathname; return p.startsWith(scope) && !p.startsWith(APP); });
  if (!shell) return new Response('Откройте приложение «Разбор» заново.', {status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}});
  const path = '/' + url.pathname.slice(APP.length) + url.search;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({error: 'Python не ответил — перезапустите приложение.'}),
      {status: 504, headers: {'Content-Type': 'application/json; charset=utf-8'}})), 120000);
    ch.port1.onmessage = (m) => {
      clearTimeout(timer);
      resolve(new Response(m.data.body, {status: m.data.status, headers: {'Content-Type': m.data.ctype, 'Cache-Control': 'no-store'}}));
    };
    shell.postMessage({type: 'py', method: req.method, path, body}, [ch.port2]);
  });
}
