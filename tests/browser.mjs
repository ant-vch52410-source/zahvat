// Проверка настоящего экрана и базы в установленном Edge без настоящего микрофона.
// Запуск: node tests/browser.mjs. Сервер доступен только на 127.0.0.1 и отдаёт только файлы приложения.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
const allowed = new Set(['index.html', 'app.js', 'capture.js', 'core.js', 'speech.js', 'db.js', 'style.css', 'sw.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'lib/jsQR.js',
  'tests/tests.html', 'tests/tests.js']);
const types = { js: 'text/javascript', html: 'text/html', css: 'text/css', svg: 'image/svg+xml',
  png: 'image/png', webmanifest: 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!allowed.has(name)) { res.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(join(root, name));
    res.writeHead(200, { 'Content-Type': types[name.split('.').at(-1)] || 'application/octet-stream' });
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'zahvat-edge-test-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let socket, seq = 0;
const pending = new Map();
async function until(fn, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error('Тайм-аут: ' + label);
}
function call(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP: ' + method)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const fake = `window.__speechInstances = [];
window.SpeechRecognition = class {
  constructor() { window.__speechInstances.push(this); }
  start() {} stop() {} abort() {}
  result(parts, resultIndex = 0) { this.onresult({ resultIndex, results: parts.map(([t,f]) => Object.assign([{transcript:t}], {isFinal:f})) }); }
  end() { this.onend(); }
};`;
try {
  assert.equal((await fetch(origin)).status, 200);
  const port = await until(async () => {
    try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim(); }
    catch { return null; }
  }, 'запуск Edge');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }); });
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    if (data.error) task.reject(new Error(data.error.message)); else task.resolve(data.result);
  });
  await call('Page.enable');
  await call('Page.navigate', { url: origin + '/tests/tests.html' });
  await until(() => evaluate('document.body?.dataset.done'), 'проверки в браузере');
  assert.equal(await evaluate('document.body.dataset.done'), 'ok', await evaluate('document.body.innerText'));
  console.log(await evaluate('document.querySelector("#summary").textContent'));
  await call('Page.addScriptToEvaluateOnNewDocument', { source: fake });
  await call('Page.navigate', { url: origin + '/' });
  await until(() => evaluate('document.querySelector("#text") && document.readyState === "complete"'), 'главный экран');
  await evaluate(`(async () => { await navigator.serviceWorker.ready; return true; })()`);
  await delay(200);
  await evaluate(`document.querySelector('#btnMic').click()`);
  assert.equal(await evaluate('window.__speechInstances.length'), 1);
  const phrase = Array.from({ length: 90 }, (_, i) => 'слово' + i).join(' ');
  await evaluate(`(() => { const r = window.__speechInstances.at(-1); for (let i=0; i<100; i++) r.result([[${JSON.stringify(phrase)}, true]]); })()`);
  assert.equal(await evaluate('document.querySelector("#text").value'), phrase);
  await evaluate(`window.__speechInstances.at(-1).end()`);
  const full = phrase + ' и купить молоко';
  await evaluate(`window.__speechInstances.at(-1).result([[${JSON.stringify(full)}, false]])`);
  assert.equal(await evaluate('document.querySelector("#interim").textContent'), 'и купить молоко');
  await evaluate(`document.querySelector('#btnMic').click(); document.querySelector('#btnSave').click()`);
  const saved = await until(() => evaluate(`import('./db.js').then(db => db.getAllEntries()).then(rows => rows.length && rows)`), 'сохранение записи');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].text, 'Заметка: ' + full);
  assert.equal(saved[0].source, 'voice');
  assert.equal(await evaluate('document.querySelector("#text").value'), '');
  // Запоздалый ответ не должен снова заполнить уже очищенное поле.
  await evaluate(`window.__speechInstances.at(-1).result([['старый ответ', true]]); window.__speechInstances.at(-1).end()`);
  assert.equal(await evaluate('document.querySelector("#text").value'), '');
  await evaluate(`document.querySelector('#btnMenu').click()`);
  await until(() => evaluate('document.body.innerText.includes("Версия 9.1")'), 'загрузка меню');
  assert.ok((await evaluate('caches.keys()')).includes('zahvat-v9.1'));

  await evaluate(`document.querySelector('#btnMenu').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('#tags button').length`),6);
  assert.deepEqual(await evaluate(`(()=>{const ids=[...document.querySelectorAll('[id]')].map(n=>n.id);return ids.filter((id,i)=>ids.indexOf(id)!==i)})()`),[]);
  const catalog={app:'zahvat-catalog',v:1,accounts:[{name:'Счёт тест',currency:'RUB'},{name:'Карта тест',currency:'RUB'}],articles:[{name:'Продукты тест',mode:'expense'},{name:'Зарплата тест',mode:'income'}],clients:[{id:101,name:'Клиент тест'}],workClients:[{id:101,name:'Клиент тест'}],projects:[{id:202,name:'Проект тест',client_id:101}],folders:[{id:303,name:'Папка тест'}],activities:[{id:404,name:'Работа тест'}]};
  await evaluate(`(()=>{const input=document.querySelector('#fileLists'),dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(JSON.stringify(catalog))}],'catalog.json',{type:'application/json'}));input.files=dt.files;input.dispatchEvent(new Event('change'));})()`);
  await until(()=>evaluate(`document.querySelector('#accounts').textContent.includes('Счёт тест')`),'справочники');
  await evaluate(`document.querySelector('#operationDate').value='31.12.2026';document.querySelector('#operationDate').dispatchEvent(new Event('input'));document.querySelector('#opNext').click()`);
  assert.equal(await evaluate(`document.querySelector('#operationDate').value`),'01.01.2027');
  await evaluate(`document.querySelector('#captureMode [data-mode="income"]').click();document.querySelector('#cats button').click();document.querySelector('#pad [data-key="5"]').click();document.querySelector('#btnSave').click()`);
  let rows=await until(()=>evaluate(`import('./db.js').then(db=>db.getAllEntries()).then(rows=>rows.length>=2&&rows)`),'доход');
  let income=rows.find(e=>e.payload?.kind==='finance');
  assert.equal(income.payload.mode,'income');assert.equal(income.payload.amount,500);assert.equal(income.payload.day,'2027-01-01');
  assert.equal(income.payload.article,'Зарплата тест');
  await evaluate(`document.querySelector('#captureMode [data-mode="transfer"]').click();document.querySelector('#to').value='Карта тест';document.querySelector('#to').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#pad [data-key="2"]').click();document.querySelector('#btnSave').click()`);
  rows=await until(()=>evaluate(`import('./db.js').then(db=>db.getAllEntries()).then(rows=>rows.length>=3&&rows)`),'перевод');
  assert.equal(rows.find(e=>e.payload?.mode==='transfer').payload.to_account,'Карта тест');
  for(const [tag,kind] of [['Задача','task'],['Заметка','note'],['Идея','idea'],['Время','time'],['Работа','work']]){
    await evaluate(`document.querySelector('#tags [data-tag="${tag}"]').click();document.querySelector('#text').value='Тест ${tag}';document.querySelector('#text').dispatchEvent(new Event('input'))`);
    if(tag==='Задача')await evaluate(`document.querySelector('#at').value='15:30';document.querySelector('#priority').value='high';document.querySelector('#project').value='202'`);
    if(tag==='Заметка')await evaluate(`document.querySelector('#folder').value='303';document.querySelector('#important').checked=true`);
    if(tag==='Идея')await evaluate(`document.querySelector('#project').value='202';document.querySelector('#tags').dispatchEvent(new Event('change'))`);
    if(tag==='Время')await evaluate(`document.querySelector('#activity').value='404';document.querySelector('#day').value='2026-01-12';document.querySelector('#start').value='10:00';document.querySelector('#end').value='10:30'`);
    if(tag==='Работа')await evaluate(`document.querySelector('#client').value='101';document.querySelector('#client').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#project').value='202';document.querySelector('#workAmount').value='1200,50'`);
    await evaluate(`document.querySelector('#btnSave').click()`);
    rows=await until(()=>evaluate(`import('./db.js').then(db=>db.getAllEntries()).then(rows=>rows.some(e=>e.payload?.kind==='${kind}'&&e.payload.text==='Тест ${tag}')&&rows)`),'сохранение '+tag);
  }
  assert.equal(rows.find(e=>e.payload?.kind==='work').payload.amount,120050);
  assert.equal(rows.find(e=>e.payload?.kind==='task').payload.project.id,202);
  assert.equal(rows.find(e=>e.payload?.kind==='note'&&e.payload.text==='Тест Заметка').payload.folder.id,303);
  const beforeBackup=await evaluate(`import('./db.js').then(db=>db.getAllEntries())`);
  const roundtrip=await evaluate(`Promise.all([import('./core.js'),import('./db.js')]).then(([c,db])=>db.getAllEntries().then(rows=>({normalized:rows.map(c.normalizeEntry),csv:c.parseCsv(c.toCsv(rows))})))`);
  assert.deepEqual(roundtrip.normalized.map(e=>e.payload),beforeBackup.map(e=>e.payload));
  assert.equal(roundtrip.csv[0].at(-1),'данные');
  const financeCsv=roundtrip.csv.slice(1).find(r=>r[0]===income.id);
  assert.equal(JSON.parse(financeCsv.at(-1)).amount,500);
  await call('Emulation.setDeviceMetricsOverride',{width:360,height:762,deviceScaleFactor:1,mobile:true});
  for(const tag of ['', 'Задача','Заметка','Идея','Время','Работа']){
    await evaluate(`document.querySelector('#tags [data-tag="${tag}"]').click()`);
    const sizes=await evaluate(`(()=>{const m=document.querySelector('#btnMic').getBoundingClientRect();return {over:document.documentElement.scrollWidth>innerWidth,right:innerWidth-m.right,bottom:innerHeight-m.bottom}})()`);
    assert.equal(sizes.over,false);assert.equal(Math.round(sizes.right),16);assert.equal(Math.round(sizes.bottom),16);
    await mkdir(join(root,'tests','screenshots'),{recursive:true});const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(root,'tests','screenshots',(tag||'Захват')+'.png'),Buffer.from(shot.data,'base64'));
  }
  await evaluate(`document.querySelector('#showAll').click()`);
  const allShot=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(root,'tests','screenshots','Все записи.png'),Buffer.from(allShot.data,'base64'));
  await evaluate(`document.querySelector('#btnMic').click()`);
  assert.equal(await evaluate(`document.querySelector('#homeView').hidden`),false);
  assert.equal(await evaluate(`document.querySelector('#btnMic').getAttribute('aria-pressed')`),'true');
  console.log('Все 6 разделов: сохранение полей в IndexedDB, дата, перевод, CSV/копия, уникальные id, микрофон и ширина 360 — OK');
  console.log('Edge: HTTP 200, ввод 90 слов, 100 повторных событий, пауза, сохранение в IndexedDB и версия 9.1 — OK');
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await call('Browser.close').catch(() => {});
    socket.close();
  }
  browser.kill();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  // Удаляем только выделенный временный профиль тестового браузера.
  const target = resolve(profile), parent = resolve(tmpdir()) + sep;
  if (!target.startsWith(parent) || !target.slice(parent.length).startsWith('zahvat-edge-test-')) {
    throw new Error('Недопустимый путь временного профиля');
  }
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
