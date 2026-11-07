import type { Socket } from 'socket.io-client';
import { slideUrl } from '../../shared/slides.js';
import type {
  ClassInfo,
  QuestionOpenPayload,
  ServerToTeacherEvents,
  SessionInfo,
  TeacherAuth,
  TeacherToServerEvents,
} from '../../shared/types.js';
import { api, TEACHER_SESSION_KEY } from '../common/api.js';
import { $, connect, randomId, storage, watchConnection } from '../common/socket.js';
import { bindControls, PreparedBar, QuestionControls, type QuestionLaunch, setNavState } from './controls.js';
import { AnswerGrid, AnswersModel, BigAnswer } from './grid.js';
import './style.css';

type TeacherSocket = Socket<ServerToTeacherEvents, TeacherToServerEvents>;

const NAMES_KEY = 'aula.teacher.showNames';

const presentScreen = $<HTMLElement>('#present');
const slideImg = $<HTMLImageElement>('#slide');
const counter = $<HTMLElement>('#counter');
const prevButton = $<HTMLButtonElement>('#prev');
const nextButton = $<HTMLButtonElement>('#next');
const connectedCount = $<HTMLElement>('#connected');
const qrOverlay = $<HTMLElement>('#qr-overlay');
const offlineBanner = $<HTMLElement>('#offline');
const answerGrid = $<HTMLElement>('#answer-grid');
const toggleView = $<HTMLButtonElement>('#toggle-view');
const toggleNames = $<HTMLButtonElement>('#toggle-names');
const spotlightEl = $<HTMLElement>('#spotlight');
const spotlightName = $<HTMLButtonElement>('#spotlight-name');

let socket: TeacherSocket | null = null;
let info: SessionInfo | null = null;
let slideIndex = 0;
let slideCount = 0;
/** Clase que se está dando (para las preguntas preparadas) y cuáles ya se lanzaron en esta sesión. */
let classInfo: ClassInfo | null = null;
const launchedPrepared = new Set<string>();

const model = new AnswersModel();
const grid = new AnswerGrid(answerGrid, model, pickStudent);
const bigAnswer = new BigAnswer($('#spotlight-body'), model);
let namesVisible = storage.get(NAMES_KEY) === '1';
let view: 'slide' | 'grid' = 'slide';

const questions = new QuestionControls(openQuestion, (id) => socket?.emit('question:close', { id }));
const preparedBar = new PreparedBar((q) => {
  const launch: QuestionLaunch = { type: q.type, preparedId: q.id };
  if (q.timeLimitSec !== undefined) launch.timeLimitSec = q.timeLimitSec;
  if (q.prompt !== undefined) launch.prompt = q.prompt;
  openQuestion(launch);
});

function openQuestion(launch: QuestionLaunch): void {
  if (!socket?.connected) return;
  // Cada lanzamiento lleva un id nuevo, aunque sea una pregunta preparada que se repite.
  const payload: QuestionOpenPayload = { id: randomId(8), type: launch.type, slideIndex };
  if (launch.timeLimitSec !== undefined) payload.timeLimitSec = launch.timeLimitSec;
  if (launch.prompt !== undefined) payload.prompt = launch.prompt;
  if (launch.preparedId !== undefined) payload.preparedId = launch.preparedId;
  socket.emit('question:open', payload);
}

/** Botones de las preguntas preparadas para la diapositiva actual. */
function renderPrepared(): void {
  const forSlide = classInfo?.questions.filter((q) => q.slideIndex === slideIndex) ?? [];
  preparedBar.render(forSlide, launchedPrepared, Boolean(socket?.connected));
}

// ---------- Cuadrícula de respuestas ----------

/** Muestra la diapositiva o la cuadrícula; el botón permite volver a la cuadrícula (también congelada, tras cerrar). */
function renderStage(): void {
  const q = model.question;
  if (!q) view = 'slide';
  const showGrid = view === 'grid';
  slideImg.hidden = showGrid;
  answerGrid.hidden = !showGrid;
  toggleView.hidden = !q;
  toggleView.textContent = showGrid ? 'Ver diapositiva' : q?.closed ? 'Ver respuestas' : 'Ver cuadrícula';
  toggleNames.hidden = !showGrid;
}

function renderNames(): void {
  grid.setShowNames(namesVisible);
  toggleNames.textContent = namesVisible ? 'Ocultar nombres' : 'Mostrar nombres';
}

function pickStudent(studentId: string): void {
  socket?.emit('answer:spotlight', { studentId, showName: namesVisible });
}

/** El eco del servidor decide qué se ve en grande (igual en todas las ventanas del profesor). */
function renderSpotlight(): void {
  const spot = model.spotlight;
  spotlightEl.hidden = !spot;
  if (!spot) return;
  bigAnswer.show(spot.studentId, spot.showName);
  spotlightName.textContent = spot.showName ? 'Ocultar nombre' : 'Mostrar nombre';
}

function closeSpotlight(): void {
  socket?.emit('answer:spotlight', { studentId: null, showName: false });
}

model.subscribe({
  question: (change) => {
    if (change === 'open') view = 'grid';
    else if (change === 'close') view = 'slide';
    else if (change === 'sync') view = model.question && !model.question.closed ? 'grid' : 'slide';
    renderStage();
  },
  spotlight: renderSpotlight,
});

toggleView.addEventListener('click', () => {
  view = view === 'grid' ? 'slide' : 'grid';
  renderStage();
});
toggleNames.addEventListener('click', () => {
  namesVisible = !namesVisible;
  storage.set(NAMES_KEY, namesVisible ? '1' : '0');
  renderNames();
});
spotlightName.addEventListener('click', () => {
  const spot = model.spotlight;
  if (spot) socket?.emit('answer:spotlight', { studentId: spot.studentId, showName: !spot.showName });
});
$('#spotlight-close').addEventListener('click', closeSpotlight);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !spotlightEl.hidden) closeSpotlight();
});
$('#open-projector').addEventListener('click', () => window.open('/teacher/proyector', 'aula-proyector'));
renderNames();
renderStage();

// ---------- Navegación ----------

function goToLibrary(): void {
  location.replace('/teacher/clases');
}

/** Al terminar la clase (aquí o en otra ventana) se abre el resumen con todas las respuestas. */
function goToSummary(classId: string, sessionId: string): void {
  storage.remove(TEACHER_SESSION_KEY);
  location.replace(`/teacher/resumen?c=${encodeURIComponent(classId)}&s=${encodeURIComponent(sessionId)}`);
}

async function fetchInfo(sessionId: string): Promise<SessionInfo | null> {
  return api.sessionInfo(sessionId).catch(() => null);
}

// ---------- Sesión en curso ----------

function enterSession(session: SessionInfo): void {
  info = session;
  slideIndex = session.slideIndex;
  slideCount = session.slideCount;
  renderSessionInfo(session);
  renderSlide();
  presentScreen.hidden = false;

  // Preguntas preparadas de la clase y cuáles ya se lanzaron (también tras recargar la página).
  void api
    .getClass(session.classId)
    .then((c) => {
      classInfo = c;
      renderPrepared();
    })
    .catch(() => undefined);
  void api
    .sessionSummary(session.classId, session.sessionId)
    .then((summary) => {
      for (const { question } of summary.questions) if (question.preparedId) launchedPrepared.add(question.preparedId);
      renderPrepared();
    })
    .catch(() => undefined);

  socket?.disconnect();
  model.start(session.sessionId);
  const auth: TeacherAuth = { sessionId: session.sessionId };
  const s = connect<ServerToTeacherEvents, TeacherToServerEvents>('/teacher', auth);
  socket = s;
  model.bind(s);

  s.on('connect_error', (err) => {
    if (err.message === 'PIN_REQUIRED' || err.message === 'PIN_NOT_SET') {
      // Otro dispositivo sin autorización: se pide el PIN y se vuelve a esta misma página.
      location.href = `/teacher/pin?next=${encodeURIComponent(location.pathname + location.search)}`;
    } else if (err.message === 'SESSION_ENDED') {
      const data = (err as Error & { data?: { classId?: string } }).data;
      goToSummary(data?.classId ?? session.classId, session.sessionId);
    } else if (err.message === 'SESSION_NOT_FOUND') {
      // El servidor se reinició: la clase y sus respuestas siguen en "Mis clases".
      storage.remove(TEACHER_SESSION_KEY);
      goToLibrary();
    }
  });
  s.on('session:end', ({ classId, sessionId }) => goToSummary(classId, sessionId));
  s.on('state:sync', (state) => {
    slideIndex = state.slideIndex;
    slideCount = state.slideCount;
    renderSlide();
    const q = state.question;
    questions.set(
      q
        ? {
            id: q.id,
            type: q.type,
            // Tiempo restante según el reloj del servidor, convertido al reloj de esta laptop.
            deadline: q.timeLimitSec === undefined ? null : Date.now() + q.openedAt + q.timeLimitSec * 1000 - state.serverNow,
            ...(q.prompt !== undefined ? { prompt: q.prompt } : {}),
          }
        : null,
    );
  });
  s.on('question:open', (q) => {
    questions.set({
      id: q.id,
      type: q.type,
      deadline: q.timeLimitSec === undefined ? null : Date.now() + q.timeLimitSec * 1000,
      ...(q.prompt !== undefined ? { prompt: q.prompt } : {}),
    });
    if (q.preparedId) {
      launchedPrepared.add(q.preparedId);
      renderPrepared();
    }
  });
  s.on('question:close', ({ id }) => {
    if (questions.current?.id === id) questions.set(null);
  });
  s.on('slide:goto', ({ index }) => {
    slideIndex = index;
    renderSlide();
  });
  s.on('answer:status', ({ connected, submitted }) => {
    connectedCount.textContent = String(connected);
    questions.setStatus(connected, submitted);
  });
  watchConnection(s, (state) => {
    offlineBanner.hidden = state !== 'offline' || socket !== s;
    questions.setEnabled(state === 'online');
    renderPrepared();
  });
}

function renderSessionInfo(session: SessionInfo): void {
  const url = session.joinUrl.replace(/\?code=\d+$/, '');
  $('#code').textContent = session.code;
  $('#qr-code').textContent = session.code;
  $('#join-url').textContent = url;
  $('#qr-url').textContent = url;
  // SVG generado por nuestro propio servidor a partir de la URL.
  $('#qr').innerHTML = session.qrSvg;
  $('#qr-big').innerHTML = session.qrSvg;
  const altList = $<HTMLUListElement>('#alt-urls');
  altList.replaceChildren(
    ...session.altJoinUrls.map((u) => {
      const li = document.createElement('li');
      li.textContent = u;
      return li;
    }),
  );
  $('#alt-urls-box').hidden = session.altJoinUrls.length === 0;
}

function renderSlide(): void {
  if (!info) return;
  slideImg.src = slideUrl(info.sessionId, slideIndex);
  counter.textContent = `${slideIndex + 1} / ${slideCount}`;
  setNavState(prevButton, nextButton, slideIndex, slideCount);
  renderPrepared();
  // Precarga la siguiente para que el cambio sea instantáneo también en la vista del profesor.
  if (slideIndex + 1 < slideCount) new Image().src = slideUrl(info.sessionId, slideIndex + 1);
}

function gotoSlide(index: number): void {
  if (!socket?.connected || index < 0 || index >= slideCount || index === slideIndex) return;
  // Avance inmediato en la vista (varias pulsaciones seguidas acumulan); el eco `slide:goto`
  // del servidor, que es la fuente de verdad, confirma o corrige.
  slideIndex = index;
  renderSlide();
  socket.emit('slide:goto', { index });
}

async function toggleQr(): Promise<void> {
  if (!info) return;
  if (!qrOverlay.hidden) {
    qrOverlay.hidden = true;
    return;
  }
  // La IP pudo cambiar (p. ej. se encendió el hotspot después de crear la sesión).
  const fresh = await fetchInfo(info.sessionId);
  if (fresh) {
    info = fresh;
    renderSessionInfo(fresh);
  }
  qrOverlay.hidden = false;
}

bindControls(prevButton, nextButton, {
  step: (delta) => gotoSlide(slideIndex + delta),
  goto: (where) => gotoSlide(where === 'first' ? 0 : slideCount - 1),
  toggleQr: () => void toggleQr(),
  closeOverlays: () => (qrOverlay.hidden = true),
});

$('#show-qr').addEventListener('click', () => void toggleQr());
$('#close-qr').addEventListener('click', () => (qrOverlay.hidden = true));
qrOverlay.addEventListener('click', (event) => {
  if (event.target === qrOverlay) qrOverlay.hidden = true;
});
$('#end-class').addEventListener('click', () => {
  if (!socket || !info) return;
  const ok = confirm(
    '¿Terminar la clase? Se cerrará la pregunta abierta, los alumnos verán que la clase terminó ' +
      'y se abrirá el resumen con todas las respuestas.',
  );
  if (!ok) return;
  const { classId, sessionId } = info;
  // Si ya había terminado (p. ej. desde otra ventana), igual se abre el resumen.
  socket.emit('session:end', () => goToSummary(classId, sessionId));
});

// ---------- Arranque ----------

async function start(): Promise<void> {
  const saved = storage.get(TEACHER_SESSION_KEY);
  const session = saved ? await fetchInfo(saved) : null;
  if (session) enterSession(session);
  else goToLibrary(); // Sin clase en curso: la biblioteca es el inicio del profesor.
}

void start();
