// Голосовой ввод: отдельные фразы вместо нестабильного continuous на Android.
// Один ручной запуск — одна база текста. Автоматические сеансы обновляют общий результат,
// каждый индекс results хранится один раз; предварительный текст заменяется, а не дописывается.

import { joinTranscripts, transcriptRemainder } from './core.js';

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
    this.wanted = false;
    this.rec = null;
    this.quickEnds = 0;
    this.prefix = '';
    this.previewText = '';
  }

  // rec может ещё отдавать окончательный результат после нажатия «стоп».
  get recording() { return this.wanted || !!this.rec; }

  toggle() { this.wanted ? this.stop() : this.start(); }

  start() {
    if (this.wanted) return;
    const Rec = recognitionClass();
    if (!Rec) { this.onError(UNSUPPORTED_MESSAGE); return; }
    if (this.rec) this.finish();
    this.prefix = this.previewText = '';
    this.wanted = true;
    this.quickEnds = 0;
    this.onSessionStart();
    this.onState(true);
    this._startSession();
  }

  stop() {
    this.wanted = false;
    this.onState(false);
    if (this.rec) {
      try { this.rec.stop(); }
      catch { this.finish(); }
    }
  }

  /** Сохранить последний предварительный результат и отсечь все запоздалые события. */
  finish() {
    this._commitPreview();
    this.cancel();
  }

  /** Остановить и забыть ожидаемые результаты (например, при «Стереть»). */
  cancel() {
    const rec = this.rec;
    this.rec = null;
    this.wanted = false;
    this.prefix = this.previewText = '';
    this.onState(false);
    this.onInterim('');
    if (rec) { try { rec.abort(); } catch { /* уже остановлено */ } }
  }

  /** После ручной правки не возвращаем старую гипотезу поверх исправленного текста. */
  resetSession() {
    const rec = this.rec;
    this.rec = null;
    if (rec) { try { rec.abort(); } catch { /* уже остановлено */ } }
    this.prefix = this.previewText = '';
    this.onInterim('');
    this.onSessionStart();
    if (this.wanted) this._startSession();
  }

  _commitPreview() {
    this.prefix = this.previewText;
    if (this.prefix) this.onFinal(this.prefix);
    this.onInterim('');
  }

  _startSession() {
    const Rec = recognitionClass();
    const rec = new Rec();
    rec.lang = 'ru-RU';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.rec = rec;
    const slots = [];
    const startedAt = Date.now();

    rec.onresult = (ev) => {
      if (this.rec !== rec) return;
      // results — снимок текущего сеанса; resultIndex указывает первое изменение.
      // Обрезаем исчезнувшие interim, прежние final сохраняем по их индексам.
      slots.length = ev.results.length;
      for (let i = ev.resultIndex ?? 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        slots[i] = { text: r[0].transcript, final: r.isFinal };
      }
      const finals = slots.filter(r => r?.final).map(r => r.text);
      const all = slots.filter(Boolean).map(r => r.text);
      const finalText = joinTranscripts([this.prefix, joinTranscripts(finals)]);
      this.previewText = joinTranscripts([this.prefix, joinTranscripts(all)]);
      if (finalText) this.onFinal(finalText);
      this.onInterim(transcriptRemainder(finalText, this.previewText));
    };

    rec.onerror = (ev) => {
      if (this.rec !== rec || ev.error === 'no-speech' || ev.error === 'aborted') return;
      this.finish();
      this.onError(ERRORS[ev.error] || `Ошибка распознавания (${ev.error}). ${GBOARD_HINT}`);
    };

    rec.onend = () => {
      if (this.rec !== rec) return;
      this._commitPreview();
      this.rec = null;
      if (!this.wanted) return;
      // Короткая успешно распознанная фраза не считается сбоем запуска.
      const hadSpeech = slots.some(r => r?.text.trim());
      this.quickEnds = !hadSpeech && Date.now() - startedAt < 1000 ? this.quickEnds + 1 : 0;
      if (this.quickEnds >= 5) {
        this.stop();
        this.onError('Распознавание всё время обрывается. Попробуйте ещё раз. ' + GBOARD_HINT);
        return;
      }
      this._startSession();
    };

    try { rec.start(); }
    catch {
      this.rec = null;
      this.wanted = false;
      this.onState(false);
      this.onError('Не удалось включить микрофон. ' + GBOARD_HINT);
    }
  }
}
