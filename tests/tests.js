// Тесты чистых функций «Захвата» (задачи 1, 2, 3, 4). Запуск: открыть tests/tests.html через локальный сервер.

import {
  toCsv, csvField, parseCsv, CSV_COLUMNS, formatLocal, fileStamp, selectForExport,
  mergeEntries, normalizeEntry, joinTranscripts, appendPhrase, normalizeForSearch, isSameDay,
  applyTag, splitTag, parseLists, typeAmount, formatAmount, financeText, parseReceiptQr, receiptLabel,
} from '../core.js';
import { Dictation } from '../speech.js';

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
  eq(joinTranscripts(['кальян', 'кальян']), 'кальян кальян', 'отдельные одинаковые фразы сохраняются:');
});
test('appendPhrase: без двойных пробелов', () => {
  eq(appendPhrase('', 'раз'), 'раз');
  eq(appendPhrase('раз', ' два '), 'раз два');
  eq(appendPhrase('раз ', 'два'), 'раз два');
  eq(appendPhrase('раз', ''), 'раз');
});

// Ответы браузера проверяем без микрофона: подставляем управляемый распознаватель.
function withDictation(fn, initial = '') {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'SpeechRecognition');
  const instances = [];
  class FakeRecognition {
    constructor() { instances.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
    result(parts, resultIndex = 0) {
      this.onresult({ resultIndex, results: parts.map(([text, final]) =>
        Object.assign([{ transcript: text }], { isFinal: final })) });
    }
    end() { this.onend(); }
  }
  Object.defineProperty(window, 'SpeechRecognition', { value: FakeRecognition, writable: true, configurable: true });
  let text = initial, base = '', interim = '', bases = 0;
  const errors = [];
  const d = new Dictation({
    onSessionStart() { base = text; bases++; },
    onFinal(phrase) { text = appendPhrase(base, phrase); },
    onInterim(phrase) { interim = phrase; }, onState() {}, onError(e) { errors.push(e); },
  });
  const state = { d, instances, errors, get text() { return text; }, set text(t) { text = t; },
    get interim() { return interim; }, get bases() { return bases; } };
  try { d.start(); fn(state); }
  finally {
    d.cancel();
    if (descriptor) Object.defineProperty(window, 'SpeechRecognition', descriptor);
    else delete window.SpeechRecognition;
  }
}

test('Голос: перекрытие нескольких слов и новая пунктуация', () => {
  eq(joinTranscripts(['сегодня купил продукты и заехал домой', 'заехал домой потом позвонил другу']),
    'сегодня купил продукты и заехал домой потом позвонил другу');
  eq(joinTranscripts(['купил хлеб молоко', 'Купил хлеб, молоко и сыр']), 'Купил хлеб, молоко и сыр');
  eq(joinTranscripts(['всё готово', 'Все готово, можно ехать']), 'Все готово, можно ехать');
});
test('Голос: намеренные повторы слов и одинаковых фраз не удаляются', () => {
  eq(joinTranscripts(['нет', 'нет']), 'нет нет');
  eq(joinTranscripts(['очень', 'очень хорошо']), 'очень очень хорошо', 'намеренный повтор:');
  eq(joinTranscripts(['хочу домой', 'хочу домой']), 'хочу домой хочу домой');
  withDictation(s => {
    s.d.rec.result([['нет', true], ['нет', true]]);
    eq(s.text, 'нет нет', 'разные индексы — отдельные слова:');
  });
});
test('Голос: режим отдельных фраз и повторный start', () => withDictation(s => {
  eq(s.d.rec.continuous, false);
  eq(s.d.rec.lang, 'ru-RU');
  s.d.start();
  eq(s.instances.length, 1);
}));
test('Голос: длинная диктовка и 100 повторных событий не размножают текст', () => withDictation(s => {
  const phrase = Array.from({ length: 90 }, (_, i) => 'слово' + i).join(' ');
  for (let i = 0; i < 100; i++) s.d.rec.result([[phrase, true]]);
  eq(s.text, phrase);
}));
test('Голос: resultIndex обновляет нужный фрагмент', () => withDictation(s => {
  s.d.rec.result([['купил хлеб', true], ['и', false]]);
  s.d.rec.result([['купил хлеб', true], ['и молоко', false]], 1);
  eq(s.text, 'купил хлеб'); eq(s.interim, 'и молоко');
  s.d.rec.result([['купил хлеб', true], ['и молоко', true]], 1);
  eq(s.text, 'купил хлеб и молоко'); eq(s.interim, '');
}));
test('Голос: промежуточный текст заменяется и может исчезнуть', () => withDictation(s => {
  s.d.rec.result([['заехать', false]]);
  s.d.rec.result([['заехать домой', false]]);
  eq(s.text, ''); eq(s.interim, 'заехать домой');
  s.d.rec.result([]);
  eq(s.interim, '');
  s.d.finish(); eq(s.text, '');
}));
test('Голос: накопительный interim сохраняется один раз с новой пунктуацией', () => withDictation(s => {
  s.d.rec.result([['купил хлеб молоко', true], ['Купил хлеб, молоко и сыр', false]]);
  eq(s.interim, 'и сыр');
  s.d.finish();
  eq(s.text, 'Купил хлеб, молоко и сыр'); eq(s.interim, '');
  eq(s.d.recording, false);
}));
test('Голос: частичное перекрытие окончательных фрагментов', () => withDictation(s => {
  s.d.rec.result([['сегодня заехал домой', true], ['заехал домой потом позвонил другу', true]]);
  eq(s.text, 'сегодня заехал домой потом позвонил другу');
}));
test('Голос: перезапуски не меняют базу поля и не повторяют накопительную фразу', () => withDictation(s => {
  const first = s.d.rec;
  first.result([['сегодня купил продукты', true]]); first.end();
  s.d.rec.result([['сегодня купил продукты и заехал домой', true]]);
  eq(s.text, 'Заметка: сегодня купил продукты и заехал домой');
  eq(s.bases, 1);
  first.result([['поздний старый ответ', true]]); first.end();
  eq(s.text, 'Заметка: сегодня купил продукты и заехал домой');
}, 'Заметка:'));
test('Голос: паузы между 12 короткими фразами не вызывают защиту от сбоев', () => withDictation(s => {
  for (let i = 0; i < 12; i++) {
    s.d.rec.result([['фраза' + i, true]]); s.d.rec.end();
  }
  eq(s.errors, []); eq(s.d.recording, true);
  eq(s.text.split(' ').length, 12);
}));
test('Голос: после паузы сохраняется последнее предварительное распознавание', () => withDictation(s => {
  s.d.rec.result([['успеть заехать домой', false]]); s.d.rec.end();
  eq(s.text, 'успеть заехать домой'); eq(s.interim, '');
  s.d.rec.result([['потом позвонить другу', true]]);
  eq(s.text, 'успеть заехать домой потом позвонить другу');
}));
test('Голос: стоп принимает итоговый ответ без нового запуска', () => withDictation(s => {
  const rec = s.d.rec;
  rec.result([['купил', false]]); s.d.stop();
  rec.result([['купил хлеб', true]]); rec.end();
  eq(s.text, 'купил хлеб'); eq(s.instances.length, 1); eq(s.d.recording, false);
}));
test('Голос: сохранение сразу после стопа учитывает серый текст', () => withDictation(s => {
  const rec = s.d.rec;
  rec.result([['купил хлеб', false]]); s.d.stop();
  eq(s.d.recording, true, 'результат ещё ожидается:');
  s.d.finish();
  rec.result([['запоздалый ответ', true]]); rec.end();
  eq(s.text, 'купил хлеб'); eq(s.instances.length, 1);
}));
test('Голос: ручная правка не отменяется запоздалыми ответами', () => withDictation(s => {
  const rec = s.d.rec;
  rec.result([['неверное слово', true]]);
  s.text = 'исправленный текст'; s.d.resetSession();
  rec.result([['неверное слово снова', true]]); rec.end();
  s.d.rec.result([['продолжение', true]]);
  eq(s.text, 'исправленный текст продолжение');
}));
test('Голос: cancel отбрасывает ответы и не перезапускает запись', () => withDictation(s => {
  const rec = s.d.rec;
  rec.result([['не сохранять', false]]); s.d.cancel();
  rec.result([['не сохранять', true]]); rec.end();
  eq(s.text, ''); eq(s.interim, ''); eq(s.instances.length, 1);
}));
test('Голос: старый onend не стирает промежуточный текст новой записи', () => withDictation(s => {
  const old = s.d.rec;
  s.d.cancel(); s.d.start();
  s.d.rec.result([['новый текст', false]]); old.end();
  eq(s.interim, 'новый текст');
}));
test('Голос: ошибка сети сохраняет услышанное и останавливает перезапуски', () => withDictation(s => {
  const rec = s.d.rec;
  rec.result([['услышанный текст', false]]); rec.onerror({ error: 'network' }); rec.end();
  eq(s.text, 'услышанный текст'); eq(s.d.recording, false);
  eq(s.errors.length, 1); eq(s.instances.length, 1);
}));
test('Голос: пять пустых мгновенных сеансов останавливают перезапуски', () => withDictation(s => {
  for (let i = 0; i < 5; i++) s.d.rec.end();
  eq(s.d.recording, false); eq(s.errors.length, 1);
}));

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

// ---- Расходы кнопками (задача 3) ----
test('Списки: разделы [Счета] и [Статьи], порядок сохраняется', () => {
  const r = parseLists('﻿# из модуля Финансов\r\n[Счета]\r\nМир\r\nВиза\r\n\r\n[Статьи]\r\nПродукты\r\nБензин\r\nПродукты\r\n');
  eq(r.accounts, ['Мир', 'Виза']);
  eq(r.cats, ['Продукты', 'Бензин'], 'повтор убран:');
  ok(!r.error, 'не должно быть ошибки');
});
test('Списки: без раздела — ошибка', () => {
  ok(parseLists('[Счета]\nМир').error, 'нет статей — ошибка');
  ok(parseLists('просто текст').error, 'нет разделов — ошибка');
});
test('Сумма: набор цифр, запятая, стирание', () => {
  const type = (keys) => keys.reduce(typeAmount, '');
  eq(type(['8', '0', '0']), '800');
  eq(type(['0', '5']), '5', 'ведущий ноль:');
  eq(type([',', '5']), '0,5', 'запятая первой:');
  eq(type(['1', ',', ',', '2', '3', '4']), '1,23', 'одна запятая, 2 знака:');
  eq(type(['1', '2', '⌫']), '1');
  eq(type(Array(12).fill('9')), '999999999', 'не больше 9 цифр:');
});
test('Сумма на экране: пробелы между тысячами', () => {
  eq(formatAmount('12500,5'), '12 500,5');
  eq(formatAmount(''), '0');
});
test('Расход: текст как голосом', () => {
  eq(applyTag(financeText({ account: 'Мир', amount: '800', cat: 'Продукты', note: 'Пятёрочка у дома' }), 'Финансы'),
    'Финансы: мир 800 продукты, Пятёрочка у дома');
  eq(financeText({ account: 'Виза', amount: '2500,', cat: null, note: '' }), 'виза 2500', 'без статьи, висячая запятая:');
});

// ---- Поиск ----
test('Поиск: регистр и ё не важны', () => {
  eq(normalizeForSearch('ЁЛКА'), 'елка');
});

// ---- Чек по QR ----
test('Чек: QR-код разбирается', () => {
  const r = parseReceiptQr('t=20261006T1942&s=1629.40&fn=7380440700076549&i=41437&fp=2489517395&n=1');
  eq(r.ts, t(2026, 10, 6, 19, 42), 'время:');
  eq([r.sum, r.fn, r.i, r.fp, r.n], [1629.4, '7380440700076549', '41437', '2489517395', '1']);
  eq(parseReceiptQr('t=20261006T194205&s=5&fn=1&i=2&fp=3').ts, t(2026, 10, 6, 19, 42, 5), 'с секундами:');
});
test('Чек: чужой QR — не чек', () => {
  eq(parseReceiptQr('https://example.com'), null);
  eq(parseReceiptQr('t=20261006T1942&s=0&fn=1&i=2&fp=3'), null, 'нулевая сумма:');
  eq(parseReceiptQr('t=20261006T1942&s=10&fn=1&i=2'), null, 'без ФП:');
});
test('Чек: подпись в ленте', () => {
  eq(receiptLabel('t=20261006T1942&s=1629.4&fn=1&i=2&fp=3&n=1'), `06.10 19:42 · ${formatAmount('1629')},40 ₽`, 'тысячи — как у суммы:');
  eq(receiptLabel('мусор'), 'мусор');
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
