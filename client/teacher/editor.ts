// Editor de clase: miniaturas de diapositivas y preguntas preparadas para cada una.
import { slideUrl } from '../../shared/slides.js';
import type { ClassInfo, PreparedQuestion, QuestionType } from '../../shared/types.js';
import { api, ApiError, TEACHER_SESSION_KEY } from '../common/api.js';
import { $, randomId, storage } from '../common/socket.js';

// ---------- Utilidades compartidas con la biblioteca ----------

/** Crea un elemento con clase y texto (siempre textContent: nunca innerHTML con datos del usuario). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function showError(target: HTMLElement, err: unknown): void {
  target.textContent = err instanceof ApiError ? err.message : 'Ocurrió un error inesperado. Inténtalo de nuevo.';
  target.hidden = false;
}

export function clearError(target: HTMLElement): void {
  target.textContent = '';
  target.hidden = true;
}

/** Empieza (o retoma) la clase y abre la vista del profesor. Si falla, lanza el error para mostrarlo. */
export async function startClassAndGo(classId: string): Promise<never> {
  const info = await api.startClass(classId);
  storage.set(TEACHER_SESSION_KEY, info.sessionId);
  location.href = '/teacher';
  // La navegación es asíncrona: la promesa no se resuelve para que los botones sigan bloqueados.
  return new Promise<never>(() => {});
}

export const TYPE_LABELS: Record<QuestionType, string> = {
  overSlide: 'Pizarrón sobre la diapositiva',
  blank: 'Pizarrón en blanco',
  text: 'Respuesta corta de texto',
};

export function timeLabel(sec: number | undefined): string {
  if (!sec) return 'Sin límite';
  if (sec === 30) return '30 s';
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}

// ---------- Editor ----------

export type EditorHooks = {
  /** El usuario pidió volver a la biblioteca (el editor ya confirmó si había cambios). */
  onBack: () => void;
  /** No se pudo cargar la clase. */
  onLoadError: (err: unknown) => void;
};

type Draft = { title: string; questions: PreparedQuestion[] };

export class Editor {
  private classId = '';
  private slideCount = 0;
  private questions: PreparedQuestion[] = [];
  private selected = 0;
  private editingId: string | null = null;
  private savedKey = '';
  private saving = false;
  private visible = false;
  private loadToken = 0;

  private readonly root = $<HTMLElement>('#editor');
  private readonly titleInput = $<HTMLInputElement>('#ed-title');
  private readonly statusEl = $<HTMLElement>('#ed-status');
  private readonly errorEl = $<HTMLElement>('#ed-error');
  private readonly saveButton = $<HTMLButtonElement>('#ed-save');
  private readonly startButton = $<HTMLButtonElement>('#ed-start');
  private readonly strip = $<HTMLElement>('#slide-strip');
  private readonly caption = $<HTMLElement>('#slide-caption');
  private readonly slideImg = $<HTMLImageElement>('#slide-main');
  private readonly list = $<HTMLOListElement>('#prepared-list');
  private readonly form = $<HTMLFormElement>('#pq-form');
  private readonly formHeading = $<HTMLElement>('#pq-heading');
  private readonly submitButton = $<HTMLButtonElement>('#pq-submit');
  private readonly cancelButton = $<HTMLButtonElement>('#pq-cancel');
  private readonly badges: HTMLElement[] = [];
  private readonly thumbs: HTMLButtonElement[] = [];

  constructor(private readonly hooks: EditorHooks) {
    this.titleInput.addEventListener('input', () => this.updateStatus());
    this.saveButton.addEventListener('click', () => void this.save());
    this.startButton.addEventListener('click', () => void this.startClass());
    $('#ed-back').addEventListener('click', () => {
      if (this.confirmDiscard()) this.hooks.onBack();
    });
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitQuestion();
    });
    this.cancelButton.addEventListener('click', () => this.resetForm());
    document.addEventListener('keydown', (event) => this.onKey(event));
  }

  get dirty(): boolean {
    return this.visible && this.classId !== '' && this.currentKey() !== this.savedKey;
  }

  /** Pregunta si se pueden perder los cambios sin guardar. */
  confirmDiscard(): boolean {
    return !this.dirty || confirm('Tienes cambios sin guardar. ¿Salir sin guardarlos?');
  }

  async open(classId: string): Promise<void> {
    const token = ++this.loadToken;
    let info: ClassInfo;
    try {
      info = await api.getClass(classId);
    } catch (err) {
      if (token === this.loadToken) this.hooks.onLoadError(err);
      return;
    }
    if (token !== this.loadToken) return; // el usuario ya navegó a otra parte
    this.classId = info.id;
    this.slideCount = info.slideCount;
    this.questions = info.questions.map((q) => ({ ...q }));
    this.titleInput.value = info.title;
    this.selected = 0;
    this.editingId = null;
    this.visible = true;
    this.root.hidden = false;
    clearError(this.errorEl);
    this.buildStrip();
    this.resetForm();
    this.selectSlide(0);
    this.savedKey = this.currentKey();
    this.updateStatus();
  }

  close(): void {
    this.loadToken++;
    this.visible = false;
    this.classId = '';
    this.root.hidden = true;
  }

  // ---------- Estado ----------

  private draft(): Draft {
    return { title: this.titleInput.value.trim(), questions: this.questions };
  }

  private currentKey(): string {
    return JSON.stringify(this.draft());
  }

  private updateStatus(): void {
    const dirty = this.dirty;
    this.statusEl.textContent = this.saving ? 'Guardando…' : dirty ? 'Cambios sin guardar' : 'Guardado';
    this.statusEl.classList.toggle('dirty', dirty && !this.saving);
    this.saveButton.disabled = this.saving || !dirty;
  }

  private async save(): Promise<boolean> {
    if (this.saving || !this.classId) return false;
    clearError(this.errorEl);
    const sent: Draft = JSON.parse(this.currentKey()) as Draft; // copia profunda de lo que se envía
    const sentKey = JSON.stringify(sent);
    this.saving = true;
    this.updateStatus();
    try {
      const res = await api.updateClass(this.classId, sent);
      this.savedKey = sentKey;
      if (this.currentKey() === sentKey) {
        // Sin ediciones durante el guardado: adopta lo que devolvió el servidor (ya ordenado por diapositiva).
        this.questions = res.questions.map((q) => ({ ...q }));
        this.titleInput.value = res.title;
        this.savedKey = this.currentKey();
        this.renderQuestions();
      }
      return true;
    } catch (err) {
      showError(this.errorEl, err);
      return false;
    } finally {
      this.saving = false;
      this.updateStatus();
    }
  }

  private async startClass(): Promise<void> {
    this.startButton.disabled = true;
    try {
      if (this.dirty && !(await this.save())) {
        this.startButton.disabled = false;
        return;
      }
      await startClassAndGo(this.classId);
    } catch (err) {
      showError(this.errorEl, err);
      this.startButton.disabled = false;
    }
  }

  // ---------- Tira de diapositivas ----------

  private buildStrip(): void {
    this.strip.replaceChildren();
    this.badges.length = 0;
    this.thumbs.length = 0;
    for (let i = 0; i < this.slideCount; i++) {
      const button = el('button', 'thumb');
      button.type = 'button';
      button.setAttribute('aria-label', `Diapositiva ${i + 1}`);
      const img = el('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = slideUrl(this.classId, i);
      const num = el('span', 'thumb-num', String(i + 1));
      const badge = el('span', 'thumb-badge');
      badge.hidden = true;
      button.append(img, num, badge);
      button.addEventListener('click', () => this.selectSlide(i));
      this.strip.append(button);
      this.thumbs.push(button);
      this.badges.push(badge);
    }
  }

  private updateBadges(): void {
    const counts = new Array<number>(this.slideCount).fill(0);
    for (const q of this.questions) {
      if (q.slideIndex >= 0 && q.slideIndex < this.slideCount) counts[q.slideIndex] = (counts[q.slideIndex] ?? 0) + 1;
    }
    this.badges.forEach((badge, i) => {
      const n = counts[i] ?? 0;
      badge.hidden = n === 0;
      badge.textContent = String(n);
      badge.title = `${n} ${n === 1 ? 'pregunta preparada' : 'preguntas preparadas'}`;
    });
  }

  private selectSlide(index: number): void {
    if (this.slideCount === 0) return;
    const next = Math.max(0, Math.min(this.slideCount - 1, index));
    if (next !== this.selected) this.resetForm();
    this.selected = next;
    this.thumbs.forEach((thumb, i) => {
      const on = i === next;
      thumb.classList.toggle('selected', on);
      if (on) thumb.setAttribute('aria-current', 'true');
      else thumb.removeAttribute('aria-current');
    });
    this.thumbs[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.slideImg.src = slideUrl(this.classId, next);
    this.caption.textContent = `Diapositiva ${next + 1} de ${this.slideCount}`;
    this.renderQuestions();
  }

  private onKey(event: KeyboardEvent): void {
    if (!this.visible || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    this.selectSlide(this.selected + (event.key === 'ArrowDown' ? 1 : -1));
    event.preventDefault();
  }

  // ---------- Preguntas de la diapositiva ----------

  private renderQuestions(): void {
    this.updateBadges();
    this.updateStatus();
    this.list.replaceChildren();
    const mine = this.questions.filter((q) => q.slideIndex === this.selected);
    if (mine.length === 0) {
      const empty = el('li', 'prepared-empty muted', 'Esta diapositiva no tiene preguntas preparadas.');
      this.list.append(empty);
      return;
    }
    mine.forEach((q, i) => {
      const item = el('li', 'prepared');
      if (q.id === this.editingId) item.classList.add('editing');
      const head = el('div', 'prepared-head');
      head.append(el('strong', undefined, TYPE_LABELS[q.type]), el('span', 'prepared-time', timeLabel(q.timeLimitSec)));
      const prompt = el('p', q.prompt ? 'prepared-prompt' : 'prepared-prompt muted', q.prompt ? q.prompt : '(sin enunciado)');
      const actions = el('div', 'prepared-actions');
      actions.append(
        this.actionButton('Editar', () => this.startEdit(q)),
        this.actionButton('Eliminar', () => this.removeQuestion(q.id), 'danger'),
        this.actionButton('Subir', () => this.moveQuestion(q.id, -1), 'secondary', i === 0),
        this.actionButton('Bajar', () => this.moveQuestion(q.id, 1), 'secondary', i === mine.length - 1),
      );
      item.append(head, prompt, actions);
      this.list.append(item);
    });
  }

  private actionButton(label: string, onClick: () => void, variant = 'secondary', disabled = false): HTMLButtonElement {
    const button = el('button', variant, label);
    button.type = 'button';
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    return button;
  }

  private moveQuestion(id: string, delta: -1 | 1): void {
    const at = this.questions.findIndex((q) => q.id === id);
    const current = this.questions[at];
    if (!current) return;
    // El vecino se busca entre las preguntas de la misma diapositiva: el orden global solo importa dentro de cada una.
    let other = at + delta;
    while (this.questions[other] && this.questions[other]?.slideIndex !== current.slideIndex) other += delta;
    const neighbour = this.questions[other];
    if (!neighbour) return;
    this.questions[at] = neighbour;
    this.questions[other] = current;
    this.renderQuestions();
  }

  private removeQuestion(id: string): void {
    this.questions = this.questions.filter((q) => q.id !== id);
    if (this.editingId === id) this.resetForm();
    this.renderQuestions();
  }

  private startEdit(q: PreparedQuestion): void {
    this.editingId = q.id;
    for (const radio of this.form.querySelectorAll<HTMLInputElement>('input[name="type"]')) {
      radio.checked = radio.value === q.type;
    }
    this.field<HTMLSelectElement>('time').value = q.timeLimitSec ? String(q.timeLimitSec) : '';
    this.field<HTMLTextAreaElement>('prompt').value = q.prompt ?? '';
    this.formHeading.textContent = 'Editar pregunta';
    this.submitButton.textContent = 'Actualizar pregunta';
    this.cancelButton.hidden = false;
    this.renderQuestions();
    this.field<HTMLTextAreaElement>('prompt').focus();
  }

  private resetForm(): void {
    this.editingId = null;
    this.form.reset();
    this.formHeading.textContent = 'Nueva pregunta';
    this.submitButton.textContent = 'Agregar pregunta';
    this.cancelButton.hidden = true;
    if (this.visible) this.renderQuestions();
  }

  private field<T extends HTMLElement>(name: string): T {
    const node = this.form.elements.namedItem(name);
    if (!node) throw new Error(`Falta el campo ${name}`);
    return node as unknown as T;
  }

  private submitQuestion(): void {
    const data = new FormData(this.form);
    const type = (data.get('type') as QuestionType | null) ?? 'overSlide';
    const time = Number(data.get('time'));
    const prompt = String(data.get('prompt') ?? '').trim();

    const base: PreparedQuestion = { id: this.editingId ?? `pq-${randomId(6)}`, slideIndex: this.selected, type };
    if (time > 0) base.timeLimitSec = time;
    if (prompt) base.prompt = prompt;

    if (this.editingId) {
      const at = this.questions.findIndex((q) => q.id === this.editingId);
      if (at >= 0) this.questions[at] = base; // conserva la posición (y por tanto el orden dentro de la diapositiva)
      else this.questions.push(base);
    } else {
      this.questions.push(base);
    }
    this.resetForm();
  }
}
