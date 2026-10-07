// «Захват» — экран и действия (задачи 1, 2, 3, 4): ввод, метки-иконки, расход кнопками, последние записи,
// все записи с поиском и правкой, загрузка счетов и статей, выгрузка CSV, резервная копия, чек по QR-коду.

import * as db from './db.js';
import {
  toCsv, selectForExport, mergeEntries, formatTime, formatShort, formatLocal,
  fileStamp, isSameDay, appendPhrase, normalizeForSearch, applyTag, splitTag,
  parseLists, typeAmount, formatAmount, financeText, DEFAULT_LISTS, MAX_ACCOUNTS, MAX_CATS,
  RECEIPT_TAG, parseReceiptQr, receiptLabel,
} from './core.js';
import { Dictation } from './speech.js';

const $ = (id) => document.getElementById(id);
const ui = {
  text: $('text'), interim: $('interim'), mic: $('btnMic'), save: $('btnSave'), clear: $('btnClear'), status: $('status'),
  tags: $('tags'),
  amount: $('amount'), accounts: $('accounts'), cats: $('cats'), pad: $('pad'),
  recent: $('recent'), homeView: $('homeView'), allView: $('allView'), btnBack: $('btnBack'),
  search: $('search'), feedTitle: $('feedTitle'), feed: $('feed'),
  btnMenu: $('btnMenu'), menu: $('menu'), menuInfo: $('menuInfo'), listsInfo: $('listsInfo'),
  toast: $('toast'), toastText: $('toastText'), toastAction: $('toastAction'),
  dlg: $('exportDlg'), form: $('exportForm'), periodBox: $('periodBox'), exportCount: $('exportCount'),
  file: $('fileRestore'), fileLists: $('fileLists'),
  btnScan: $('btnScan'), scanDlg: $('scanDlg'), scanVideo: $('scanVideo'), scanHint: $('scanHint'),
  btnScanPhoto: $('btnScanPhoto'), btnScanClose: $('btnScanClose'), filePhoto: $('filePhoto'),
};

const DRAFT_KEY = 'zahvat.draft';       // черновик (текст, метка, сумма, статья) — в localStorage: пишется мгновенно
const ACCOUNT_KEY = 'zahvat.account';   // последний выбранный счёт — остаётся выбранным после сохранения
const FIN_TAG = 'Финансы';
const NOTE_TAG = 'Заметка';             // запись без выбранной метки
// Метки, которые узнаются в ленте: нынешние и старые (до задачи 3 были «Идея» и «Задача»)
const KNOWN_TAGS = ['Финансы', 'Идеи', 'Мысли', 'Заметка', 'Идея', 'Задача', RECEIPT_TAG];

let entries = [];          // все записи в памяти (их немного, так проще и быстрее)
let draftVoice = false;    // в текущем тексте есть надиктованное → источник 'voice'
let editingId = null;      // какую запись сейчас правим (в «Все записи»)
let voiceBase = '';        // текст поля на момент начала сессии распознавания
let speechError = '';      // последнее сообщение об ошибке голоса
let selectedTag = null;    // выбранная метка («Финансы», «Идеи», «Мысли») или null
const TAGS = [...ui.tags.querySelectorAll('.tag')].map(b => b.dataset.tag);

// Расход кнопками
let lists = { ...DEFAULT_LISTS, loadedAt: null };   // счета и статьи (из файла модуля Финансов)
let amount = '';           // набранная сумма как строка: «800», «12500,5»
let account = null;        // выбранный счёт
let cat = null;            // выбранная статья или null

const ICON_VOICE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" class="fill"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';
const ICON_TEXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/></svg>';

// ---------------- Голос ----------------

const dictation = new Dictation({
  onSessionStart: () => { voiceBase = ui.text.value; },
  onFinal: (phrase) => {
    ui.text.value = appendPhrase(voiceBase, phrase);
    draftVoice = true;
    ui.text.scrollTop = ui.text.scrollHeight;
    saveDraftSoon();
    updateSaveButton();
  },
  onInterim: (t) => { ui.interim.textContent = t; updateSaveButton(); },
  onState: (on) => {
    ui.mic.classList.toggle('recording', on);
    ui.mic.setAttribute('aria-pressed', String(on));
    ui.mic.setAttribute('aria-label', on ? 'Остановить диктовку' : 'Начать диктовку');
    if (on) { speechError = ''; }
    updateStatus();
  },
  onError: (msg) => { speechError = msg; updateStatus(); },
});

/** Строка состояния под кнопками: только ошибка голоса или отсутствие сети (подсказок нет). */
function updateStatus() {
  let msg = speechError;
  if (!msg && !navigator.onLine) msg = 'Нет сети: голосовой ввод Chrome не работает, текст сохраняется как обычно.';
  ui.status.textContent = msg;
  ui.status.classList.toggle('box', !!msg);
}

// ---------------- Метки ----------------

/** Выбрать метку (null — без метки). Уход с «Финансов» стирает набранную сумму и статью. */
function setTag(tag) {
  selectedTag = tag && TAGS.includes(tag) ? tag : null;
  for (const b of ui.tags.querySelectorAll('.tag')) {
    b.setAttribute('aria-pressed', String(b.dataset.tag === selectedTag));
  }
  if (selectedTag !== FIN_TAG && (amount || cat)) { amount = ''; cat = null; renderFin(); }
}

// ---------------- Расход кнопками ----------------

/** Нарисовать сумму, кнопки счетов и статей (первые 2 и 9 из файла — сколько влезает на экран). */
function renderFin() {
  ui.amount.textContent = formatAmount(amount);
  ui.amount.classList.toggle('empty', !amount);
  const accs = lists.accounts.slice(0, MAX_ACCOUNTS);
  if (!accs.includes(account)) account = accs[0] || null;
  fillButtons(ui.accounts, accs, account);
  fillButtons(ui.cats, lists.cats.slice(0, MAX_CATS), cat);
  updateSaveButton();
}

function fillButtons(box, names, selected) {
  box.replaceChildren(...names.map(name => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = name;
    b.dataset.name = name;
    b.setAttribute('aria-pressed', String(name === selected));
    return b;
  }));
}

/** Сумма набрана и больше нуля — запись будет расходом. */
function hasAmount() {
  return parseFloat(amount.replace(',', '.')) > 0;
}

function pressKey(key) {
  amount = typeAmount(amount, key);
  if (amount && selectedTag !== FIN_TAG) setTag(FIN_TAG);
  renderFin();
  saveDraftSoon();
}

/** Загрузить счета и статьи из txt, выгруженного модулем Финансов. */
async function loadLists(file) {
  const parsed = parseLists(await file.text());
  if (parsed.error) { showToast(parsed.error); return; }
  lists = { accounts: parsed.accounts, cats: parsed.cats, loadedAt: Date.now() };
  await db.setSetting('finLists', lists);
  if (cat && !lists.cats.includes(cat)) cat = null;
  renderFin();
  const more = [];
  if (lists.accounts.length > MAX_ACCOUNTS) more.push(`счетов — первые ${MAX_ACCOUNTS}`);
  if (lists.cats.length > MAX_CATS) more.push(`статей — первые ${MAX_CATS}`);
  showToast(`Загружено: счетов ${lists.accounts.length}, статей ${lists.cats.length}` +
    (more.length ? `. На экране ${more.join(', ')}.` : '.'), null, null, 5000);
}

// ---------------- Черновик ----------------

let draftTimer = 0;
function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 300);
}
function saveDraftNow() {
  clearTimeout(draftTimer);
  try {
    if (ui.text.value || selectedTag || amount || cat) {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: ui.text.value, voice: draftVoice, tag: selectedTag, amount, cat }));
    }
    else localStorage.removeItem(DRAFT_KEY);
  } catch { /* хранилище недоступно — не страшно, база записей отдельно */ }
}
function restoreDraft() {
  try {
    account = localStorage.getItem(ACCOUNT_KEY);
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (d) {
      ui.text.value = d.text || ''; draftVoice = !!d.voice; setTag(d.tag);
      if (d.tag === FIN_TAG) { amount = typeof d.amount === 'string' ? d.amount : ''; cat = d.cat || null; }
    }
  } catch { /* битый черновик — пропускаем */ }
}

// ---------------- Сохранение и «Стереть» ----------------

function updateSaveButton() {
  ui.save.disabled = !(ui.text.value.trim() || ui.interim.textContent.trim() || hasAmount());
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // запасной вариант для старых браузеров
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

/** Всё, что набрано сейчас, — чтобы вернуть после ошибки записи или «Стереть». */
function snapshot() {
  return { text: ui.text.value, voice: draftVoice, tag: selectedTag, amount, cat };
}
function restore(s) {
  ui.text.value = s.text;
  draftVoice = s.voice;
  setTag(s.tag);
  amount = s.amount; cat = s.cat;   // после setTag: он стирает сумму, пока метка не «Финансы»
  renderFin();
  saveDraftNow();
}
function resetInput() {
  ui.text.value = '';
  draftVoice = false;
  setTag(null);   // заодно стирает сумму и статью
  renderFin();
}

async function saveEntry() {
  if (dictation.recording || ui.interim.textContent) {
    // Недоговорённое (серый текст) тоже сохраняем, запись голоса останавливаем
    const pending = ui.interim.textContent;
    dictation.cancel();
    if (pending) { ui.text.value = appendPhrase(ui.text.value, pending); draftVoice = true; }
  }
  const raw = ui.text.value.trim();
  const isFin = selectedTag === FIN_TAG && hasAmount();
  if (!raw && !isFin) return;
  const before = snapshot();
  // Расход: «Финансы: мир 800 продукты, Пятёрочка»; без метки — «Заметка: …»
  const text = isFin
    ? applyTag(financeText({ account, amount, cat, note: raw }), FIN_TAG)
    : applyTag(raw, selectedTag || NOTE_TAG);
  const now = Date.now();
  const entry = {
    id: newId(), ts: now, createdAt: now, updatedAt: now,
    text, source: draftVoice ? 'voice' : 'text', exportedAt: null,
  };
  // Поле сбрасываем сразу: если начать следующую запись, пока идёт запись в базу, она не пропадёт
  resetInput();
  try {
    await db.putEntry(entry);
  } catch (err) {
    if (ui.text.value) before.text = before.text + '\n' + ui.text.value;
    restore(before);
    showToast('Не удалось сохранить: ' + (err && err.message || err) + '. Текст остался в поле.');
    return;
  }
  saveDraftNow();   // черновик стираем только после удачной записи
  entries.push(entry);
  render();
  showToast('Сохранено');
}

/** «Стереть»: очистить поле, сумму, статью и метку; можно вернуть из сообщения. */
function clearInput() {
  dictation.cancel();
  ui.interim.textContent = '';
  const before = snapshot();
  if (!before.text && !before.tag && !before.amount && !before.cat) return;
  resetInput();
  saveDraftNow();
  showToast('Стёрто', 'Вернуть', () => restore(before), 6000);
}

// ---------------- Последние записи и «Все записи» ----------------

function render() {
  renderRecent();
  if (!ui.allView.hidden) renderFeed();
}

/** Текст записи с цветной меткой: «Финансы:» выделена. */
function entryText(e) {
  const frag = document.createDocumentFragment();
  const { tag, rest } = splitTag(e.text, KNOWN_TAGS);
  if (tag) {
    const lb = document.createElement('span');
    lb.className = 'lb';
    lb.textContent = tag + ': ';
    frag.append(lb, tag === RECEIPT_TAG ? receiptLabel(rest) : rest);
  } else frag.append(e.text);
  return frag;
}

/** Главный экран: записи за сегодня по одной строке, новые сверху; лишние обрезает высота экрана. */
function renderRecent() {
  const now = Date.now();
  const list = entries.filter(e => isSameDay(e.ts, now)).sort((a, b) => b.ts - a.ts).slice(0, 40);
  ui.recent.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Сегодня записей ещё нет.';
    ui.recent.append(li);
    return;
  }
  for (const e of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = e.id;
    b.setAttribute('aria-label', `${formatTime(e.ts)}: ${e.text}. Нажмите, чтобы изменить`);
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(e.ts);
    b.append(time, entryText(e));
    li.append(b);
    ui.recent.append(li);
  }
}

/** Открыть «Все записи» (по желанию — сразу правку записи). «Назад» телефона закрывает экран. */
function openAll(editId = null) {
  closeMenu();
  editingId = editId;
  ui.search.value = '';
  ui.homeView.hidden = true;
  ui.allView.hidden = false;
  history.pushState({ view: 'all' }, '');
  renderFeed();
  window.scrollTo(0, 0);
}
function closeAll() {
  editingId = null;
  ui.allView.hidden = true;
  ui.homeView.hidden = false;
  renderRecent();
}

function renderFeed() {
  const q = normalizeForSearch(ui.search.value.trim());
  const list = (q ? entries.filter(e => normalizeForSearch(e.text).includes(q)) : entries.slice())
    .sort((a, b) => b.ts - a.ts);

  ui.feedTitle.textContent = q ? `Найдено: ${list.length}` : `Все записи · ${list.length}`;
  ui.feed.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = q ? 'Ничего не найдено.' : 'Записей ещё нет.';
    ui.feed.append(li);
    return;
  }
  for (const e of list) ui.feed.append(e.id === editingId ? editorItem(e) : entryItem(e));
}

function entryItem(e) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'entry' + (e.exportedAt ? ' exported' : '');
  b.dataset.id = e.id;
  b.setAttribute('aria-label', `${formatLocal(e.ts)}, ${e.source === 'voice' ? 'голосом' : 'текстом'}${e.exportedAt ? ', выгружено' : ''}: ${e.text}. Нажмите, чтобы изменить`);
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatShort(e.ts);
  const src = document.createElement('span');
  src.className = 'src';
  src.innerHTML = e.source === 'voice' ? ICON_VOICE : ICON_TEXT;
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.append(entryText(e));
  b.append(time, src, txt);
  li.append(b);
  return li;
}

function editorItem(e) {
  const li = document.createElement('li');
  li.className = 'editor';
  const ta = document.createElement('textarea');
  ta.value = e.text;
  ta.setAttribute('aria-label', 'Изменить запись');
  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = `${formatLocal(e.ts)} · ${e.source === 'voice' ? 'голосом' : 'текстом'}` +
    (e.exportedAt ? ` · выгружено ${formatShort(e.exportedAt)} (после правки выгрузится снова)` : '');
  const row = document.createElement('div');
  row.className = 'row';
  row.append(
    button('Сохранить', 'save', () => updateEntry(e, ta.value)),
    button('Удалить', 'danger', () => removeEntry(e)),
    button('Отмена', '', () => { editingId = null; render(); }),
  );
  li.append(ta, meta, row);
  queueMicrotask(() => { ta.focus(); li.scrollIntoView({ block: 'nearest' }); });
  return li;
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

async function updateEntry(e, newText) {
  const text = newText.trim();
  if (!text) { showToast('Текст пустой. Чтобы убрать запись, нажмите «Удалить».'); return; }
  const changed = { ...e, text, updatedAt: Date.now(), exportedAt: text === e.text ? e.exportedAt : null };
  await db.putEntry(changed);
  entries = entries.map(x => x.id === e.id ? changed : x);
  editingId = null;
  render();
  showToast('Изменено');
}

async function removeEntry(e) {
  await db.deleteEntry(e.id);
  entries = entries.filter(x => x.id !== e.id);
  editingId = null;
  render();
  showToast('Удалено', 'Отменить', async () => {
    await db.putEntry(e);
    entries.push(e);
    render();
    showToast('Запись возвращена');
  }, 7000);
}

// ---------------- Чек по QR (задача 4) ----------------
// Камера читает QR-код кассового чека встроенным распознавателем Chrome (BarcodeDetector).
// Запись — «Чек: t=…&s=…&fn=…&i=…&fp=…&n=1»: позиции и статьи подберёт компьютер.

let detector = null;       // распознаватель QR (создаётся при первом открытии)
let scanStream = null;     // видео с камеры, пока открыт сканер
let scanTimer = 0;

async function openScan() {
  if (!('BarcodeDetector' in window)) {
    showToast('Этот браузер не читает QR-коды — нужен Chrome на Android');
    return;
  }
  detector ??= new BarcodeDetector({ formats: ['qr_code'] });
  ui.scanHint.textContent = 'Наведите камеру на QR-код чека';
  ui.scanDlg.showModal();
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    if (!ui.scanDlg.open) { stopCamera(); return; }        // успели закрыть, пока камера включалась
    ui.scanVideo.srcObject = scanStream;
    ui.scanVideo.play().catch(() => {});   // не ждём: пока кадра нет, поиск просто повторяется
    scanLoop();
  } catch {
    ui.scanHint.textContent = 'Камера недоступна — снимите чек кнопкой «Фото»';
  }
}

/** Несколько раз в секунду ищем QR-код в кадре. */
async function scanLoop() {
  if (!scanStream) return;
  try {
    if (await takeCodes(await detector.detect(ui.scanVideo))) return;
  } catch { /* кадр ещё не готов — попробуем следующий */ }
  scanTimer = setTimeout(scanLoop, 250);
}

/** Найден QR-код чека → закрыть сканер и сохранить; чужой QR — подсказка. */
async function takeCodes(codes) {
  for (const c of codes) {
    const raw = (c.rawValue || '').trim();
    if (parseReceiptQr(raw)) {
      closeScan();
      await saveReceipt(raw);
      return true;
    }
  }
  if (codes.length) ui.scanHint.textContent = 'Это не QR-код кассового чека';
  return false;
}

function stopCamera() {
  clearTimeout(scanTimer);
  if (scanStream) scanStream.getTracks().forEach(t => t.stop());
  scanStream = null;
  ui.scanVideo.srcObject = null;
}
function closeScan() {
  stopCamera();
  if (ui.scanDlg.open) ui.scanDlg.close();
}

/** «Фото»: снимок камерой телефона или картинка из галереи. */
async function scanPhoto(file) {
  ui.scanHint.textContent = 'Ищу QR-код на фото…';
  try {
    const img = await createImageBitmap(file);
    if (!await takeCodes(await detector.detect(img))) ui.scanHint.textContent = 'QR-код на фото не найден — снимите ближе и ровнее';
  } catch {
    ui.scanHint.textContent = 'Не удалось открыть фото';
  }
}

async function saveReceipt(raw) {
  const text = applyTag(raw, RECEIPT_TAG);
  if (entries.some(e => e.text === text)) {
    showToast(`Этот чек уже сохранён: ${receiptLabel(raw)}`);
    return;
  }
  const now = Date.now();
  const entry = { id: newId(), ts: now, createdAt: now, updatedAt: now, text, source: 'text', exportedAt: null };
  try {
    await db.putEntry(entry);
  } catch (err) {
    showToast('Не удалось сохранить чек: ' + (err && err.message || err));
    return;
  }
  entries.push(entry);
  render();
  showToast(`Чек сохранён: ${receiptLabel(raw)}`);
}

// ---------------- Сообщения ----------------

let toastTimer = 0;
function showToast(text, actionLabel, action, ms = 3500) {
  clearTimeout(toastTimer);
  ui.toastText.textContent = text;
  ui.toastAction.hidden = !actionLabel;
  ui.toastAction.textContent = actionLabel || '';
  ui.toastAction.onclick = action ? () => { hideToast(); action(); } : null;
  ui.toast.hidden = false;
  toastTimer = setTimeout(hideToast, actionLabel ? Math.max(ms, 6000) : ms);
}
function hideToast() { ui.toast.hidden = true; }

// ---------------- Выгрузка ----------------

/** Выгрузить записи CSV: how = 'share' | 'download' | 'copy'. После удачи — отметить выгруженными. */
async function exportCsv(mode, how, from, to) {
  const list = selectForExport(entries, mode, from, to);
  if (!list.length) {
    showToast(mode === 'new' ? 'Новых записей нет — всё уже выгружено.' : 'За выбранное время записей нет.');
    return;
  }
  const csv = toCsv(list);   // колонка «выгружено» берёт прежнюю дату — считаем до отметки
  const name = `zahvat_${fileStamp()}.csv`;
  let done = false;   // 'share' | 'download' | 'copy' — чем на самом деле выгрузили
  if (how === 'share') done = await shareFile(csv, name, 'text/csv');
  else if (how === 'download') done = downloadFile(csv, name, 'text/csv;charset=utf-8') && 'download';
  else done = (await copyText(csv.replace(/^﻿/, ''))) && 'copy';
  if (done) await markExported(list, done);
}

/**
 * «Поделиться» файлом через меню Android (Telegram, почта, Диск…).
 * Если браузер не умеет делиться файлами — скачиваем. Отмена в меню «Поделиться» — не выгрузка.
 */
async function shareFile(text, name, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'share';
    } catch (err) {
      if (err && err.name === 'AbortError') { showToast('Отправка отменена — записи не отмечены.'); return false; }
      // другая ошибка — пробуем скачать
    }
  }
  return downloadFile(text, name, type) && 'download';
}

/** Скачивание: ссылка на Blob с атрибутом download. */
function downloadFile(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

/** Копирование в буфер обмена (запасной путь, если файлы не передаются). */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) showToast('Не удалось скопировать.');
    return ok;
  }
}

/** Отметить записи выгруженными и запомнить, что было раньше, — для «Отменить отметку». */
async function markExported(list, how) {
  const now = Date.now();
  const items = list.map(e => ({ id: e.id, prev: e.exportedAt || null }));
  const prevLast = (await db.getSetting('lastExportAt')) || null;
  const changed = list.map(e => ({ ...e, exportedAt: now }));
  await db.putEntries(changed);
  const byId = new Map(changed.map(e => [e.id, e]));
  entries = entries.map(e => byId.get(e.id) || e);
  await db.setSetting('lastExportAt', now);
  await db.setSetting('lastExportBatch', { at: now, prevLast, items });
  render();
  const verb = how === 'copy' ? 'Скопировано' : how === 'download' ? 'Скачано в Загрузки' : 'Отправлено';
  showToast(`${verb}: ${list.length} зап.`, 'Отменить отметку', undoExport, 8000);
}

async function undoExport() {
  const batch = await db.getSetting('lastExportBatch');
  if (!batch || !batch.items.length) { showToast('Отменять нечего.'); return; }
  const prev = new Map(batch.items.map(i => [i.id, i.prev]));
  const changed = entries.filter(e => prev.has(e.id)).map(e => ({ ...e, exportedAt: prev.get(e.id) }));
  await db.putEntries(changed);
  const byId = new Map(changed.map(e => [e.id, e]));
  entries = entries.map(e => byId.get(e.id) || e);
  await db.setSetting('lastExportAt', batch.prevLast || null);
  await db.setSetting('lastExportBatch', null);
  render();
  showToast(`Отметка снята: ${changed.length} зап. снова «новые».`);
}

// ---------------- Резервная копия ----------------

async function backupJson() {
  const data = {
    app: 'zahvat', format: 1, savedAt: new Date().toISOString(),
    entries, settings: await db.getAllSettings(),
  };
  downloadFile(JSON.stringify(data, null, 1), `zahvat_backup_${fileStamp()}.json`, 'application/json');
  await db.setSetting('lastBackupAt', Date.now());
  showToast(`Резервная копия: ${entries.length} зап. — в Загрузках.`);
}

async function restoreJson(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { showToast('Это не файл резервной копии (JSON не читается).'); return; }
  const incoming = Array.isArray(data) ? data : data && data.app === 'zahvat' && Array.isArray(data.entries) ? data.entries : null;
  if (!incoming) { showToast('В файле нет записей «Захвата».'); return; }
  // Сравниваем с тем, что лежит в базе прямо сейчас (а не со списком в памяти)
  const { toWrite, added, updated, skipped } = mergeEntries(await db.getAllEntries(), incoming);
  if (toWrite.length) await db.putEntries(toWrite);
  // Настройки из копии берём только те, которых здесь нет
  if (data.settings && typeof data.settings === 'object') {
    const current = await db.getAllSettings();
    for (const [k, v] of Object.entries(data.settings)) if (!(k in current)) await db.setSetting(k, v);
  }
  const fl = await db.getSetting('finLists');
  if (fl && fl.accounts && fl.cats) { lists = fl; renderFin(); }
  entries = await db.getAllEntries();
  render();
  showToast(`Восстановлено: добавлено ${added}, обновлено ${updated}, без изменений ${skipped}.`);
}

// ---------------- Меню и окно выгрузки ----------------

async function openMenu() {
  const fresh = entries.filter(e => !e.exportedAt).length;
  const last = await db.getSetting('lastExportAt');
  ui.menuInfo.textContent = `Новых: ${fresh} · всего: ${entries.length}\n` +
    `Последняя выгрузка: ${last ? formatShort(last) : 'ещё не было'}`;
  ui.listsInfo.textContent = lists.loadedAt
    ? `Счетов ${lists.accounts.length}, статей ${lists.cats.length} · загружено ${formatShort(lists.loadedAt)}`
    : 'Сейчас примеры — загрузите файл из модуля Финансов';
  ui.menu.hidden = false;
  ui.btnMenu.setAttribute('aria-expanded', 'true');
  ui.menu.querySelector('button').focus();
}
function closeMenu() {
  ui.menu.hidden = true;
  ui.btnMenu.setAttribute('aria-expanded', 'false');
}

function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

function openExportDialog() {
  const today = new Date();
  ui.form.from.value = isoDate(new Date(today.getFullYear(), today.getMonth(), 1));
  ui.form.to.value = isoDate(today);
  updateExportCount();
  ui.dlg.showModal();
}
function updateExportCount() {
  const mode = ui.form.mode.value;
  ui.periodBox.hidden = mode !== 'period';
  const n = selectForExport(entries, mode, ui.form.from.value, ui.form.to.value).length;
  ui.exportCount.textContent = `Записей к выгрузке: ${n}`;
}

async function onMenuAction(act) {
  closeMenu();
  try {
    if (act === 'all') openAll();
    else if (act === 'lists') ui.fileLists.click();
    else if (act === 'share' || act === 'download' || act === 'copy') await exportCsv('new', act);
    else if (act === 'period') openExportDialog();
    else if (act === 'undo') await undoExport();
    else if (act === 'backup') await backupJson();
    else if (act === 'restore') ui.file.click();
  } catch (err) {
    showToast('Ошибка: ' + (err && err.message || err));
  }
}

// ---------------- Запуск ----------------

function wire() {
  ui.text.addEventListener('input', () => {
    if (dictation.recording) dictation.resetSession();   // правка руками во время диктовки
    saveDraftSoon();
    updateSaveButton();
  });
  ui.text.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); saveEntry(); }
  });
  ui.mic.addEventListener('click', () => dictation.toggle());
  // Метки не забирают фокус у поля (клавиатура не прячется), повторное нажатие снимает выбор
  ui.tags.addEventListener('mousedown', (ev) => { if (ev.target.closest('.tag')) ev.preventDefault(); });
  ui.tags.addEventListener('click', (ev) => {
    const b = ev.target.closest('.tag');
    if (!b) return;
    setTag(b.dataset.tag === selectedTag ? null : b.dataset.tag);
    saveDraftSoon();
  });
  // «Сохранить» и «Стереть» не забирают фокус у поля — клавиатура не прыгает
  ui.save.addEventListener('mousedown', (ev) => ev.preventDefault());
  ui.save.addEventListener('click', saveEntry);
  ui.clear.addEventListener('mousedown', (ev) => ev.preventDefault());
  ui.clear.addEventListener('click', clearInput);

  // Расход: своя клавиатура (системная при нажатии прячется), счёт, статья (повторное нажатие снимает)
  ui.pad.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-key]');
    if (b) pressKey(b.dataset.key);
  });
  ui.accounts.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-name]');
    if (!b) return;
    account = b.dataset.name;
    try { localStorage.setItem(ACCOUNT_KEY, account); } catch { /* не страшно */ }
    renderFin();
  });
  ui.cats.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-name]');
    if (!b) return;
    cat = cat === b.dataset.name ? null : b.dataset.name;
    if (cat && selectedTag !== FIN_TAG) setTag(FIN_TAG);
    renderFin();
    saveDraftSoon();
  });

  // Последняя запись на главном → «Все записи» с её правкой
  ui.recent.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-id]');
    if (b) openAll(b.dataset.id);
  });
  ui.btnBack.addEventListener('click', () => history.back());
  ui.btnScan.addEventListener('click', openScan);
  ui.btnScanClose.addEventListener('click', closeScan);
  ui.scanDlg.addEventListener('close', stopCamera);          // «Назад» телефона тоже закрывает окно
  ui.btnScanPhoto.addEventListener('click', () => ui.filePhoto.click());
  ui.filePhoto.addEventListener('change', async () => {
    const f = ui.filePhoto.files[0];
    ui.filePhoto.value = '';
    if (f) await scanPhoto(f);
  });
  window.addEventListener('popstate', () => { if (!ui.allView.hidden) closeAll(); });
  ui.search.addEventListener('input', () => { editingId = null; renderFeed(); });

  ui.feed.addEventListener('click', (ev) => {
    const b = ev.target.closest('.entry');
    if (b) { editingId = b.dataset.id; render(); }
  });

  ui.btnMenu.addEventListener('click', () => (ui.menu.hidden ? openMenu() : closeMenu()));
  ui.menu.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]');
    if (b) onMenuAction(b.dataset.act);
  });
  document.addEventListener('click', (ev) => {
    if (!ui.menu.hidden && !ev.target.closest('.menu-wrap')) closeMenu();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !ui.menu.hidden) { closeMenu(); ui.btnMenu.focus(); }
  });

  ui.form.addEventListener('change', updateExportCount);
  ui.form.addEventListener('submit', async (ev) => {
    const how = ev.submitter && ev.submitter.value;
    if (!how || how === 'cancel') return;   // окно закроется само (method="dialog")
    const { mode, from, to } = ui.form;
    try { await exportCsv(mode.value, how, from.value, to.value); }
    catch (err) { showToast('Ошибка: ' + (err && err.message || err)); }
  });

  ui.fileLists.addEventListener('change', async () => {
    const f = ui.fileLists.files[0];
    ui.fileLists.value = '';
    if (f) {
      try { await loadLists(f); }
      catch (err) { showToast('Не удалось загрузить: ' + (err && err.message || err)); }
    }
  });

  ui.file.addEventListener('change', async () => {
    const f = ui.file.files[0];
    ui.file.value = '';
    if (f) {
      try { await restoreJson(f); }
      catch (err) { showToast('Не удалось восстановить: ' + (err && err.message || err)); }
    }
  });

  // Черновик — сразу на диск, когда приложение сворачивают или закрывают
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveDraftNow();
    else render();   // мог смениться день
  });
  window.addEventListener('pagehide', saveDraftNow);
  window.addEventListener('online', updateStatus);
  window.addEventListener('offline', updateStatus);
}

async function init() {
  wire();
  restoreDraft();
  renderFin();
  updateStatus();
  // Просим браузер не стирать базу при нехватке места
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  try {
    const saved = await db.getSetting('finLists');
    if (saved && saved.accounts && saved.cats) lists = saved;
  } catch { /* остаются примеры */ }
  renderFin();
  try {
    entries = await db.getAllEntries();
  } catch (err) {
    showToast('База недоступна: ' + (err && err.message || err) + '. Запишите текст и сделайте резервную копию позже.');
  }
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* без офлайна, но работает */ });
  }
}

init();
