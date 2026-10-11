// «Разбор» на телефоне (Органайзер КАА, задача 248.12): оболочка вокруг той же страницы, что на компьютере.
// Файл с компьютера (razbor_….zip: копия базы + код страницы + шрифт) распаковывается в Python для браузера (Pyodide),
// запросы страницы приходят сюда от service worker (sw.js) и обрабатываются кодом компьютера (phone/host.py).
// Копия базы и сам файл хранятся в телефоне (IndexedDB) — после перезапуска приложения работа продолжается.
// «На компьютер» — razbor_otvet_<выгрузка>_<когда>.zip (изменённая копия базы); его принимает «Разбор» на компьютере.

const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
const W = '/work';                       // папка распакованного файла внутри Python
const $ = (s) => document.querySelector(s);
let py = null, host = null, queue = Promise.resolve(), dbTime = 0;
const state = {info: null, edits: 0, sent: ''};

function msg(text, err) { $('#msg').textContent = text; $('#msg').className = err ? 'err' : ''; }
function infoLine() {
  if (!state.info) { $('#info').textContent = 'Разбор'; return; }
  const made = state.info.made ? state.info.made.slice(8, 10) + '.' + state.info.made.slice(5, 7) + ' ' + state.info.made.slice(11) : '';
  $('#info').textContent = `выгрузка ${made} · правок ${state.edits}` + (state.sent ? ` · отправлено ${state.sent}` : '');
}

// ---- хранилище телефона: файл с компьютера, рабочая копия базы, счётчик правок ----
function idb() {
  return new Promise((ok, bad) => {
    const r = indexedDB.open('razbor', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
}
async function get(key) {
  const db = await idb();
  return new Promise((ok, bad) => { const r = db.transaction('kv').objectStore('kv').get(key); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
}
async function put(key, value) {
  const db = await idb();
  return new Promise((ok, bad) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(value, key); t.oncomplete = ok; t.onerror = () => bad(t.error); });
}

// ---- Python ----
async function loadPy() {
  if (py) return py;
  msg('Загружаю Python… (первый раз — около 15 МБ, нужен интернет; дальше — без сети)');
  await new Promise((ok, bad) => {
    const s = document.createElement('script'); s.src = PYODIDE + 'pyodide.js';
    s.onload = ok; s.onerror = () => bad(new Error('Не удалось загрузить Python: при первом запуске нужен интернет'));
    document.head.appendChild(s);
  });
  py = await loadPyodide({indexURL: PYODIDE});
  await py.loadPackage('sqlite3');
  return py;
}

// Распаковать файл с компьютера и запустить страницу; db — сохранённая рабочая копия (продолжение работы)
async function boot(bundle, db) {
  const p = await loadPy();
  msg('Открываю файл…');
  p.runPython("import shutil, os; shutil.rmtree('/work', ignore_errors=True); os.makedirs('/work')");
  p.unpackArchive(bundle, 'zip', {extractDir: W});
  if (db) p.FS.writeFile(W + '/finance.db', db);
  state.info = JSON.parse(p.FS.readFile(W + '/info.json', {encoding: 'utf8'}));
  p.runPython(`
import importlib.util, sys
for name in [m for m in sys.modules if m in ('razbor_host', 'core', 'modules') or m.startswith(('core.', 'modules.'))]:
    del sys.modules[name]
spec = importlib.util.spec_from_file_location('razbor_host', '/work/modules/finance/phone/host.py')
host = importlib.util.module_from_spec(spec)
sys.modules['razbor_host'] = host
spec.loader.exec_module(host)
host.start('/work', '/work/finance.db', open('/work/snap.json', encoding='utf-8').read())
`);
  if (host) host.destroy();
  host = p.pyimport('razbor_host');
  dbTime = p.FS.stat(W + '/finance.db').mtime;
  await navigator.serviceWorker.ready;           // страницу отдаёт service worker — он должен работать
  $('#start').style.display = 'none';
  $('#app').style.display = 'block';
  $('#app').src = './app/';
  $('#send').style.display = '';
  infoLine();
}

// Запрос страницы (от sw.js) → Python → ответ
async function answer(d, port) {
  if (!host) { port.postMessage({status: 503, ctype: 'text/plain; charset=utf-8', body: 'Файл ещё не открыт'}); return; }
  try {
    const res = host.handle(d.method, d.path, d.body);
    const status = res.get(0), ctype = res.get(1);
    let body = res.get(2);
    if (body && typeof body === 'object' && body.toJs) { const b = body.toJs(); body.destroy(); body = b; }   // байты (шрифт)
    res.destroy();
    port.postMessage({status, ctype, body});
    if (d.method === 'POST') await saveIfChanged();
  } catch (e) {
    port.postMessage({status: 500, ctype: 'application/json; charset=utf-8', body: JSON.stringify({error: String(e)})});
  }
}

// База изменилась (действие, а не просмотр) — сохранить копию в телефоне и посчитать правку
async function saveIfChanged() {
  const t = py.FS.stat(W + '/finance.db').mtime;
  if (+t === +dbTime) return;
  dbTime = t;
  state.edits += 1;
  await put('db', py.FS.readFile(W + '/finance.db'));
  await put('edits', state.edits);
  infoLine();
}

// ---- обмен файлами ----
async function openFile(file) {
  if (state.edits && !confirm('Есть правки, не отправленные на компьютер. Открыть новый файл — они пропадут. Открыть?')) return;
  try {
    const bundle = await file.arrayBuffer();
    await put('bundle', bundle); await put('db', null); await put('edits', 0); await put('sent', '');
    state.edits = 0; state.sent = '';
    await boot(bundle, null);
  } catch (e) { msg(String(e.message || e), true); }
}

async function sendBack() {
  const now = new Date(), two = (n) => String(n).padStart(2, '0');
  const sent = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
  py.globals.set('sent_at', sent);
  py.runPython(`
import json, sqlite3, zipfile
src, dst = sqlite3.connect('/work/finance.db'), sqlite3.connect('/work/send.db')
src.backup(dst); src.close(); dst.close()
info = json.load(open('/work/info.json', encoding='utf-8'))
with zipfile.ZipFile('/work/otvet.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.write('/work/send.db', 'finance.db')
    z.writestr('info.json', json.dumps({'stamp': info['stamp'], 'sent': sent_at}, ensure_ascii=False))
`);
  const name = `razbor_otvet_${state.info.stamp}_${sent.replace(' ', '_').replace(':', '-')}.zip`;
  const file = new File([py.FS.readFile(W + '/otvet.zip')], name, {type: 'application/zip'});
  try {
    if (navigator.canShare && navigator.canShare({files: [file]})) await navigator.share({files: [file], title: name});
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click(); }
  } catch (e) { if (e.name === 'AbortError') return; throw e; }
  state.sent = sent.slice(11); state.edits = 0;
  await put('edits', 0); await put('sent', state.sent);
  infoLine();
}

// ---- запуск ----
navigator.serviceWorker.onmessage = (ev) => {
  if (!ev.data || ev.data.type !== 'py') return;
  const port = ev.ports[0];
  queue = queue.then(() => answer(ev.data, port));      // по одному: Python один
};
$('#open').onclick = () => $('#file').click();
$('#file').onchange = (e) => { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ''; };
$('#send').onclick = () => sendBack().catch((e) => alert('Не получилось: ' + (e.message || e)));

(async () => {
  try {
    await navigator.serviceWorker.register('sw.js');
    const bundle = await get('bundle');
    if (!bundle) return;
    state.edits = (await get('edits')) || 0; state.sent = (await get('sent')) || '';
    await boot(bundle, await get('db'));
  } catch (e) { msg(String(e.message || e), true); }
})();
