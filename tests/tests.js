// Тесты чистых функций «Захвата» (задачи 1, 2). Запуск: открыть tests/tests.html через локальный сервер.

import {
  toCsv, csvField, parseCsv, CSV_COLUMNS, formatLocal, fileStamp, selectForExport,
  mergeEntries, normalizeEntry, joinTranscripts, appendPhrase, normalizeForSearch, isSameDay,
  applyTag, splitTag,
} from '../core.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, msg: err.message }); }
}
function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what} ожидалось ${e}, получено ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what); }

// Записи для проверок: местное время, чтобы не зависеть от пояса компьютера
const t = (y, mo, d, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const E = (id, ts, text, extra = {}) => ({ id, ts, createdAt: ts, updatedAt: ts, text, source: 'text', exportedAt: null, ...extra });

const sample = [
  E('b', t(2026, 10, 2, 14, 20, 5), 'виза 500 кальян', { source: 'voice' }),
  E('a', t(2026, 10, 1, 9, 5, 0), 'мир 800 еда'),
  E('c', t(2026, 10, 2, 15, 0, 0), 'строка 1\nстрока 2; с точкой с запятой и "кавычками"'),
  E('d', t(2026, 10, 2, 16, 0, 0), '=СУММ(A1:A2)', { exportedAt: t(2026, 10, 2, 17, 0, 0) }),
  E('e', t(2026, 10, 2, 16, 30, 0), '-500 возврат'),
  E('f', t(2026, 10, 2, 16, 31, 0), '+7 999 123'),
  E('g', t(2026, 10, 2, 16, 32, 0), '@напомнить'),
];

// ---- CSV ----
test('CSV начинается с BOM и заголовка', () => {
  const csv = toCsv(sample);
  eq(csv.charCodeAt(0), 0xFEFF, 'BOM:');
  eq(csv.slice(1).split('\r\n')[0], CSV_COLUMNS.join(';'), 'заголовок:');
});

test('CSV: строки через \\r\\n, одиночных \\n вне кавычек нет', () => {
  const csv = toCsv([E('x', t(2026, 1, 1), 'простой текст')]);
  ok(csv.endsWith('\r\n'), 'файл должен заканчиваться \\r\\n');
  ok(!/[^\r]\n/.test(csv), 'есть \\n без \\r');
});

test('CSV: во всех строках одинаковое число колонок', () => {
  const rows = parseCsv(toCsv(sample));
  eq(rows.length, sample.length + 1, 'строк:');
  for (const r of rows) eq(r.length, CSV_COLUMNS.length, 'колонок:');
});

test('CSV: сортировка по времени по возрастанию', () => {
  const rows = parseCsv(toCsv(sample)).slice(1);
  eq(rows.map(r => r[0]), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('CSV: кириллица, перевод строки, ; и кавычки сохраняются', () => {
  const rows = parseCsv(toCsv(sample));
  const c = rows.find(r => r[0] === 'c');
  eq(c[3], 'строка 1\nстрока 2; с точкой с запятой и "кавычками"');
  eq(rows.find(r => r[0] === 'b')[3], 'виза 500 кальян');
});

test('CSV: экранирование одного поля', () => {
  eq(csvField('a;b'), '"a;b"');
  eq(csvField('он сказал "да"'), '"он сказал ""да"""');
  eq(csvField('две\nстроки'), '"две\nстроки"');
  eq(csvField('просто'), 'просто');
  eq(csvField(null), '');
});

test('CSV: защита от формул (= + - @)', () => {
  const rows = parseCsv(toCsv(sample));
  const text = id => rows.find(r => r[0] === id)[3];
  eq(text('d'), "'=СУММ(A1:A2)");
  eq(text('e'), "'-500 возврат");
  eq(text('f'), "'+7 999 123");
  eq(text('g'), "'@напомнить");
  eq(text('a'), 'мир 800 еда', 'обычный текст без апострофа:');
});

test('CSV: дата, ts_utc, источник, выгружено', () => {
  const rows = parseCsv(toCsv(sample));
  const b = rows.find(r => r[0] === 'b');
  eq(b[1], '02.10.2026 14:20:05');
  eq(b[2], new Date(t(2026, 10, 2, 14, 20, 5)).toISOString());
  ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(b[2]), 'ts_utc не ISO');
  eq(b[4], 'voice');
  eq(b[5], '', 'не выгружалось:');
  eq(rows.find(r => r[0] === 'd')[5], '02.10.2026 17:00:00');
});

test('Пустой список — только заголовок', () => {
  eq(toCsv([]), '\uFEFF' + CSV_COLUMNS.join(';') + '\r\n');
});

// ---- Даты ----
test('formatLocal: ДД.ММ.ГГГГ ЧЧ:ММ:СС', () => {
  eq(formatLocal(t(2026, 3, 7, 8, 4, 9)), '07.03.2026 08:04:09');
  eq(formatLocal(null), '');
});

test('fileStamp: только ASCII, ГГГГ-ММ-ДД_ЧЧММ', () => {
  eq(fileStamp(new Date(2026, 9, 2, 9, 5)), '2026-10-02_0905');
});

test('isSameDay', () => {
  ok(isSameDay(t(2026, 10, 2, 0, 0, 1), t(2026, 10, 2, 23, 59, 59)), 'один день');
  ok(!isSameDay(t(2026, 10, 2, 23, 59), t(2026, 10, 3, 0, 1)), 'разные дни');
});

// ---- Отбор ----
test('Отбор: только новые', () => {
  eq(selectForExport(sample, 'new').map(e => e.id).sort(), ['a', 'b', 'c', 'e', 'f', 'g']);
});
test('Отбор: всё', () => {
  eq(selectForExport(sample, 'all').length, sample.length);
});
test('Отбор: период включительно по последний день', () => {
  eq(selectForExport(sample, 'period', '2026-10-01', '2026-10-01').map(e => e.id), ['a']);
  eq(selectForExport(sample, 'period', '2026-10-02', '2026-10-02').length, 6);
  eq(selectForExport(sample, 'period', '2026-09-01', '2026-09-30').length, 0);
});

// ---- Резервная копия ----
test('JSON: копия → пустая база восстанавливается полностью', () => {
  const back = JSON.parse(JSON.stringify({ app: 'zahvat', entries: sample }));
  const r = mergeEntries([], back.entries);
  eq(r.added, sample.length);
  eq(r.toWrite.map(e => e.id).sort(), sample.map(e => e.id).sort());
  eq(r.toWrite.find(e => e.id === 'd'), sample.find(e => e.id === 'd'), 'запись d:');
});

test('JSON: повторное восстановление не даёт дублей', () => {
  const r = mergeEntries(sample, sample);
  eq([r.added, r.updated, r.skipped, r.toWrite.length], [0, 0, sample.length, 0]);
});

test('JSON: более свежая версия записи побеждает, старая — нет', () => {
  const newer = { ...sample[0], text: 'исправлено', updatedAt: sample[0].updatedAt + 1000 };
  const older = { ...sample[1], text: 'старое', updatedAt: sample[1].updatedAt - 1000 };
  const r = mergeEntries(sample, [newer, older]);
  eq([r.added, r.updated, r.skipped], [0, 1, 1]);
  eq(r.toWrite[0].text, 'исправлено');
});

test('JSON: битые записи пропускаются', () => {
  const r = mergeEntries([], [{ id: 'x' }, null, { id: 'y', text: 'ok', ts: 5 }]);
  eq([r.added, r.skipped], [1, 2]);
  eq(normalizeEntry({ id: 'y', text: 'ok', ts: 5, source: 'zzz' }).source, 'text');
});

// ---- Голос ----
test('Голос: куски сессии склеиваются через пробел', () => {
  eq(joinTranscripts(['мир 800', 'еда']), 'мир 800 еда');
});
test('Голос: накопительные результаты Android не задваиваются', () => {
  eq(joinTranscripts(['виза 500', 'виза 500 кальян']), 'виза 500 кальян');
  eq(joinTranscripts(['кальян', 'кальян']), 'кальян');
});
test('appendPhrase: без двойных пробелов', () => {
  eq(appendPhrase('', 'раз'), 'раз');
  eq(appendPhrase('раз', ' два '), 'раз два');
  eq(appendPhrase('раз ', 'два'), 'раз два');
  eq(appendPhrase('раз', ''), 'раз');
});

// ---- Метки ----
test('Метка: «Финансы» + текст → «Финансы: текст»', () => {
  eq(applyTag('виза 500 кальян', 'Финансы'), 'Финансы: виза 500 кальян');
  eq(applyTag('просто текст', null), 'просто текст');
  eq(applyTag('Идея: уже с меткой', 'Идея'), 'Идея: уже с меткой', 'без двойной метки:');
});
test('Метка: разбор для ленты', () => {
  const tags = ['Финансы', 'Идея', 'Задача', 'Заметка'];
  eq(splitTag('Финансы: мир 800 еда', tags), { tag: 'Финансы', rest: 'мир 800 еда' });
  eq(splitTag('время: 14:00 встреча', tags), { tag: '', rest: 'время: 14:00 встреча' });
  eq(splitTag('без метки', tags), { tag: '', rest: 'без метки' });
});

// ---- Поиск ----
test('Поиск: регистр и ё не важны', () => {
  eq(normalizeForSearch('ЁЛКА'), 'елка');
});

// ---- Вывод ----
const failed = results.filter(r => !r.ok);
const out = document.getElementById('out');
for (const r of results) {
  const li = document.createElement('li');
  li.className = r.ok ? 'ok' : 'fail';
  li.textContent = (r.ok ? '✓ ' : '✗ ') + r.name + (r.ok ? '' : ' — ' + r.msg);
  out.append(li);
}
const sum = document.getElementById('summary');
sum.textContent = failed.length ? `Ошибок: ${failed.length} из ${results.length}` : `Все ${results.length} тестов пройдены`;
sum.className = failed.length ? 'fail' : 'ok';
document.body.dataset.done = failed.length ? 'fail' : 'ok';
