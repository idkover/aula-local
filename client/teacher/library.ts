// Biblioteca de clases del profesor: crear, preparar (editor), dar, ver historial y eliminar.
import type { AppInfo, ClassListItem, PinStatus, SessionListItem, SessionStatus } from '../../shared/types.js';
import { ApiError, api, formatDateTime, TEACHER_SESSION_KEY } from '../common/api.js';
import { $, storage } from '../common/socket.js';
import { clearError, Editor, el, showError, startClassAndGo } from './editor.js';
import './style.css';
import './library.css';

const libraryEl = $<HTMLElement>('#library');
const listEl = $<HTMLElement>('#class-list');
const historyEl = $<HTMLElement>('#history');
const statusEl = $<HTMLElement>('#library-status');
const errorEl = $<HTMLElement>('#library-error');
const newButton = $<HTMLButtonElement>('#new-class');
const quickButton = $<HTMLButtonElement>('#quick-class');
const quickInput = $<HTMLInputElement>('#quick-pdf');
const newForm = $<HTMLFormElement>('#new-class-form');
const newTitle = $<HTMLInputElement>('#new-title');
const newPdf = $<HTMLInputElement>('#new-pdf');
const newSubmit = $<HTMLButtonElement>('#new-submit');
const newCancel = $<HTMLButtonElement>('#new-cancel');
const pinOpen = $<HTMLButtonElement>('#pin-open');
const pinDialog = $<HTMLDialogElement>('#pin-dialog');
const pinForm = $<HTMLFormElement>('#pin-form');
const pinTitle = $<HTMLElement>('#pin-title');
const pinExplain = $<HTMLElement>('#pin-explain');
const pinCurrentField = $<HTMLElement>('#pin-current-field');
const pinCurrent = $<HTMLInputElement>('#pin-current');
const pinNew = $<HTMLInputElement>('#pin-new');
const pinConfirm = $<HTMLInputElement>('#pin-confirm');
const pinDialogError = $<HTMLElement>('#pin-dialog-error');
const pinCancel = $<HTMLButtonElement>('#pin-cancel');
const pinSubmit = $<HTMLButtonElement>('#pin-submit');
const updateBanner = $<HTMLElement>('#update-banner');
const updateText = $<HTMLElement>('#update-text');
const updateLink = $<HTMLAnchorElement>('#update-link');
const updateNotes = $<HTMLElement>('#update-notes');
const appVersion = $<HTMLElement>('#app-version');

const CONVERTING = 'Convirtiendo el PDF… puede tardar unos segundos por página';
const STATUS_LABELS: Record<SessionStatus, string> = {
  live: 'En curso',
  ended: 'Terminada',
  interrupted: 'Interrumpida (el servidor se apagó)',
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function setStatus(text: string | null): void {
  statusEl.textContent = text ?? '';
  statusEl.hidden = text === null;
}

/** Bloquea los botones mientras dura la operación y muestra el error del servidor si falla. */
async function run(buttons: HTMLButtonElement[], work: () => Promise<void>): Promise<void> {
  clearError(errorEl);
  for (const b of buttons) b.disabled = true;
  try {
    await work();
  } catch (err) {
    showError(errorEl, err);
  } finally {
    for (const b of buttons) b.disabled = false;
    setStatus(null);
  }
}

// ---------- Rutas: /teacher/clases y /teacher/clases?preparar=<id> ----------

const editor = new Editor({
  onBack: () => navigate(null),
  onLoadError: (err) => {
    history.replaceState(null, '', location.pathname);
    showLibrary();
    showError(errorEl, err);
  },
});

let routedUrl = location.pathname + location.search;

function navigate(classId: string | null): void {
  const url = classId ? `${location.pathname}?preparar=${encodeURIComponent(classId)}` : location.pathname;
  history.pushState(null, '', url);
  routedUrl = url;
  route();
}

function route(): void {
  const classId = new URLSearchParams(location.search).get('preparar');
  if (classId) showEditor(classId);
  else showLibrary();
}

function showEditor(classId: string): void {
  libraryEl.hidden = true;
  document.title = 'Aula · Preparar clase';
  void editor.open(classId);
}

function showLibrary(): void {
  editor.close();
  libraryEl.hidden = false;
  document.title = 'Aula · Mis clases';
  void loadList();
}

window.addEventListener('popstate', () => {
  if (!editor.confirmDiscard()) {
    // No se puede cancelar el retroceso: se vuelve a poner la URL del editor.
    history.pushState(null, '', routedUrl);
    return;
  }
  routedUrl = location.pathname + location.search;
  route();
});

window.addEventListener('beforeunload', (event) => {
  if (editor.dirty) event.preventDefault();
});

// ---------- Lista de clases ----------

async function loadList(): Promise<void> {
  try {
    renderList(await api.listClasses());
  } catch (err) {
    showError(errorEl, err);
  }
}

function renderList(classes: ClassListItem[]): void {
  listEl.replaceChildren();
  if (classes.length === 0) {
    const empty = el('div', 'empty-state');
    empty.append(
      el('h2', undefined, 'Todavía no tienes clases'),
      el('p', 'muted', 'Sube una presentación en PDF con "Nueva clase" y prepara las preguntas de cada diapositiva antes de entrar al aula.'),
    );
    const create = el('button', 'accent', 'Crear mi primera clase');
    create.type = 'button';
    create.addEventListener('click', () => openNewForm());
    empty.append(create);
    listEl.append(empty);
    return;
  }
  for (const item of classes) listEl.append(classCard(item));
}

function classCard(item: ClassListItem): HTMLElement {
  const card = el('article', 'class-card');
  const head = el('div', 'card-head');
  head.append(el('h2', item.title ? 'card-title' : 'card-title untitled', item.title || 'Clase sin título'));
  if (item.liveSessionId) head.append(el('span', 'live-badge', 'En curso'));
  card.append(head);
  if (!item.title) card.append(el('p', 'muted small', `Creada el ${formatDateTime(item.createdAt)}`));

  const stats = el('ul', 'card-stats');
  stats.append(
    el('li', undefined, plural(item.slideCount, 'diapositiva', 'diapositivas')),
    el('li', undefined, plural(item.questionCount, 'pregunta preparada', 'preguntas preparadas')),
    el('li', undefined, plural(item.sessionCount, 'vez dada', 'veces dada')),
  );
  card.append(stats);
  card.append(
    el(
      'p',
      'muted small',
      item.lastSessionAt ? `Última vez: ${formatDateTime(item.lastSessionAt)}` : 'Todavía no has dado esta clase',
    ),
  );

  const actions = el('div', 'card-actions');
  const start = el('button', 'accent', item.liveSessionId ? 'Volver a la clase' : 'Dar clase');
  const prepare = el('button', 'secondary', 'Preparar');
  const hist = el('button', 'secondary', 'Historial');
  const del = el('button', 'danger', 'Eliminar');
  for (const b of [start, prepare, hist, del]) b.type = 'button';
  const all = [start, prepare, hist, del];

  start.addEventListener('click', () => void run(all, () => startClassAndGo(item.id)));
  prepare.addEventListener('click', () => navigate(item.id));
  hist.addEventListener('click', () => void run([hist], () => showHistory(item)));
  del.addEventListener('click', () => {
    const name = item.title || 'esta clase sin título';
    const ok = confirm(
      `¿Eliminar "${name}"?\n\nSe borrarán el PDF, las preguntas preparadas y todo el historial de respuestas de los alumnos. No se puede deshacer.`,
    );
    if (!ok) return;
    void run(all, async () => {
      await api.deleteClass(item.id);
      if (historyEl.dataset['classId'] === item.id) historyEl.hidden = true;
      await loadList();
    });
  });

  actions.append(start, prepare, hist, del);
  card.append(actions);
  return card;
}

// ---------- Historial ----------

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

async function showHistory(item: ClassListItem): Promise<void> {
  const sessions = await api.listSessions(item.id);
  sessions.sort((a, b) => b.startedAt - a.startedAt);
  historyEl.dataset['classId'] = item.id;
  historyEl.replaceChildren();

  const head = el('div', 'history-head');
  head.append(el('h2', undefined, `Historial: ${item.title || 'Clase sin título'}`));
  const close = el('button', 'secondary', 'Cerrar');
  close.type = 'button';
  close.addEventListener('click', () => {
    historyEl.hidden = true;
  });
  head.append(close);
  historyEl.append(head);

  if (sessions.length === 0) {
    historyEl.append(el('p', 'muted', 'Todavía no has dado esta clase'));
  } else {
    const ul = el('ul', 'history-list');
    for (const s of sessions) ul.append(sessionRow(item.id, s));
    historyEl.append(ul);
  }
  historyEl.hidden = false;
  historyEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function sessionRow(classId: string, s: SessionListItem): HTMLElement {
  const li = el('li');
  const link = el('a', 'history-row');
  link.href = `/teacher/resumen?c=${encodeURIComponent(classId)}&s=${encodeURIComponent(s.id)}`;
  const when = el('strong', undefined, formatDateTime(s.startedAt));
  const status = el('span', `session-status ${s.status}`, STATUS_LABELS[s.status]);
  const details = [
    s.endedAt ? duration(s.endedAt - s.startedAt) : null,
    plural(s.studentCount, 'alumno', 'alumnos'),
    plural(s.questionCount, 'pregunta', 'preguntas'),
  ].filter((x): x is string => x !== null);
  link.append(when, status, el('span', 'muted', details.join(' · ')));
  li.append(link);
  return li;
}

// ---------- Nueva clase y clase rápida ----------

function openNewForm(): void {
  newForm.hidden = false;
  newTitle.focus();
  newForm.scrollIntoView({ block: 'nearest' });
}

newButton.addEventListener('click', () => {
  if (newForm.hidden) openNewForm();
  else newForm.hidden = true;
});

newCancel.addEventListener('click', () => {
  newForm.reset();
  newForm.hidden = true;
});

newForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const file = newPdf.files?.[0];
  if (!file) return;
  void run([newSubmit, newCancel, newButton, quickButton], async () => {
    setStatus(CONVERTING);
    const created = await api.createClass(file, newTitle.value.trim());
    newForm.reset();
    newForm.hidden = true;
    navigate(created.id);
  });
});

quickButton.addEventListener('click', () => quickInput.click());

quickInput.addEventListener('change', () => {
  const file = quickInput.files?.[0];
  quickInput.value = '';
  if (!file) return;
  void run([newSubmit, newButton, quickButton], async () => {
    setStatus(CONVERTING);
    const info = await api.quickSession(file);
    storage.set(TEACHER_SESSION_KEY, info.sessionId);
    location.href = '/teacher';
    await new Promise<never>(() => {}); // la página se está cerrando: los botones siguen bloqueados
  });
});

// ---------- PIN del profesor ----------

let pin: PinStatus | undefined;
const PIN_RE = /^\d{4,8}$/;

/** Botón discreto: "Crear PIN" (solo en la laptop, mientras no exista) o "Cambiar PIN". */
function renderPinButton(): void {
  if (!pin || (!pin.configured && !pin.local)) {
    pinOpen.hidden = true;
    return;
  }
  pinOpen.textContent = pin.configured ? 'Cambiar PIN' : 'Crear PIN';
  pinOpen.hidden = false;
}

function openPinDialog(): void {
  if (!pin || pinDialog.open) return;
  const creating = !pin.configured;
  const needCurrent = pin.configured && !pin.local;
  pinForm.reset();
  pinDialogError.hidden = true;
  pinTitle.textContent = creating ? 'Crea un PIN para el profesor' : 'Cambiar el PIN';
  pinExplain.textContent = creating
    ? 'Lo pedirán otros dispositivos que abran la vista del profesor; en esta laptop no se pide.'
    : needCurrent
      ? 'Al cambiarlo, los demás dispositivos tendrán que ingresar el PIN nuevo.'
      : 'Al cambiarlo, los demás dispositivos tendrán que ingresar el PIN nuevo; esta laptop no lo necesita.';
  pinCurrentField.hidden = !needCurrent;
  pinCurrent.required = needCurrent;
  pinCancel.textContent = creating ? 'Ahora no' : 'Cancelar';
  pinDialog.showModal();
  (needCurrent ? pinCurrent : pinNew).focus();
}

async function refreshPin(): Promise<void> {
  try {
    pin = await api.pinStatus();
  } catch {
    return; // Sin estado no hay botón: el resto de la biblioteca sigue funcionando.
  }
  renderPinButton();
}

pinOpen.addEventListener('click', openPinDialog);
pinCancel.addEventListener('click', () => pinDialog.close());
pinDialog.addEventListener('close', () => pinForm.reset());

pinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const needCurrent = !pinCurrentField.hidden;
  const fail = (text: string) => {
    pinDialogError.textContent = text;
    pinDialogError.hidden = false;
  };
  if (!PIN_RE.test(pinNew.value)) return fail('El PIN debe tener de 4 a 8 dígitos (solo números).');
  if (pinNew.value !== pinConfirm.value) return fail('Los dos PIN no coinciden.');
  pinDialogError.hidden = true;
  pinSubmit.disabled = true;
  api
    .pinSet(pinNew.value, needCurrent ? pinCurrent.value : undefined)
    .then(async () => {
      pinDialog.close();
      await refreshPin();
      setStatus('PIN guardado.');
      window.setTimeout(() => setStatus(null), 4000);
    })
    .catch((err: unknown) => fail(err instanceof ApiError ? err.message : 'No se pudo guardar el PIN.'))
    .finally(() => {
      pinSubmit.disabled = false;
    });
});

// ---------- Versión y aviso de actualización ----------

/** Pie de página con la versión, y aviso si el emisor tiene una versión nueva. Sin red, no pasa nada. */
async function loadAppInfo(): Promise<void> {
  let info: AppInfo;
  try {
    info = await api.appInfo();
  } catch {
    return;
  }
  appVersion.textContent = ` v${info.version}`;
  const update = info.update;
  // El servidor ya exige https; se vuelve a comprobar antes de poner el enlace en la página.
  if (!update || !update.url.startsWith('https://')) return;
  updateText.textContent = `Hay una versión nueva de aula-local (${update.version}). `;
  updateLink.href = update.url;
  if (update.notes) {
    updateLink.title = update.notes;
    updateNotes.textContent = update.notes;
    updateNotes.hidden = false;
  }
  updateBanner.hidden = false;
}

route();
void loadAppInfo();

// Primera vez en la laptop: se invita a crear el PIN (otros dispositivos lo pedirán).
void refreshPin().then(() => {
  if (pin?.local && !pin.configured && !libraryEl.hidden) openPinDialog();
});
