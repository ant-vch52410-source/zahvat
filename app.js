// «Захват» — экран и действия (задача 1): ввод, лента дня, поиск, правка, выгрузка CSV, резервная копия.

import * as db from './db.js';
import {
  toCsv, selectForExport, mergeEntries, formatTime, formatShort, formatLocal,
  fileStamp, isSameDay, appendPhrase, normalizeForSearch,
} from './core.js';
import { Dictation } from './speech.js';

const $ = (id) => document.getElementById(id);
const ui = {
  text: $('text'), interim: $('interim'), mic: $('btnMic'), save: $('btnSave'), status: $('status'),
  btnSearch: $('btnSearch'), searchBox: $('searchBox'), search: $('search'),
  btnMenu: $('btnMenu'), menu: $('menu'), menuInfo: $('menuInfo'),
  feedTitle: $('feedTitle'), feed: $('feed'),
  toast: $('toast'), toastText: $('toastText'), toastAction: $('toastAction'),
  dlg: $('exportDlg'), form: $('exportForm'), periodBox: $('periodBox'), exportCount: $('exportCount'),
  file: $('fileRestore'),
};

const DRAFT_KEY = 'zahvat.draft';   // черновик поля — в localStorage: пишется мгновенно и переживает закрытие

let entries = [];          // все записи в памяти (их немного, так проще и быстрее)
let draftVoice = false;    // в текущем тексте есть надиктованное → источник 'voice'
let editingId = null;      // какую запись сейчас правим
let voiceBase = '';        // текст поля на момент начала сессии распознавания
let speechError = '';      // последнее сообщение об ошибке голоса

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

/** Строка состояния под кнопками: ошибка голоса, запись или отсутствие сети. */
function updateStatus() {
  let msg = speechError;
  if (!msg && dictation.recording) msg = navigator.onLine ? 'Слушаю… Нажмите микрофон ещё раз, чтобы остановить.' : '';
  if (!msg && !navigator.onLine) msg = 'Нет сети: голосовой ввод Chrome не работает, текст сохраняется как обычно.';
  ui.status.textContent = msg;
  ui.status.classList.toggle('box', !!speechError || !navigator.onLine);
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
    if (ui.text.value) localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: ui.text.value, voice: draftVoice }));
    else localStorage.removeItem(DRAFT_KEY);
  } catch { /* хранилище недоступно — не страшно, база записей отдельно */ }
}
function restoreDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (d && d.text) { ui.text.value = d.text; draftVoice = !!d.voice; }
  } catch { /* битый черновик — пропускаем */ }
}

// ---------------- Сохранение ----------------

function updateSaveButton() {
  ui.save.disabled = !(ui.text.value.trim() || ui.interim.textContent.trim());
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // запасной вариант для старых браузеров
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

async function saveEntry() {
  if (dictation.recording || ui.interim.textContent) {
    // Недоговорённое (серый текст) тоже сохраняем, запись голоса останавливаем
    const pending = ui.interim.textContent;
    dictation.cancel();
    if (pending) { ui.text.value = appendPhrase(ui.text.value, pending); draftVoice = true; }
  }
  const text = ui.text.value.trim();
  if (!text) return;
  const now = Date.now();
  const entry = {
    id: newId(), ts: now, createdAt: now, updatedAt: now,
    text, source: draftVoice ? 'voice' : 'text', exportedAt: null,
  };
  // Поле очищаем сразу: если начать печатать следующую запись, пока идёт запись в базу, она не пропадёт
  ui.text.value = '';
  draftVoice = false;
  updateSaveButton();
  try {
    await db.putEntry(entry);
  } catch (err) {
    ui.text.value = ui.text.value ? text + '\n' + ui.text.value : text;   // возвращаем текст в поле
    draftVoice = entry.source === 'voice';
    saveDraftNow();
    updateSaveButton();
    showToast('Не удалось сохранить: ' + (err && err.message || err) + '. Текст остался в поле.');
    return;
  }
  saveDraftNow();   // черновик стираем только после удачной записи
  entries.push(entry);
  render();
  showToast('Сохранено');
}

// ---------------- Лента ----------------

function render() {
  const q = normalizeForSearch(ui.search.value.trim());
  const searching = !ui.searchBox.hidden && q;
  const now = Date.now();
  const list = (searching
    ? entries.filter(e => normalizeForSearch(e.text).includes(q))
    : entries.filter(e => isSameDay(e.ts, now))
  ).sort((a, b) => b.ts - a.ts);

  ui.feedTitle.textContent = searching ? `Найдено: ${list.length}` : `Сегодня · ${list.length}`;
  ui.feed.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = searching ? 'Ничего не найдено.' : 'Сегодня записей ещё нет.';
    ui.feed.append(li);
    return;
  }
  for (const e of list) ui.feed.append(e.id === editingId ? editorItem(e) : entryItem(e, searching));
}

function entryItem(e, withDate) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'entry' + (e.exportedAt ? ' exported' : '');
  b.dataset.id = e.id;
  b.setAttribute('aria-label', `${formatLocal(e.ts)}, ${e.source === 'voice' ? 'голосом' : 'текстом'}${e.exportedAt ? ', выгружено' : ''}: ${e.text}. Нажмите, чтобы изменить`);
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = withDate ? formatShort(e.ts) : formatTime(e.ts);
  const src = document.createElement('span');
  src.className = 'src';
  src.innerHTML = e.source === 'voice' ? ICON_VOICE : ICON_TEXT;
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = e.text;
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
  queueMicrotask(() => ta.focus());
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
    if (act === 'share' || act === 'download' || act === 'copy') await exportCsv('new', act);
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
  // Кнопка «Сохранить» не забирает фокус у поля — клавиатура не прыгает
  ui.save.addEventListener('mousedown', (ev) => ev.preventDefault());
  ui.save.addEventListener('click', saveEntry);

  ui.btnSearch.addEventListener('click', () => {
    const open = ui.searchBox.hidden;
    ui.searchBox.hidden = !open;
    ui.btnSearch.setAttribute('aria-expanded', String(open));
    if (open) ui.search.focus(); else ui.search.value = '';
    render();
  });
  ui.search.addEventListener('input', render);

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
  updateSaveButton();
  updateStatus();
  // Просим браузер не стирать базу при нехватке места
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
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
