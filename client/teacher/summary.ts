// Resumen de una clase terminada: todas las preguntas lanzadas y las respuestas guardadas de cada una.
// Sin socket: los datos vienen de la API REST y se muestran con la misma cuadrícula y respuesta en
// grande que la vista en vivo (solo lectura).
import { slideUrl } from '../../shared/slides.js';
import type { Question, QuestionAnswers, QuestionStats, QuestionType, SessionSummary } from '../../shared/types.js';
import { api, ApiError, formatDateTime } from '../common/api.js';
import { $, storage } from '../common/socket.js';
import { AnswerGrid, AnswersModel, BigAnswer } from './grid.js';
import './style.css';
import './summary.css';

const NAMES_KEY = 'aula.teacher.showNames';

const TYPE_LABELS: Record<QuestionType, string> = {
  overSlide: 'Pizarrón sobre la diapositiva',
  blank: 'Pizarrón en blanco',
  text: 'Respuesta de texto',
};

const titleEl = $<HTMLElement>('#summary-title');
const metaEl = $<HTMLElement>('#summary-meta');
const noteEl = $<HTMLElement>('#summary-note');
const errorBox = $<HTMLElement>('#summary-error');
const errorText = $<HTMLElement>('#summary-error-text');
const mainEl = $<HTMLElement>('#summary-main');
const listEl = $<HTMLOListElement>('#question-list');
const emptyEl = $<HTMLElement>('#question-empty');
const hintEl = $<HTMLElement>('#question-hint');
const viewEl = $<HTMLElement>('#question-view');
const headMeta = $<HTMLElement>('#q-header-meta');
const headPrompt = $<HTMLElement>('#q-header-prompt');
const statusEl = $<HTMLElement>('#qv-status');
const gridEl = $<HTMLElement>('#answer-grid');
const toggleNames = $<HTMLButtonElement>('#toggle-names');
const spotlightEl = $<HTMLElement>('#spotlight');
const spotPos = $<HTMLElement>('#spotlight-pos');
const spotPrev = $<HTMLButtonElement>('#spotlight-prev');
const spotNext = $<HTMLButtonElement>('#spotlight-next');
const spotName = $<HTMLButtonElement>('#spotlight-name');
const exportBox = $<HTMLElement>('#export-box');
const exportZip = $<HTMLAnchorElement>('#export-zip');
const exportCsvComma = $<HTMLAnchorElement>('#export-csv-comma');

const model = new AnswersModel();
const grid = new AnswerGrid(gridEl, model, openSpotlight);
const bigAnswer = new BigAnswer($('#spotlight-body'), model);

let summary: SessionSummary | null = null;
let namesVisible = storage.get(NAMES_KEY) === '1';
/** Pregunta elegida (índice en `summary.questions`) y la que ya está cargada en la cuadrícula. */
let selected = -1;
let shownId: string | null = null;
let spotlightId: string | null = null;
const cache = new Map<string, Promise<QuestionAnswers>>();

// ---------- Textos ----------

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'menos de 1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

function statsText(stats: QuestionStats, students: number): string {
  const submitted = `${stats.submitted} ${stats.submitted === 1 ? 'entregó' : 'entregaron'}`;
  const answered = `${stats.answered} ${stats.answered === 1 ? 'respondió' : 'respondieron'}`;
  return `${submitted} · ${answered} de ${plural(students, 'alumno', 'alumnos')}`;
}

function promptOf(question: Question): string {
  return question.prompt?.trim() ?? '';
}

// ---------- Encabezado ----------

function showError(message: string): void {
  titleEl.textContent = 'Resumen de la clase';
  metaEl.textContent = '';
  errorText.textContent = message;
  errorBox.hidden = false;
  mainEl.hidden = true;
}

function renderHeader(data: SessionSummary): void {
  const title = data.classTitle.trim() || 'Clase sin título';
  titleEl.textContent = title;
  document.title = `Aula · ${title}`;
  const parts = [`Empezó el ${formatDateTime(data.startedAt)}`];
  if (data.endedAt !== undefined) parts.push(`Duración: ${formatDuration(data.endedAt - data.startedAt)}`);
  parts.push(plural(data.students.length, 'alumno', 'alumnos'));
  metaEl.textContent = parts.join(' · ');

  if (data.status === 'interrupted') {
    noteEl.textContent = 'La clase no se terminó con «Terminar clase»: se muestran las respuestas guardadas.';
  } else if (data.status === 'live') {
    noteEl.textContent = 'Esta clase sigue en curso.';
  }
  noteEl.hidden = data.status === 'ended';

  // Descarga de las respuestas (un PNG por alumno y pregunta de pizarrón + CSV). Sin respuestas no hay nada que bajar.
  const zipUrl = `/api/classes/${encodeURIComponent(data.classId)}/sessions/${encodeURIComponent(data.id)}/export.zip`;
  exportZip.href = zipUrl;
  exportCsvComma.href = `${zipUrl}?sep=comma`;
  exportBox.hidden = data.questions.length === 0 || data.students.length === 0;
}

// ---------- Lista de preguntas ----------

function renderList(data: SessionSummary): void {
  const items = data.questions.map((stats, i) => {
    const q = stats.question;
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'q-item';
    button.dataset.questionId = q.id;
    button.addEventListener('click', () => select(i));

    const num = document.createElement('span');
    num.className = 'q-num';
    num.textContent = String(i + 1);

    const thumb = document.createElement('img');
    thumb.className = 'q-thumb';
    thumb.loading = 'lazy';
    thumb.alt = '';
    thumb.src = slideUrl(data.classId, q.slideIndex ?? 0);

    const body = document.createElement('span');
    body.className = 'q-body';
    const type = document.createElement('span');
    type.className = 'q-type';
    type.textContent = TYPE_LABELS[q.type];
    const prompt = document.createElement('span');
    const text = promptOf(q);
    prompt.className = text ? 'q-prompt' : 'q-prompt muted';
    prompt.textContent = text || '(sin enunciado)';
    const counts = document.createElement('span');
    counts.className = 'q-counts';
    counts.textContent = statsText(stats, data.students.length);
    body.append(type, prompt, counts);

    button.append(num, thumb, body);
    li.append(button);
    return li;
  });
  listEl.replaceChildren(...items);
  emptyEl.hidden = items.length > 0;
  hintEl.hidden = items.length === 0;
}

// ---------- Pregunta elegida ----------

function select(index: number): void {
  if (!summary) return;
  const stats = summary.questions[index];
  if (!stats) return;
  selected = index;
  const q = stats.question;
  listEl.querySelectorAll<HTMLElement>('.q-item').forEach((el, i) => {
    el.classList.toggle('selected', i === index);
    if (i === index) {
      el.setAttribute('aria-current', 'true');
      el.scrollIntoView({ block: 'nearest' });
    } else {
      el.removeAttribute('aria-current');
    }
  });

  headMeta.textContent = `Pregunta ${index + 1} · ${TYPE_LABELS[q.type]} · ${statsText(stats, summary.students.length)}`;
  headPrompt.textContent = promptOf(q) || TYPE_LABELS[q.type];
  viewEl.hidden = false;
  hintEl.hidden = true;
  if (shownId === q.id) return;

  // Mientras llegan las respuestas no se deja la cuadrícula de la pregunta anterior a la vista.
  shownId = null;
  gridEl.hidden = true;
  statusEl.textContent = 'Cargando respuestas…';
  statusEl.hidden = false;
  void showAnswers(summary, q.id);
}

function fetchAnswers(data: SessionSummary, questionId: string): Promise<QuestionAnswers> {
  let promise = cache.get(questionId);
  if (!promise) {
    promise = api.questionAnswers(data.classId, data.id, questionId);
    cache.set(questionId, promise);
    // Un fallo no se queda en la caché: al volver a elegir la pregunta se reintenta.
    promise.catch(() => cache.delete(questionId));
  }
  return promise;
}

async function showAnswers(data: SessionSummary, questionId: string): Promise<void> {
  let result: QuestionAnswers;
  try {
    result = await fetchAnswers(data, questionId);
  } catch (err) {
    if (data.questions[selected]?.question.id !== questionId) return;
    statusEl.textContent = `${errorMessage(err)} Vuelve a elegir la pregunta para reintentar.`;
    return;
  }
  if (data.questions[selected]?.question.id !== questionId) return; // Eligió otra mientras cargaba.
  shownId = questionId;
  // Es una clase terminada: ningún alumno aparece como desconectado.
  const roster = result.roster.map((s) => ({ ...s, connected: true }));
  closeSpotlight();
  model.load(data.classId, roster, result.question, result.answers);
  grid.setShowNames(namesVisible);
  gridEl.hidden = false;
  gridEl.scrollTop = 0;
  if (roster.length === 0) {
    statusEl.textContent = 'En esta clase no hubo alumnos.';
    statusEl.hidden = false;
  } else {
    statusEl.hidden = true;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'No se pudieron cargar las respuestas.';
}

function moveQuestion(delta: number): void {
  if (!summary || summary.questions.length === 0) return;
  const next = selected < 0 ? (delta > 0 ? 0 : summary.questions.length - 1) : selected + delta;
  if (next >= 0 && next < summary.questions.length) select(next);
}

// ---------- Nombres ----------

function renderNames(): void {
  grid.setShowNames(namesVisible);
  toggleNames.textContent = namesVisible ? 'Ocultar nombres' : 'Mostrar nombres';
  spotName.textContent = namesVisible ? 'Ocultar nombre' : 'Mostrar nombre';
  if (spotlightId) renderSpotlight();
}

function toggleNamesVisible(): void {
  namesVisible = !namesVisible;
  storage.set(NAMES_KEY, namesVisible ? '1' : '0');
  renderNames();
}

toggleNames.addEventListener('click', toggleNamesVisible);
spotName.addEventListener('click', toggleNamesVisible);

// ---------- Respuesta en grande (solo local) ----------

function openSpotlight(studentId: string): void {
  spotlightId = studentId;
  spotlightEl.hidden = false;
  renderSpotlight();
}

function renderSpotlight(): void {
  if (!spotlightId) return;
  const index = model.indexOf(spotlightId);
  bigAnswer.show(spotlightId, namesVisible);
  spotPos.textContent = index < 0 ? '' : `Alumno ${index + 1} de ${model.roster.length}`;
  spotPrev.disabled = index <= 0;
  spotNext.disabled = index < 0 || index >= model.roster.length - 1;
}

function closeSpotlight(): void {
  spotlightId = null;
  spotlightEl.hidden = true;
}

function moveSpotlight(delta: number): void {
  if (!spotlightId) return;
  const next = model.roster[model.indexOf(spotlightId) + delta];
  if (!next) return;
  spotlightId = next.id;
  renderSpotlight();
}

spotPrev.addEventListener('click', () => moveSpotlight(-1));
spotNext.addEventListener('click', () => moveSpotlight(1));
$('#spotlight-close').addEventListener('click', closeSpotlight);
spotlightEl.addEventListener('click', (event) => {
  if (event.target === spotlightEl) closeSpotlight();
});

document.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (!spotlightEl.hidden) {
    if (event.key === 'Escape') closeSpotlight();
    else if (event.key === 'ArrowLeft') moveSpotlight(-1);
    else if (event.key === 'ArrowRight') moveSpotlight(1);
    else return;
    event.preventDefault();
    return;
  }
  if (event.key === 'ArrowDown') moveQuestion(1);
  else if (event.key === 'ArrowUp') moveQuestion(-1);
  else return;
  event.preventDefault();
});

// ---------- Arranque ----------

async function start(): Promise<void> {
  renderNames();
  const params = new URLSearchParams(location.search);
  const classId = params.get('c');
  const sessionId = params.get('s');
  if (!classId || !sessionId) return showError('No se encontró esta clase o sesión.');
  try {
    summary = await api.sessionSummary(classId, sessionId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return showError('No se encontró esta clase o sesión.');
    return showError(err instanceof ApiError ? err.message : 'No se pudo cargar el resumen.');
  }
  renderHeader(summary);
  renderList(summary);
  mainEl.hidden = false;
  // Al terminar la clase lo natural es empezar a revisar por la primera pregunta.
  if (summary.questions.length) select(0);
}

void start();
