import type { PreparedQuestion, QuestionType } from '../../shared/types.js';
import { $ } from '../common/socket.js';

// Navegación de diapositivas: botones y teclado (incluye los clickers de presentación, que envían PageUp/PageDown).

export type SlideControls = {
  step: (delta: number) => void;
  goto: (index: 'first' | 'last') => void;
  toggleQr: () => void;
  closeOverlays: () => void;
};

export function bindControls(prev: HTMLButtonElement, next: HTMLButtonElement, controls: SlideControls): void {
  prev.addEventListener('click', () => controls.step(-1));
  next.addEventListener('click', () => controls.step(1));

  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    // Con un diálogo o la respuesta en grande abiertos, las teclas no cambian de diapositiva.
    if (document.querySelector('dialog[open], #spotlight:not([hidden])')) return;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
      case 'PageDown':
      case ' ':
        controls.step(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'PageUp':
      case 'Backspace':
        controls.step(-1);
        break;
      case 'Home':
        controls.goto('first');
        break;
      case 'End':
        controls.goto('last');
        break;
      case 'q':
      case 'Q':
        controls.toggleQr();
        break;
      case 'Escape':
        controls.closeOverlays();
        break;
      default:
        return;
    }
    event.preventDefault();
  });
}

export function setNavState(prev: HTMLButtonElement, next: HTMLButtonElement, index: number, count: number): void {
  prev.disabled = index <= 0;
  next.disabled = index >= count - 1;
}

// ---------- Preguntas ----------

export const TYPE_LABELS: Record<QuestionType, string> = {
  overSlide: 'Pizarrón sobre la diapositiva',
  blank: 'Pizarrón en blanco',
  text: 'Respuesta de texto',
};

export type ActiveQuestion = { id: string; type: QuestionType; deadline: number | null; prompt?: string };

/** Lo necesario para lanzar una pregunta, improvisada (diálogo) o preparada de antemano. */
export type QuestionLaunch = { type: QuestionType; timeLimitSec?: number; prompt?: string; preparedId?: string };

/** Botón "Lanzar pregunta", su diálogo y la barra de la pregunta abierta (entregados, tiempo, cerrar). */
export class QuestionControls {
  private question: ActiveQuestion | null = null;
  private timer: number | undefined;
  private readonly dialog = $<HTMLDialogElement>('#question-dialog');
  private readonly form = $<HTMLFormElement>('#question-form');
  private readonly openButton = $<HTMLButtonElement>('#open-question');
  private readonly bar = $<HTMLElement>('#question-bar');
  private readonly timerEl = $<HTMLElement>('#question-timer');

  constructor(
    onOpen: (launch: QuestionLaunch) => void,
    onClose: (id: string) => void,
  ) {
    this.openButton.addEventListener('click', () => this.dialog.showModal());
    this.dialog.addEventListener('close', () => {
      if (this.dialog.returnValue !== 'launch') return;
      const data = new FormData(this.form);
      const time = Number(data.get('time'));
      const prompt = String(data.get('prompt') ?? '').trim();
      const launch: QuestionLaunch = { type: data.get('type') as QuestionType };
      if (time > 0) launch.timeLimitSec = time;
      if (prompt) launch.prompt = prompt;
      onOpen(launch);
      // El enunciado es de esta pregunta; tipo y tiempo se recuerdan para la siguiente.
      const promptField = this.form.elements.namedItem('prompt');
      if (promptField instanceof HTMLTextAreaElement) promptField.value = '';
    });
    $('#close-question').addEventListener('click', () => {
      if (this.question) onClose(this.question.id);
    });
  }

  get current(): ActiveQuestion | null {
    return this.question;
  }

  set(question: ActiveQuestion | null): void {
    this.question = question;
    window.clearInterval(this.timer);
    this.bar.hidden = !question;
    this.openButton.hidden = Boolean(question);
    if (!question) return;
    $('#question-label').textContent = TYPE_LABELS[question.type];
    const promptEl = $('#question-prompt');
    promptEl.textContent = question.prompt ?? '';
    promptEl.hidden = !question.prompt;
    this.timerEl.hidden = question.deadline === null;
    if (question.deadline !== null) {
      const deadline = question.deadline;
      const tick = () => {
        const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        this.timerEl.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        this.timerEl.classList.toggle('urgent', left <= 10);
      };
      tick();
      this.timer = window.setInterval(tick, 250);
    }
  }

  setStatus(connected: number, submitted: number): void {
    $('#submitted').textContent = String(submitted);
    $('#submitted-of').textContent = String(connected);
  }

  setEnabled(enabled: boolean): void {
    this.openButton.disabled = !enabled;
  }
}

/** Preguntas preparadas de la diapositiva actual: un botón por pregunta, se lanza con un clic. */
export class PreparedBar {
  private readonly el = $<HTMLElement>('#prepared-bar');

  constructor(private readonly onLaunch: (question: PreparedQuestion) => void) {}

  /** `launched`: ids de preguntas preparadas que ya se lanzaron en esta sesión (se marcan con ✓). */
  render(questions: readonly PreparedQuestion[], launched: ReadonlySet<string>, enabled: boolean): void {
    this.el.hidden = questions.length === 0;
    this.el.replaceChildren(
      ...questions.map((q, i) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'prepared-chip';
        button.classList.toggle('launched', launched.has(q.id));
        button.disabled = !enabled;
        const label = q.prompt ?? TYPE_LABELS[q.type];
        button.textContent = `${launched.has(q.id) ? '✓ ' : '▶ '}${label}`;
        button.title = `Pregunta preparada ${i + 1}: ${TYPE_LABELS[q.type]}${q.timeLimitSec ? `, ${q.timeLimitSec} s` : ''}`;
        button.addEventListener('click', () => this.onLaunch(q));
        return button;
      }),
    );
  }
}
