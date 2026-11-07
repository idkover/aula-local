// Ventana de proyección para una segunda pantalla: solo la diapositiva actual o, si el profesor
// abrió una respuesta en grande, esa respuesta (con el nombre solo si showName). Nunca la cuadrícula.
import { slideUrl } from '../../shared/slides.js';
import type { ServerToTeacherEvents, TeacherAuth, TeacherToServerEvents } from '../../shared/types.js';
import { $, connect, storage } from '../common/socket.js';
import { AnswersModel, BigAnswer } from './grid.js';
import './style.css';
import './projector.css';

const SESSION_KEY = 'aula.teacher.sessionId';

const slideImg = $<HTMLImageElement>('#slide');
const bigEl = $<HTMLElement>('#big');
const message = $<HTMLElement>('#message');
const fullscreenButton = $<HTMLButtonElement>('#fullscreen');

function showMessage(text: string): void {
  message.textContent = text;
  message.hidden = false;
  slideImg.hidden = true;
  bigEl.hidden = true;
}

function start(): void {
  const sessionId = storage.get(SESSION_KEY);
  if (!sessionId) {
    showMessage('Abre primero /teacher en esta misma computadora');
    return;
  }

  const model = new AnswersModel();
  const big = new BigAnswer(bigEl, model);
  let slideIndex = 0;
  let slideCount = 0;

  const renderSlide = (): void => {
    if (slideCount === 0) return;
    message.hidden = true;
    slideImg.hidden = false;
    slideImg.src = slideUrl(sessionId, slideIndex);
    if (slideIndex + 1 < slideCount) new Image().src = slideUrl(sessionId, slideIndex + 1);
  };

  model.subscribe({
    spotlight: () => {
      const spot = model.spotlight;
      bigEl.hidden = !spot;
      if (spot) big.show(spot.studentId, spot.showName);
    },
  });

  model.start(sessionId);
  const auth: TeacherAuth = { sessionId };
  const socket = connect<ServerToTeacherEvents, TeacherToServerEvents>('/teacher', auth);
  model.bind(socket);
  socket.on('connect_error', (err) => {
    if (err.message === 'PIN_REQUIRED' || err.message === 'PIN_NOT_SET') {
      // Otro dispositivo sin autorización: se pide el PIN y se vuelve a esta misma página.
      location.href = `/teacher/pin?next=${encodeURIComponent(location.pathname + location.search)}`;
    } else if (err.message === 'SESSION_ENDED') showMessage('La clase terminó.');
    else if (err.message === 'SESSION_NOT_FOUND') showMessage('La sesión ya no existe. Abre /teacher en esta misma computadora.');
  });
  socket.on('session:end', () => {
    socket.disconnect();
    showMessage('La clase terminó.');
  });
  socket.on('state:sync', (state) => {
    slideIndex = state.slideIndex;
    slideCount = state.slideCount;
    renderSlide();
  });
  socket.on('slide:goto', ({ index }) => {
    slideIndex = index;
    renderSlide();
  });

  // Si el profesor crea otra sesión, esta ventana se reinicia sola.
  window.addEventListener('storage', (event) => {
    if (event.key === SESSION_KEY) location.reload();
  });
}

fullscreenButton.addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => undefined);
});

start();
