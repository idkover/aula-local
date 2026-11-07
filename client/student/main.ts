import {
  boardKey,
  parseBoardState,
  reconcileBoard,
  serializeBoardState,
  staleBoardKeys,
  type LocalBoardState,
  type SyncChannel,
} from '../../shared/boardSync.js';
import { slideUrl } from '../../shared/slides.js';
import { BOARD_COLORS, BOARD_SIZES } from '../../shared/strokes.js';
import type {
  AckResult,
  Answer,
  AnswerSubmitPayload,
  QuestionOpenPayload,
  QuestionType,
  ServerToStudentEvents,
  StudentJoinPayload,
  StudentToServerEvents,
  Stroke,
} from '../../shared/types.js';
import { $, connect, randomId, storage, watchConnection } from '../common/socket.js';
import { Board, type Tool } from './board.js';
import { SlideView } from './slide.js';
import './style.css';

const KEYS = { clientId: 'aula.clientId', name: 'aula.name', code: 'aula.code' } as const;
const ACK_TIMEOUT_MS = 8000;
const PERSIST_DELAY_MS = 300;
/** Si la entrega no recibe respuesta pero el socket sigue "conectado", se reintenta pasado este tiempo. */
const SUBMIT_RETRY_MS = 4000;
const LOST_MESSAGE = 'La pregunta se cerró mientras no tenías conexión; los cambios sin enviar no se guardaron.';
const VIEWPORT_NORMAL = 'width=device-width, initial-scale=1, viewport-fit=cover';
const VIEWPORT_LOCKED = `${VIEWPORT_NORMAL}, maximum-scale=1, user-scalable=no`;

type Credentials = Pick<StudentJoinPayload, 'code' | 'name'>;
type Screen = 'join' | 'slides' | 'board' | 'text' | 'ended';

type ActiveQuestion = {
  id: string;
  type: QuestionType;
  /** Sesión a la que pertenece (parte de la clave del tablero guardado). */
  sessionId: string;
  slideIndex: number;
  /** Momento (reloj de este dispositivo) en que vence el tiempo, o null si no hay límite. */
  deadline: number | null;
  submitted: boolean;
  /** Hubo cambios después de la última entrega (el botón pasa a "Reenviar"). */
  changedSinceSubmit: boolean;
  submitting: boolean;
  /**
   * El servidor ya confirmó a este dispositivo (`state:sync` reconciliado) desde la última conexión.
   * Mientras es false las ediciones solo cambian el tablero local; la reconciliación las envía.
   */
  synced: boolean;
  /** El alumno pulsó "Entregar" sin estar sincronizado: se envía justo después de reconciliar. */
  pendingSubmit: boolean;
  /** Hubo ediciones sin confirmar por el servidor (para avisar si la pregunta se cierra entretanto). */
  dirty: boolean;
  /** Trazos de partida mientras el pizarrón termina de cargar la diapositiva; luego pasan a `board`. */
  initial: Stroke[] | null;
};

const clientId = storage.get(KEYS.clientId) ?? randomId();
storage.set(KEYS.clientId, clientId);

const screens: Record<Screen, HTMLElement> = {
  join: $('#join'),
  slides: $('#slides'),
  board: $('#board-screen'),
  text: $('#text-screen'),
  ended: $('#ended'),
};
const form = $<HTMLFormElement>('#join-form');
const nameInput = $<HTMLInputElement>('#name');
const codeInput = $<HTMLInputElement>('#code');
const joinError = $<HTMLElement>('#join-error');
const joinButton = $<HTMLButtonElement>('#join-button');
const offlineBanner = $<HTMLElement>('#offline');
const fullscreenButton = $<HTMLButtonElement>('#fullscreen');
const toast = $<HTMLElement>('#toast');
const viewportMeta = $<HTMLMetaElement>('meta[name="viewport"]');
const slideView = new SlideView($<HTMLImageElement>('#slide'), $('#slide-status'), $('#slide-counter'));

const boardBg = $<HTMLImageElement>('#board-bg');
const boardLocked = $<HTMLElement>('#board-locked');
const boardStatus = $<HTMLElement>('#board-status');
const boardSubmit = $<HTMLButtonElement>('#board-submit');
const undoButton = $<HTMLButtonElement>('#undo');
const redoButton = $<HTMLButtonElement>('#redo');
const clearButton = $<HTMLButtonElement>('#clear');
const promptEl = $<HTMLElement>('#q-prompt');
const boardHead = $<HTMLElement>('.board-head');
const textSlide = $<HTMLImageElement>('#text-slide');
const textForm = $<HTMLFormElement>('#text-form');
const textArea = $<HTMLTextAreaElement>('#answer-text');
const textStatus = $<HTMLElement>('#text-status');
const textSubmit = $<HTMLButtonElement>('#text-submit');
const timers = Array.from(document.querySelectorAll<HTMLElement>('[data-timer]'));

// Si el QR trae ?code=, se usa ese código; si no, el último con el que se unió este dispositivo.
const urlCode = new URLSearchParams(location.search).get('code');
const savedName = storage.get(KEYS.name);
const savedCode = storage.get(KEYS.code);
nameInput.value = savedName ?? '';
codeInput.value = urlCode ?? savedCode ?? '';

/** Credenciales con las que (re)unirse en cada conexión; null mientras el alumno no ha entrado. */
let credentials: Credentials | null =
  savedName && savedCode && (!urlCode || urlCode === savedCode) ? { name: savedName, code: savedCode } : null;

let sessionId = '';
let currentSlide = 0;
let active: ActiveQuestion | null = null;
/** Proporción (ancho / alto) del pizarrón de la pregunta actual. */
let boardAspect = 0;
let timerHandle: number | undefined;
/** La clase terminó: no se muestra el aviso de "sin conexión" ni se intenta volver a unirse. */
let classEnded = false;

const socket = connect<ServerToStudentEvents, StudentToServerEvents>('/student');

// ---------- Pizarrón ----------

// Los cambios van siempre al tablero local; al servidor solo si hay conexión. La corrección no depende
// de que lleguen: al reunirse se reconcilia el estado completo (ver `reconcileActive`). Deshacer es
// `stroke:remove` por id, nunca `stroke:undo` (que saca "el último" del servidor).
const board = new Board($('#board-area'), $('#board-frame'), $('#board-base'), $('#board-live'), {
  add: (stroke) => boardEdit(() => socket.emit('stroke:add', { questionId: activeId(), stroke })),
  remove: (strokeId) => boardEdit(() => socket.emit('stroke:remove', { questionId: activeId(), strokeId })),
  clear: () => boardEdit(() => socket.emit('board:clear', { questionId: activeId() })),
});
board.onChange = refreshToolbar;

function activeId(): string {
  return active?.id ?? '';
}

function boardEdit(send: () => void): void {
  if (socket.connected) send();
  markEdited();
}

/** Registra una edición del alumno (trazo o texto): estado de entrega, aviso de pendientes y guardado local. */
function markEdited(): void {
  const q = active;
  if (!q) return;
  if (!q.synced) q.dirty = true;
  schedulePersist();
  if (q.submitted && !q.changedSinceSubmit) {
    q.changedSinceSubmit = true;
    refreshSubmit();
  }
}

/** Tablero local de la pregunta activa. */
function localStrokes(q: ActiveQuestion): Stroke[] {
  if (q.type === 'text') return [];
  return q.initial ?? board.snapshot();
}

/** Los mismos eventos de siempre, pero a través de la reconciliación compartida con las pruebas. */
const channel: SyncChannel = {
  strokeAdd: (payload) => socket.emit('stroke:add', payload),
  strokeRemove: (payload) => socket.emit('stroke:remove', payload),
  boardClear: (payload) => socket.emit('board:clear', payload),
  answerSubmit: (payload) =>
    new Promise<AckResult>((resolve, reject) => {
      socket.timeout(ACK_TIMEOUT_MS).emit('answer:submit', payload, (err, result) => (err ? reject(err) : resolve(result)));
    }),
};

// ---------- Tablero guardado en el dispositivo ----------

let persistHandle: number | undefined;
let retryHandle: number | undefined;

function schedulePersist(): void {
  window.clearTimeout(persistHandle);
  persistHandle = window.setTimeout(persistNow, PERSIST_DELAY_MS);
}

/** Guarda el tablero local (sobrevive a recargar la pestaña). Si el almacenamiento falla o se llena, se ignora. */
function persistNow(): void {
  window.clearTimeout(persistHandle);
  const q = active;
  if (!q) return;
  const state: LocalBoardState = {
    v: 1,
    strokes: localStrokes(q),
    pendingSubmit: q.pendingSubmit,
    submitted: q.submitted,
    dirty: q.dirty,
    savedAt: Date.now(),
  };
  if (q.type === 'text') state.text = textArea.value;
  storage.set(boardKey(q.sessionId, q.id), serializeBoardState(state));
}

function storedKeys(): string[] {
  try {
    return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '');
  } catch {
    return [];
  }
}

/** Borra los tableros guardados de otras preguntas o sesiones (`keep` = el de la pregunta actual). */
function cleanupBoardKeys(keep?: string): void {
  for (const key of staleBoardKeys(storedKeys(), keep)) storage.remove(key);
}

/** Descarta el estado local de una pregunta. Devuelve si tenía cambios sin enviar. */
function forgetQuestion(q: ActiveQuestion): boolean {
  window.clearTimeout(persistHandle);
  window.clearTimeout(retryHandle);
  storage.remove(boardKey(q.sessionId, q.id));
  if (active === q) active = null;
  return q.dirty || q.pendingSubmit;
}

// iOS puede descartar la pestaña en segundo plano: se guarda al salir sin esperar el retraso.
window.addEventListener('pagehide', persistNow);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) persistNow();
});

function buildToolbar(): void {
  const colors = $('#colors');
  for (const color of BOARD_COLORS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.dataset.color = color;
    button.style.setProperty('--swatch', color);
    button.setAttribute('aria-label', `Color ${color}`);
    button.addEventListener('click', () => {
      board.color = color;
      selectTool('pen');
    });
    colors.append(button);
  }
  const sizes = $('#sizes');
  for (const size of BOARD_SIZES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool size';
    button.dataset.size = String(size);
    button.style.setProperty('--dot', `${4 + size}px`);
    button.setAttribute('aria-label', `Grosor ${size}`);
    button.addEventListener('click', () => {
      board.size = size;
      selectTool('pen');
    });
    sizes.append(button);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    button.addEventListener('click', () => selectTool(button.dataset.tool as Tool));
  }
  undoButton.addEventListener('click', () => board.undo());
  redoButton.addEventListener('click', () => board.redo());
  clearButton.addEventListener('click', () => board.clear());
  // Tabletas con teclado.
  document.addEventListener('keydown', (e) => {
    if (!active || active.type === 'text' || !(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) board.undo();
    else if (key === 'y' || (key === 'z' && e.shiftKey)) board.redo();
    else return;
    e.preventDefault();
  });
  refreshToolbar();
}

function selectTool(tool: Tool): void {
  board.tool = tool;
  refreshToolbar();
}

function refreshToolbar(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    b.setAttribute('aria-pressed', String(b.dataset.tool === board.tool));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('.swatch')) {
    b.setAttribute('aria-pressed', String(board.tool === 'pen' && b.dataset.color === board.color));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('.size')) {
    b.setAttribute('aria-pressed', String(board.tool === 'pen' && Number(b.dataset.size) === board.size));
  }
  undoButton.disabled = !board.canUndo;
  redoButton.disabled = !board.canRedo;
  clearButton.disabled = board.isEmpty;
}

// ---------- Preguntas ----------

const aspectCache = new Map<string, Promise<number>>();

/** Proporción de la diapositiva: el pizarrón la usa para que los trazos normalizados se vean igual en todos lados. */
function slideAspect(index: number): Promise<number> {
  const url = slideUrl(sessionId, index);
  let aspect = aspectCache.get(url);
  if (!aspect) {
    const img = new Image();
    img.src = url;
    aspect = img
      .decode()
      .then(() => img.naturalWidth / img.naturalHeight)
      .catch(() => 4 / 3);
    aspectCache.set(url, aspect);
  }
  return aspect;
}

/**
 * Muestra una pregunta. `fromSync`: viene de un `state:sync` (el servidor acaba de confirmar al alumno), así que
 * además se reconcilia el tablero local con el del servidor, de forma síncrona, antes de cualquier `await`.
 */
async function enterQuestion(
  q: QuestionOpenPayload,
  answer: Answer | undefined,
  remainingMs: number | null,
  fromSync = false,
): Promise<void> {
  const slideIndex = q.slideIndex ?? currentSlide;
  const deadline = remainingMs === null ? null : Date.now() + remainingMs;
  let state: ActiveQuestion;
  const current = active;
  if (current && current.id === q.id && current.sessionId === sessionId) {
    // Misma pregunta (p. ej. tras reconectar): el tablero local manda, no se recarga desde el servidor.
    state = current;
    state.type = q.type;
    state.slideIndex = slideIndex;
    state.deadline = deadline;
  } else {
    if (current) forgetQuestion(current);
    cleanupBoardKeys(boardKey(sessionId, q.id));
    // Un tablero guardado en este dispositivo (p. ej. se recargó la pestaña) vale más que lo que el servidor recuerda.
    const saved = fromSync ? parseBoardState(storage.get(boardKey(sessionId, q.id))) : undefined;
    state = active = {
      id: q.id,
      type: q.type,
      sessionId,
      slideIndex,
      deadline,
      submitted: answer?.submittedAt !== undefined || Boolean(saved?.submitted),
      changedSinceSubmit: false,
      submitting: false,
      synced: !fromSync, // `question:open` en vivo: el servidor ya conoce a este alumno.
      pendingSubmit: saved?.pendingSubmit ?? false,
      dirty: saved?.dirty ?? false,
      initial: q.type === 'text' ? null : (saved?.strokes ?? answer?.strokes ?? []),
    };
    textArea.value = q.type === 'text' ? (saved?.text ?? answer?.text ?? '') : '';
  }

  renderPrompt(q.type, q.prompt);
  if (fromSync) reconcileActive(state, answer);

  if (q.type === 'text') {
    textSlide.src = slideUrl(sessionId, slideIndex);
    showScreen('text');
  } else {
    boardBg.hidden = q.type !== 'overSlide';
    if (q.type === 'overSlide') boardBg.src = slideUrl(sessionId, slideIndex);
    showScreen('board');
    const aspect = await slideAspect(slideIndex);
    if (active !== state) return; // Cambió la pregunta mientras cargaba la imagen.
    boardAspect = aspect;
    if (state.initial) {
      board.load(state.initial, aspect);
      state.initial = null;
      selectTool('pen');
    }
  }
  startTimer();
  refreshSubmit();
}

/**
 * Deja al servidor igual que el tablero local (el alumno es la fuente de verdad mientras la pregunta siga
 * abierta) y envía la entrega pendiente. Cubre una caída de Wi-Fi, los ~18 s en los que el cliente aún no
 * la había notado, y un servidor restaurado con datos de unos segundos atrás.
 */
function reconcileActive(q: ActiveQuestion, server: Answer | undefined): void {
  const isText = q.type === 'text';
  // Entregó antes pero el servidor no lo recuerda (p. ej. reinició con datos viejos): se vuelve a entregar.
  if (q.submitted && server?.submittedAt === undefined) q.pendingSubmit = true;
  const payload = q.pendingSubmit && !isExpired() ? submitPayload(q) : undefined;
  if (q.pendingSubmit && !payload && isText && !isExpired()) q.pendingSubmit = false; // Texto vacío: nada que entregar.
  // Reconciliar y marcar como sincronizado ocurren en el mismo turno: ninguna edición se cuela en medio.
  const { submitted } = reconcileBoard({
    questionId: q.id,
    local: localStrokes(q),
    server: isText ? [] : (server?.strokes ?? []),
    channel,
    ...(payload ? { submit: payload.text === undefined ? {} : { text: payload.text } } : {}),
  });
  q.synced = true;
  q.dirty = false;
  if (submitted) trackSubmit(q, submitted);
  persistNow();
}

/** Enunciado de la pregunta: encima del pizarrón o del cuadro de texto, oculto si no hay. Solo textContent. */
function renderPrompt(type: QuestionType, prompt: string | undefined): void {
  const text = prompt?.trim() ?? '';
  if (promptEl.textContent !== text) {
    promptEl.textContent = text;
    promptEl.scrollTop = 0;
  }
  promptEl.hidden = !text;
  if (type === 'text') {
    if (promptEl.parentElement !== textForm) textForm.prepend(promptEl);
  } else if (promptEl.parentElement !== boardHead) {
    boardHead.append(promptEl);
  }
}

function exitQuestion(message?: string, toastMs?: number): void {
  if (active) forgetQuestion(active);
  active = null;
  promptEl.hidden = true;
  board.setEnabled(false);
  stopTimer();
  textArea.blur();
  showScreen('slides');
  if (message) showToast(message, toastMs);
}

/** Cuerpo de `answer:submit` de la pregunta, o undefined si es de texto y está vacía. */
function submitPayload(q: ActiveQuestion): AnswerSubmitPayload | undefined {
  if (q.type !== 'text') return { questionId: q.id };
  const text = textArea.value.trim();
  return text ? { questionId: q.id, text } : undefined;
}

function submit(): void {
  const q = active;
  if (!q || q.submitting || q.pendingSubmit || isExpired()) return;
  const payload = submitPayload(q);
  if (!payload) {
    setStatus('Escribe tu respuesta antes de entregar.');
    return;
  }
  if (!q.synced) {
    // Sin confirmación del servidor: queda pendiente y sale justo después de reconciliar.
    q.pendingSubmit = true;
    persistNow();
    refreshSubmit();
    return;
  }
  trackSubmit(q, channel.answerSubmit(payload));
}

/** Sigue una entrega en curso (`promise` rechaza si el servidor no responde). */
function trackSubmit(q: ActiveQuestion, promise: Promise<AckResult>): void {
  q.submitting = true;
  refreshSubmit();
  promise.then(
    (result) => finishSubmit(q, result),
    () => finishSubmit(q, undefined),
  );
}

function finishSubmit(q: ActiveQuestion, result: AckResult | undefined): void {
  q.submitting = false;
  if (active !== q) return;
  let overwrite = true;
  if (!result) {
    // Sin respuesta: casi seguro la conexión murió sin que el cliente lo note. Queda pendiente; al reconectar
    // se reenvía tras reconciliar y, si el socket resulta estar bien, se reintenta pasado un rato.
    q.pendingSubmit = true;
    window.clearTimeout(retryHandle);
    retryHandle = window.setTimeout(() => retrySubmit(q), SUBMIT_RETRY_MS);
  } else if (!result.ok) {
    q.pendingSubmit = false;
    setStatus(result.error);
    overwrite = false;
  } else {
    q.pendingSubmit = false;
    q.submitted = true;
    q.changedSinceSubmit = false;
    showToast('¡Entregado!');
  }
  persistNow();
  refreshSubmit(overwrite);
}

function retrySubmit(q: ActiveQuestion): void {
  if (active !== q || !q.pendingSubmit || !q.synced || q.submitting || isExpired()) return;
  const payload = submitPayload(q);
  if (!payload) {
    q.pendingSubmit = false;
    refreshSubmit();
    return;
  }
  trackSubmit(q, channel.answerSubmit(payload));
}

function isExpired(): boolean {
  return Boolean(active?.deadline && Date.now() >= active.deadline);
}

/** Actualiza botón y estado de entrega, y si el pizarrón acepta trazos (solo el fin del tiempo lo bloquea). */
function refreshSubmit(overwriteStatus = true): void {
  const q = active;
  if (!q) return;
  const offline = !socket.connected;
  const expired = isExpired();
  const isText = q.type === 'text';
  const button = isText ? textSubmit : boardSubmit;

  button.disabled = expired || q.submitting || q.pendingSubmit || (q.submitted && !q.changedSinceSubmit);
  button.textContent = q.submitting
    ? 'Enviando…'
    : q.pendingSubmit
      ? 'Pendiente…'
      : !q.submitted
        ? 'Entregar'
        : q.changedSinceSubmit
          ? 'Reenviar'
          : 'Entregado ✓';

  let status = '';
  if (expired) status = 'Se acabó el tiempo.';
  else if (q.pendingSubmit && !q.submitting) {
    status = q.synced ? 'Reintentando la entrega…' : 'Se entregará al volver la conexión.';
  } else if (offline) {
    status = isText
      ? 'Sin conexión: puedes seguir escribiendo; se enviará al volver.'
      : 'Sin conexión: puedes seguir dibujando; se enviará al volver.';
  } else if (q.submitted && q.changedSinceSubmit) status = 'Tienes cambios sin reenviar.';
  else if (q.submitted) status = 'Entregado. Puedes seguir editando y reenviar.';
  else if (!isText && boardAspect > 1.1 && window.innerHeight > window.innerWidth) {
    status = 'Gira el celular para tener un pizarrón más grande.';
  }
  if (overwriteStatus || status) setStatus(status);
  for (const el of [boardStatus, textStatus]) el.classList.toggle('is-offline', offline);

  if (!isText) {
    board.setEnabled(!expired && q.initial === null); // Sin tablero cargado todavía no se dibuja.
    boardLocked.hidden = !expired;
    boardLocked.textContent = 'Se acabó el tiempo';
  } else {
    textArea.readOnly = expired;
  }
}

function setStatus(message: string): void {
  if (active?.type === 'text') textStatus.textContent = message;
  else boardStatus.textContent = message;
}

function startTimer(): void {
  stopTimer();
  const tick = () => {
    const deadline = active?.deadline ?? null;
    for (const t of timers) t.hidden = deadline === null;
    if (deadline === null) return;
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const label = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    for (const t of timers) {
      t.textContent = label;
      t.classList.toggle('urgent', left <= 10);
    }
    if (left === 0) refreshSubmit();
  };
  tick();
  timerHandle = window.setInterval(tick, 250);
}

function stopTimer(): void {
  window.clearInterval(timerHandle);
  for (const t of timers) t.hidden = true;
}

boardSubmit.addEventListener('click', submit);
textForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submit();
});
textArea.addEventListener('input', markEdited);
window.addEventListener('resize', () => refreshSubmit());

// ---------- Pantallas y avisos ----------

function showScreen(screen: Screen): void {
  for (const [name, el] of Object.entries(screens)) el.hidden = name !== screen;
  // Dentro del pizarrón se bloquea el zoom de la página; en las diapositivas se puede hacer zoom.
  viewportMeta.content = screen === 'board' ? VIEWPORT_LOCKED : VIEWPORT_NORMAL;
  document.documentElement.classList.toggle('drawing', screen === 'board');
}

let toastHandle: number | undefined;
function showToast(message: string, ms = 2500): void {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastHandle);
  toastHandle = window.setTimeout(() => (toast.hidden = true), ms);
}

// iOS Safari ignora user-scalable=no: se bloquea el pellizco mientras se dibuja.
document.addEventListener('gesturestart', (e) => {
  if (!screens.board.hidden) e.preventDefault();
});

// ---------- Unirse ----------

function showJoinError(message: string): void {
  joinError.textContent = message;
  joinError.hidden = false;
  showScreen('join');
}

function join(creds: Credentials): void {
  joinButton.disabled = true;
  joinButton.textContent = 'Entrando…';
  socket.timeout(ACK_TIMEOUT_MS).emit('student:join', { ...creds, clientId }, (err, result) => {
    joinButton.disabled = false;
    joinButton.textContent = 'Entrar';
    if (err) return; // Sin respuesta: al reconectar se reintenta automáticamente.
    if (!result.ok) {
      // La sesión ya no existe: lo que el alumno tenía sin enviar se descarta, con aviso.
      const lost = active ? active.dirty || active.pendingSubmit : false;
      credentials = null;
      storage.remove(KEYS.code);
      exitQuestion();
      cleanupBoardKeys();
      showJoinError(lost ? `${result.error} ${LOST_MESSAGE}` : result.error);
      return;
    }
    credentials = creds;
    classEnded = false;
    storage.set(KEYS.name, creds.name);
    storage.set(KEYS.code, creds.code);
    joinError.hidden = true;
  });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const code = codeInput.value.trim();
  if (!name) return showJoinError('Escribe tu nombre.');
  if (!/^\d{4}$/.test(code)) return showJoinError('El código tiene 4 dígitos.');
  credentials = { name, code };
  if (socket.connected) join(credentials);
  else showJoinError('Buscando al profesor… revisa que estés en la red del aula.');
});

// ---------- Eventos del servidor ----------

socket.on('connect', () => {
  // Hasta que llegue el `state:sync` del servidor no hay certeza de qué recibió; socket.io además reenvía su
  // búfer antes de este `student:join`, y esos eventos el servidor los descarta (aún no estamos unidos).
  if (active) active.synced = false;
  if (credentials) join(credentials);
});

socket.on('disconnect', () => {
  if (active) active.synced = false;
  persistNow();
});

socket.on('state:sync', (state) => {
  const prev = active;
  sessionId = state.sessionId;
  currentSlide = state.slideIndex;
  slideView.load(state.sessionId, state.slideCount, state.slideIndex);
  slideView.show(state.slideIndex);
  const q = state.question;
  // La pregunta del alumno se cerró (o cambió, o cambió la sesión) mientras no tenía conexión: se descarta lo local.
  const stillOpen = Boolean(prev && q && q.id === prev.id && prev.sessionId === state.sessionId);
  const lost = prev && !stillOpen ? forgetQuestion(prev) : false;
  if (q) {
    if (lost) showToast(LOST_MESSAGE, 7000);
    const remaining = q.timeLimitSec === undefined ? null : q.openedAt + q.timeLimitSec * 1000 - state.serverNow;
    void enterQuestion(q, state.myAnswer, remaining, true);
  } else if (prev) {
    exitQuestion(lost ? LOST_MESSAGE : 'La pregunta se cerró.', lost ? 7000 : undefined);
    cleanupBoardKeys();
  } else {
    cleanupBoardKeys();
    showScreen('slides');
  }
});

socket.on('slide:goto', ({ index }) => {
  currentSlide = index;
  slideView.show(index);
});

socket.on('question:open', (q) => {
  void enterQuestion(q, undefined, q.timeLimitSec === undefined ? null : q.timeLimitSec * 1000);
});

socket.on('question:close', ({ id }) => {
  if (active?.id === id) exitQuestion(isExpired() ? 'Se acabó el tiempo.' : 'El profesor cerró la pregunta.');
});

// El profesor terminó la clase: se sale de la pregunta y ya no se reintenta unirse con ese código.
socket.on('session:end', () => {
  classEnded = true;
  credentials = null;
  storage.remove(KEYS.code);
  exitQuestion();
  cleanupBoardKeys();
  offlineBanner.hidden = true;
  showScreen('ended');
});

$('#rejoin').addEventListener('click', () => {
  classEnded = false;
  nameInput.value = storage.get(KEYS.name) ?? nameInput.value;
  codeInput.value = '';
  joinError.hidden = true;
  joinButton.disabled = false;
  joinButton.textContent = 'Entrar';
  // Si el QR de la clase anterior traía ?code=, se quita para no volver a rellenar el código viejo.
  history.replaceState(null, '', location.pathname);
  showScreen('join');
  codeInput.focus();
});

watchConnection(socket, (state) => {
  offlineBanner.hidden = state !== 'offline' || classEnded;
  refreshSubmit();
});

if (document.fullscreenEnabled) {
  fullscreenButton.hidden = false;
  fullscreenButton.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  });
}

buildToolbar();
showScreen('join');
if (credentials) {
  joinButton.disabled = true;
  joinButton.textContent = 'Reconectando…';
}
