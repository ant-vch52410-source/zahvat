// Чистые функции «Захвата» (задачи 1, 2, 3): CSV, даты, отбор записей, объединение резервных копий, метки, расходы кнопками.
// Без обращения к странице и базе — поэтому их проверяет tests.html.

/** Колонки CSV — порядок фиксирован, по нему работает разбор на компьютере. */
export const CSV_COLUMNS = ['id', 'дата_время', 'ts_utc', 'текст', 'источник', 'выгружено'];

const BOM = '﻿';   // метка UTF-8: по ней Excel понимает, что файл в UTF-8 (кириллица не «ломается»)
const SEP = ';';        // русский Excel по умолчанию делит колонки точкой с запятой
const EOL = '\r\n';     // перевод строки Windows

const pad = (n, len = 2) => String(n).padStart(len, '0');

/** Местное время устройства в виде «ДД.ММ.ГГГГ ЧЧ:ММ:СС» — Excel сам распознаёт это как дату. */
export function formatLocal(ts) {
  if (ts == null || ts === '') return '';
  const d = new Date(ts);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Короткое время для ленты: «14:20». */
export function formatTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Короткая дата для поиска и меню: «30.09 21:15». */
export function formatShort(ts) {
  const d = new Date(ts);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Метка для имени файла: «2026-10-02_1430» (только ASCII). */
export function fileStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
         `${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** Один и тот же календарный день по местному времени. */
export function isSameDay(a, b) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * Одно поле CSV.
 * 1) Защита от «CSV-инъекции»: текст, начинающийся с = + - @ (и табуляции/возврата каретки),
 *    Excel может принять за формулу — ставим впереди апостроф.
 * 2) Если в поле есть ; кавычка или перевод строки — берём в кавычки, внутренние кавычки удваиваем.
 *    Переводы строк остаются внутри кавычек: Excel показывает их как перенос внутри ячейки.
 */
export function csvField(value, { guard = false } = {}) {
  let s = value == null ? '' : String(value);
  if (guard && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[;"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Строка CSV для одной записи. */
export function csvRow(e) {
  return [
    csvField(e.id),
    csvField(formatLocal(e.ts)),
    csvField(new Date(e.ts).toISOString()),
    csvField(e.text, { guard: true }),        // только текст пишет человек — его и защищаем
    csvField(e.source),
    csvField(e.exportedAt ? formatLocal(e.exportedAt) : ''),
  ].join(SEP);
}

/** Весь файл CSV: BOM + заголовок + записи по возрастанию времени. */
export function toCsv(entries) {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const lines = [CSV_COLUMNS.join(SEP), ...sorted.map(csvRow)];
  return BOM + lines.join(EOL) + EOL;
}

/**
 * Разбор CSV обратно в строки (нужен тестам: проверить, что в каждой строке одинаковое число колонок).
 * Понимает поля в кавычках с ; и переводами строк внутри.
 */
export function parseCsv(text) {
  if (text.startsWith(BOM)) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === SEP) { row.push(field); field = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Какие записи выгружать.
 * mode: 'new' — ещё не выгружались; 'period' — с даты from по дату to включительно ('ГГГГ-ММ-ДД'); 'all' — все.
 */
export function selectForExport(entries, mode, from, to) {
  if (mode === 'all') return [...entries];
  if (mode === 'period') {
    const start = from ? dayStart(from) : -Infinity;
    const end = to ? dayStart(to) + 24 * 3600 * 1000 : Infinity;   // «по» — включительно
    return entries.filter(e => e.ts >= start && e.ts < end);
  }
  return entries.filter(e => !e.exportedAt);
}

/** Начало дня 'ГГГГ-ММ-ДД' по местному времени, в мс. */
function dayStart(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * Объединение резервной копии с базой по id, без дублей.
 * Если запись есть и там и там — остаётся более свежая (по updatedAt).
 * Возвращает записи, которые нужно записать в базу, и счётчики для сообщения.
 */
export function mergeEntries(existing, incoming) {
  const byId = new Map(existing.map(e => [e.id, e]));
  const toWrite = [];
  let added = 0, updated = 0, skipped = 0;
  for (const raw of incoming) {
    const e = normalizeEntry(raw);
    if (!e) { skipped++; continue; }
    const old = byId.get(e.id);
    if (!old) { added++; toWrite.push(e); byId.set(e.id, e); }
    else if ((e.updatedAt || 0) > (old.updatedAt || 0)) { updated++; toWrite.push(e); byId.set(e.id, e); }
    else skipped++;
  }
  return { toWrite, added, updated, skipped };
}

/** Проверка записи из файла: без id, текста или времени — не берём. */
export function normalizeEntry(e) {
  if (!e || typeof e.id !== 'string' || !e.id || typeof e.text !== 'string' || !Number.isFinite(e.ts)) return null;
  return {
    id: e.id,
    ts: e.ts,
    createdAt: Number.isFinite(e.createdAt) ? e.createdAt : e.ts,
    updatedAt: Number.isFinite(e.updatedAt) ? e.updatedAt : e.ts,
    text: e.text,
    source: e.source === 'voice' ? 'voice' : 'text',
    exportedAt: Number.isFinite(e.exportedAt) ? e.exportedAt : null,
  };
}

/**
 * Метка перед текстом: «Финансы» + «виза 500» → «Финансы: виза 500».
 * Без метки — текст как есть; если текст уже начинается с этой метки — второй раз не добавляем.
 */
export function applyTag(text, tag) {
  if (!tag) return text;
  const prefix = tag + ': ';
  return text.startsWith(prefix) ? text : prefix + text;
}

/** Разделить «Финансы: текст» на метку и текст (для ленты). Неизвестная метка — весь текст как есть. */
export function splitTag(text, tags) {
  const i = text.indexOf(': ');
  if (i > 0 && tags.includes(text.slice(0, i))) return { tag: text.slice(0, i), rest: text.slice(i + 2) };
  return { tag: '', rest: text };
}

/** Дописать фразу к тексту через пробел (без двойных пробелов). */
export function appendPhrase(base, phrase) {
  phrase = (phrase || '').trim();
  if (!phrase) return base;
  if (!base || /\s$/.test(base)) return base + phrase;
  return base + ' ' + phrase;
}

/**
 * Собрать текст из результатов распознавания одной сессии.
 * Chrome на Android в режиме continuous иногда присылает «накопительные» результаты:
 * следующий кусок уже содержит предыдущий. Тогда не дописываем, а заменяем — иначе слова задвоятся.
 */
export function joinTranscripts(parts) {
  let acc = '';
  for (const p of parts) {
    const t = (p || '').trim();
    if (!t) continue;
    const a = acc.toLowerCase(), b = t.toLowerCase();
    if (a && b.startsWith(a)) acc = t;          // новый кусок включает старый
    else if (a.endsWith(b)) continue;           // повтор того же куска
    else acc = appendPhrase(acc, t);
  }
  return acc;
}

/** Для поиска: регистр и «ё» не важны. */
export function normalizeForSearch(s) {
  return (s || '').toLowerCase().replace(/ё/g, 'е');
}

// ---------------- Расходы кнопками (задача 3) ----------------

/** Сколько кнопок помещается на экране 360×720: счета — 2, статьи — 9 (остальные из файла не показываются). */
export const MAX_ACCOUNTS = 2;
export const MAX_CATS = 9;

/** Счета и статьи, пока файл из модуля Финансов не загружен. */
export const DEFAULT_LISTS = {
  accounts: ['Мир', 'Виза'],
  cats: ['Продукты', 'Бензин', 'Кафе', 'Дом', 'Здоровье', 'Связь', 'Транспорт', 'Коммуналка', 'Прочее'],
};

/**
 * Разобрать txt из модуля Финансов:
 *   [Счета]      ← раздел
 *   Мир          ← по одному названию в строке, порядок = порядок кнопок
 *   [Статьи]
 *   Продукты
 * Пустые строки и строки с # пропускаются, повторы убираются. Вернёт { accounts, cats } или ошибку в error.
 */
export function parseLists(text) {
  const out = { accounts: [], cats: [] };
  let section = null;
  for (let line of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const head = line.match(/^\[(.+)\]$/);
    if (head) {
      const name = head[1].trim().toLowerCase();
      section = name === 'счета' ? 'accounts' : name === 'статьи' ? 'cats' : null;
      continue;
    }
    if (section && !out[section].includes(line)) out[section].push(line);
  }
  if (!out.accounts.length || !out.cats.length) {
    return { ...out, error: 'В файле нужны разделы [Счета] и [Статьи], в каждом хотя бы одна строка.' };
  }
  return out;
}

/**
 * Нажатие кнопки цифровой клавиатуры: '0'–'9', ',' или '⌫'.
 * Не больше 9 цифр до запятой и 2 после, одна запятая, без ведущих нулей («05» → «5»).
 */
export function typeAmount(cur, key) {
  cur = cur || '';
  if (key === '⌫') return cur.slice(0, -1);
  const [whole, frac] = cur.split(',');
  if (key === ',') return cur.includes(',') ? cur : (cur || '0') + ',';
  if (!/^\d$/.test(key)) return cur;
  if (frac !== undefined) return frac.length >= 2 ? cur : cur + key;
  if (whole === '0') return key;
  return whole.length >= 9 ? cur : cur + key;
}

/** Сумма для экрана: «12500,5» → «12 500,5» (тонкие пробелы между тысячами). */
export function formatAmount(raw) {
  if (!raw) return '0';
  const [whole, frac] = raw.split(',');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return frac === undefined ? grouped : grouped + ',' + frac;
}

/**
 * Текст расхода в том же виде, что и голосом: «мир 800 продукты, Пятёрочка у дома».
 * Метку «Финансы: » ставит applyTag. Висячая запятая у суммы («800,») отбрасывается.
 */
export function financeText({ account, amount, cat, note }) {
  const sum = (amount || '').replace(/,$/, '');
  const head = [account && account.toLowerCase(), sum, cat && cat.toLowerCase()].filter(Boolean).join(' ');
  note = (note || '').trim();
  return note ? `${head}, ${note}` : head;
}

// ---------------- Чек по QR (задача 4) ----------------

export const RECEIPT_TAG = 'Чек';

/**
 * QR-код кассового чека: «t=20261006T1942&s=1629.40&fn=…&i=…&fp=…&n=1» → { ts, sum, fn, i, fp, n }.
 * Не чек (нет даты, суммы или номеров ФН/ФД/ФП) — null.
 */
export function parseReceiptQr(raw) {
  const p = new URLSearchParams((raw || '').trim());
  const t = (p.get('t') || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/);
  const sum = Number(p.get('s'));
  if (!t || !(sum > 0) || !p.get('fn') || !p.get('i') || !p.get('fp')) return null;
  const ts = new Date(+t[1], +t[2] - 1, +t[3], +t[4], +t[5], +(t[6] || 0)).getTime();
  return { ts, sum, fn: p.get('fn'), i: p.get('i'), fp: p.get('fp'), n: p.get('n') || '1' };
}

/** Чек для ленты: «06.10 19:42 · 1 629,40 ₽»; не чек — текст как есть. */
export function receiptLabel(raw) {
  const r = parseReceiptQr(raw);
  if (!r) return raw;
  const [whole, frac] = r.sum.toFixed(2).split('.');
  return `${formatShort(r.ts)} · ${formatAmount(whole)},${frac} ₽`;
}
