// Голосовой ввод «Захвата» (задача 1): Web Speech API в Chrome, русский язык.
//
// Как устроено:
// - нажали микрофон → start(): создаём распознавание и слушаем;
// - Chrome на Android сам обрывает сессию через несколько секунд тишины → onend → запускаем заново,
//   пока пользователь не нажал «стоп» (this.wanted);
// - каждая такая сессия — отдельный кусок: приложение по onSessionStart запоминает текст поля,
//   а по onFinal дописывает к нему распознанное в этой сессии;
// - промежуточный (ещё не окончательный) текст отдаём через onInterim — его показываем серым.

import { joinTranscripts } from './core.js';

const GBOARD_HINT = 'Можно нажать на микрофон на клавиатуре Gboard — это тоже голосовой ввод в текстовое поле.';

/** Сообщения об ошибках распознавания — по-русски и с подсказкой, что делать. */
const ERRORS = {
  'not-allowed': 'Нет доступа к микрофону. Разрешите его: Chrome → ⋮ → Настройки → Настройки сайтов → Микрофон ' +
                 '(и в Android: Настройки → Приложения → Chrome → Разрешения → Микрофон). ' + GBOARD_HINT,
  'service-not-allowed': 'Браузер запретил распознавание речи. Проверьте разрешение на микрофон. ' + GBOARD_HINT,
  'audio-capture': 'Микрофон не найден или занят другим приложением. ' + GBOARD_HINT,
  'network': 'Распознавание речи в Chrome работает через интернет, а связи нет. Текст сохраняется и без сети. ' + GBOARD_HINT,
  'language-not-supported': 'Русский язык распознавания недоступен в этом браузере. ' + GBOARD_HINT,
};

export const UNSUPPORTED_MESSAGE = 'Голосовой ввод в этом браузере не поддерживается (нужен Chrome). ' + GBOARD_HINT;

/** Конструктор распознавания (ищем при каждом запуске — так его можно подменить в проверках). */
function recognitionClass() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function isSpeechSupported() {
  return !!recognitionClass();
}

export class Dictation {
  constructor({ onSessionStart, onFinal, onInterim, onState, onError }) {
    Object.assign(this, { onSessionStart, onFinal, onInterim, onState, onError });
    this.wanted = false;      // пользователь хочет, чтобы запись шла
    this.rec = null;
    this.quickEnds = 0;       // сколько раз подряд сессия оборвалась сразу после старта
  }

  get recording() { return this.wanted; }

  toggle() { this.wanted ? this.stop() : this.start(); }

  start() {
    const Rec = recognitionClass();
    if (!Rec) { this.onError(UNSUPPORTED_MESSAGE); return; }
    this.wanted = true;
    this.quickEnds = 0;
    this.onState(true);
    this._startSession();
  }

  stop() {
    this.wanted = false;
    this.onState(false);
    if (this.rec) { try { this.rec.stop(); } catch { /* уже остановлено */ } }
  }

  /** Остановить и забыть то, что ещё не пришло (при сохранении во время записи). */
  cancel() {
    const rec = this.rec;
    this.rec = null;
    this.wanted = false;
    this.onState(false);
    this.onInterim('');
    if (rec) { try { rec.abort(); } catch { /* уже остановлено */ } }
  }

  /** Пользователь сам правил поле во время записи: дальше дописываем только новое. */
  resetSession() {
    this.consumed = this.finals ? this.finals.length : 0;
    this.onSessionStart();
  }

  _startSession() {
    const Rec = recognitionClass();
    const rec = new Rec();
    rec.lang = 'ru-RU';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.rec = rec;
    this.finals = [];
    this.consumed = 0;
    this.startedAt = Date.now();
    this.onSessionStart();

    rec.onresult = (ev) => {
      if (this.rec !== rec) return;   // сессию уже отменили
      // Собираем все результаты сессии заново: окончательные — в текст, остальные — серым
      const finals = [], interim = [];
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        (r.isFinal ? finals : interim).push(r[0].transcript);
      }
      this.finals = finals;
      const text = joinTranscripts(finals.slice(this.consumed));
      if (text) this.onFinal(text);
      this.onInterim(joinTranscripts(interim));
    };

    rec.onerror = (ev) => {
      // «тишина» и «прервано» — обычное дело, просто перезапустимся
      if (this.rec !== rec || ev.error === 'no-speech' || ev.error === 'aborted') return;
      this.wanted = false;
      this.onState(false);
      this.onError(ERRORS[ev.error] || `Ошибка распознавания (${ev.error}). ${GBOARD_HINT}`);
    };

    rec.onend = () => {
      this.onInterim('');
      if (this.rec !== rec || !this.wanted) return;
      // Защита от бесконечных мгновенных перезапусков (например, микрофон отдан другому приложению)
      this.quickEnds = Date.now() - this.startedAt < 1000 ? this.quickEnds + 1 : 0;
      if (this.quickEnds >= 5) {
        this.stop();
        this.onError('Распознавание всё время обрывается. Попробуйте ещё раз. ' + GBOARD_HINT);
        return;
      }
      this._startSession();
    };

    try { rec.start(); }
    catch (err) {
      this.wanted = false;
      this.onState(false);
      this.onError('Не удалось включить микрофон. ' + GBOARD_HINT);
    }
  }
}
