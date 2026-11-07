// Página del PIN: otro dispositivo (no la laptop) ingresa el PIN para abrir las vistas del profesor.
import { ApiError, api } from '../common/api.js';
import { $ } from '../common/socket.js';
import './style.css';
import './pin.css';

const loadingEl = $<HTMLElement>('#pin-loading');
const formEl = $<HTMLFormElement>('#pin-form');
const inputEl = $<HTMLInputElement>('#pin-input');
const submitEl = $<HTMLButtonElement>('#pin-submit');
const errorEl = $<HTMLElement>('#pin-error');
const notSetEl = $<HTMLElement>('#pin-notset');
const loadErrorEl = $<HTMLElement>('#pin-error-load');

const DEFAULT_NEXT = '/teacher/clases';

/** Solo se vuelve a rutas del profesor del mismo origen (evita redirecciones abiertas). */
function nextUrl(): string {
  const next = new URLSearchParams(location.search).get('next') ?? '';
  const valid = /^\/teacher(?:[/?#]|$)/.test(next) && !/[\\\u0000-\u001f]/.test(next);
  return valid && !next.startsWith('/teacher/pin') ? next : DEFAULT_NEXT;
}

function showError(text: string): void {
  errorEl.textContent = text;
  errorEl.hidden = false;
}

// Cuenta regresiva cuando el servidor bloquea los intentos (429).
let lockTimer: number | undefined;

function lockFor(seconds: number): void {
  window.clearInterval(lockTimer);
  let left = Math.max(1, Math.ceil(seconds));
  const tick = () => {
    if (left <= 0) {
      window.clearInterval(lockTimer);
      lockTimer = undefined;
      errorEl.hidden = true;
      submitEl.disabled = false;
      inputEl.disabled = false;
      inputEl.focus();
      return;
    }
    const wait = left < 60 ? `${left} s` : `${Math.floor(left / 60)} min ${String(left % 60).padStart(2, '0')} s`;
    showError(`Demasiados intentos. Vuelve a intentarlo en ${wait}.`);
    left -= 1;
  };
  submitEl.disabled = true;
  inputEl.disabled = true;
  tick();
  lockTimer = window.setInterval(tick, 1000);
}

formEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const pin = inputEl.value.trim();
  if (!/^\d{4,8}$/.test(pin)) {
    showError('El PIN tiene de 4 a 8 dígitos.');
    return;
  }
  errorEl.hidden = true;
  submitEl.disabled = true;
  api
    .pinLogin(pin)
    .then(() => {
      location.replace(nextUrl());
    })
    .catch((err: unknown) => {
      inputEl.value = '';
      if (err instanceof ApiError && err.retryAfterSec) {
        lockFor(err.retryAfterSec);
        return;
      }
      showError(err instanceof ApiError ? err.message : 'No se pudo comprobar el PIN. Inténtalo de nuevo.');
      submitEl.disabled = false;
      inputEl.focus();
    });
});

api
  .pinStatus()
  .then((status) => {
    loadingEl.hidden = true;
    if (status.local || status.authorized) {
      location.replace(nextUrl()); // La laptop (o un dispositivo ya autorizado) no necesita el PIN.
    } else if (!status.configured) {
      notSetEl.hidden = false;
    } else {
      formEl.hidden = false;
      inputEl.focus();
    }
  })
  .catch((err: unknown) => {
    loadingEl.hidden = true;
    loadErrorEl.textContent = err instanceof ApiError ? err.message : 'No se pudo consultar el servidor.';
    loadErrorEl.hidden = false;
  });
