// База «Захвата» в IndexedDB (задача 1): записи и настройки. Всё хранится только на телефоне.

const DB_NAME = 'zahvat';
const DB_VERSION = 1;   // при изменении схемы: увеличить и дописать шаг в upgrade() — старые данные не стираются

let dbPromise = null;

/** Открыть базу (один раз на запуск). */
export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => upgrade(req.result, ev.oldVersion);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/** Миграции: каждый шаг выполняется один раз, по порядку версий. */
function upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    const entries = db.createObjectStore('entries', { keyPath: 'id' });
    entries.createIndex('ts', 'ts');
    entries.createIndex('exportedAt', 'exportedAt');
    db.createObjectStore('settings');   // ключ — имя настройки, значение — что угодно
  }
  // if (oldVersion < 2) { ... }  — сюда будущие изменения
}

/** Выполнить действие в транзакции и дождаться её завершения. */
async function tx(stores, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    const r = work(t);
    if (r instanceof IDBRequest) r.onsuccess = () => { result = r.result; };
  });
}

export const getAllEntries = () => tx(['entries'], 'readonly', t => t.objectStore('entries').getAll());
export const getEntry = (id) => tx(['entries'], 'readonly', t => t.objectStore('entries').get(id));
export const putEntry = (e) => tx(['entries'], 'readwrite', t => t.objectStore('entries').put(e));
export const deleteEntry = (id) => tx(['entries'], 'readwrite', t => t.objectStore('entries').delete(id));

/** Записать много записей одной транзакцией (выгрузка, восстановление). */
export const putEntries = (list) => tx(['entries'], 'readwrite', t => {
  const s = t.objectStore('entries');
  for (const e of list) s.put(e);
});

export const getSetting = (key) => tx(['settings'], 'readonly', t => t.objectStore('settings').get(key));
export const setSetting = (key, value) => tx(['settings'], 'readwrite', t => t.objectStore('settings').put(value, key));

/** Все настройки — для резервной копии: { имя: значение }. */
export async function getAllSettings() {
  const out = {};
  await tx(['settings'], 'readonly', t => {
    const r = t.objectStore('settings').openCursor();
    r.addEventListener('success', () => {
      const c = r.result;
      if (c) { out[c.key] = c.value; c.continue(); }
    });
  });
  return out;
}
