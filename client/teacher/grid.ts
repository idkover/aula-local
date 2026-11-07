// Respuestas de los alumnos en la vista del profesor.
// - AnswersModel: lista de alumnos + pregunta actual + respuesta de cada uno. Aplica todos los eventos
//   del servidor y avisa de cada cambio por alumno. Lo usan la página del profesor y la ventana de proyección.
// - AnswerGrid: cuadrícula de miniaturas (una por alumno, solo se redibuja la que cambió).
// - BigAnswer: una respuesta en grande (overlay del profesor y ventana de proyección).
import type { Socket } from 'socket.io-client';
import { slideUrl } from '../../shared/slides.js';
import type {
  Answer,
  Question,
  ServerToTeacherEvents,
  Spotlight,
  Stroke,
  StudentSummary,
  TeacherToServerEvents,
} from '../../shared/types.js';
import { drawStrokes } from '../common/strokes.js';

type TeacherSocket = Socket<ServerToTeacherEvents, TeacherToServerEvents>;

// ---------- Proporción de la diapositiva ----------

const DEFAULT_ASPECT = 4 / 3;
const aspectCache = new Map<string, Promise<number>>();
const aspectKnown = new Map<string, number>();

/** Proporción de la diapositiva de la pregunta: mismo criterio que el pizarrón del alumno. */
function slideAspect(sessionId: string, index: number): Promise<number> {
  const url = slideUrl(sessionId, index);
  let aspect = aspectCache.get(url);
  if (!aspect) {
    const img = new Image();
    img.src = url;
    aspect = img
      .decode()
      .then(() => {
        const value = img.naturalWidth / img.naturalHeight;
        aspectKnown.set(url, value);
        return value;
      })
      .catch(() => DEFAULT_ASPECT);
    aspectCache.set(url, aspect);
  }
  return aspect;
}

// ---------- Modelo ----------

export type QuestionChange = 'open' | 'close' | 'sync' | 'aspect';

export type AnswersListener = {
  roster?: () => void;
  question?: (change: QuestionChange) => void;
  student?: (id: string) => void;
  spotlight?: () => void;
};

export class AnswersModel {
  roster: StudentSummary[] = [];
  question: Question | null = null;
  /** Ancho / alto de la diapositiva de la pregunta actual. */
  aspect = DEFAULT_ASPECT;
  spotlight: Spotlight | null = null;
  sessionId = '';
  private answers = new Map<string, Answer>();
  private listeners = new Set<AnswersListener>();

  subscribe(listener: AnswersListener): void {
    this.listeners.add(listener);
  }

  /** Empieza de cero para otra sesión. */
  start(sessionId: string): void {
    this.sessionId = sessionId;
    this.roster = [];
    this.spotlight = null;
    this.setQuestion(null, {}, 'sync');
    this.emit((l) => l.roster?.());
    this.emit((l) => l.spotlight?.());
  }

  /**
   * Carga una pregunta ya terminada (resumen de la clase), sin socket. `deckId` es la carpeta de
   * diapositivas (`slideUrl`): en el resumen es la clase. Avisa igual que un 'sync' en vivo.
   */
  load(deckId: string, roster: StudentSummary[], question: Question, answers: Record<string, Answer>): void {
    this.sessionId = deckId;
    this.roster = roster;
    this.spotlight = null;
    this.emit((l) => l.roster?.());
    this.setQuestion(question, answers, 'sync');
    this.emit((l) => l.spotlight?.());
  }

  answerOf(id: string): Answer | undefined {
    return this.answers.get(id);
  }

  indexOf(id: string): number {
    return this.roster.findIndex((s) => s.id === id);
  }

  /** Nombre real del alumno, o "" si ya no está en la lista. */
  nameOf(id: string): string {
    return this.roster.find((s) => s.id === id)?.name ?? '';
  }

  /** Conecta los eventos del servidor. Llamar una vez por socket. */
  bind(socket: TeacherSocket): void {
    // El servidor reenvía el estado completo al reconectar; la respuesta en grande llega después si sigue activa.
    socket.on('connect', () => this.setSpotlight(null));
    socket.on('roster:sync', ({ students }) => {
      this.roster = students;
      this.emit((l) => l.roster?.());
    });
    socket.on('answers:sync', ({ question, answers }) => this.setQuestion(question, answers, 'sync'));
    socket.on('question:open', (q) => {
      const question: Question = { id: q.id, type: q.type, openedAt: Date.now(), closed: false };
      if (q.slideIndex !== undefined) question.slideIndex = q.slideIndex;
      if (q.timeLimitSec !== undefined) question.timeLimitSec = q.timeLimitSec;
      this.setQuestion(question, {}, 'open');
    });
    socket.on('question:close', ({ id }) => {
      if (this.question?.id !== id) return;
      this.question = { ...this.question, closed: true };
      this.emit((l) => l.question?.('close'));
    });
    socket.on('stroke:add', ({ studentId, questionId, stroke }) =>
      this.change(studentId, questionId, (a) => {
        if (!a.strokes.some((s) => s.id === stroke.id)) a.strokes.push(stroke);
      }),
    );
    socket.on('stroke:undo', ({ studentId, questionId }) => this.change(studentId, questionId, (a) => void a.strokes.pop()));
    socket.on('stroke:remove', ({ studentId, questionId, strokeId }) =>
      this.change(studentId, questionId, (a) => {
        a.strokes = a.strokes.filter((s) => s.id !== strokeId);
      }),
    );
    socket.on('board:clear', ({ studentId, questionId }) =>
      this.change(studentId, questionId, (a) => {
        a.strokes = [];
      }),
    );
    socket.on('answer:submitted', ({ studentId, questionId, text, submittedAt }) =>
      this.change(studentId, questionId, (a) => {
        a.submittedAt = submittedAt;
        if (text !== undefined) a.text = text;
      }),
    );
    socket.on('answer:spotlight', ({ studentId, showName }) =>
      this.setSpotlight(studentId === null ? null : { studentId, showName }),
    );
  }

  private setSpotlight(spotlight: Spotlight | null): void {
    if (!spotlight && !this.spotlight) return;
    this.spotlight = spotlight;
    this.emit((l) => l.spotlight?.());
  }

  private setQuestion(question: Question | null, answers: Record<string, Answer>, change: QuestionChange): void {
    this.question = question;
    this.answers = new Map(Object.entries(answers));
    this.aspect = DEFAULT_ASPECT;
    if (question) {
      const index = question.slideIndex ?? 0;
      this.aspect = aspectKnown.get(slideUrl(this.sessionId, index)) ?? DEFAULT_ASPECT;
      const sessionId = this.sessionId;
      void slideAspect(sessionId, index).then((aspect) => {
        if (this.question?.id !== question.id || this.sessionId !== sessionId || aspect === this.aspect) return;
        this.aspect = aspect;
        this.emit((l) => l.question?.('aspect'));
      });
    }
    this.emit((l) => l.question?.(change));
  }

  private change(studentId: string, questionId: string, apply: (answer: Answer) => void): void {
    if (this.question?.id !== questionId) return;
    let answer = this.answers.get(studentId);
    if (!answer) {
      answer = { strokes: [] };
      this.answers.set(studentId, answer);
    }
    apply(answer);
    this.emit((l) => l.student?.(studentId));
  }

  private emit(call: (listener: AnswersListener) => void): void {
    for (const listener of this.listeners) call(listener);
  }
}

// ---------- Dibujo de un pizarrón ----------

/** Dibuja los trazos en el lienzo (tamaño interno fijo: se escala con CSS). */
function paintBoard(canvas: HTMLCanvasElement, strokes: readonly Stroke[], aspect: number, width: number): void {
  const height = Math.max(1, Math.round(width / aspect));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  drawStrokes(ctx, strokes, width, height);
}

/** Fondo del pizarrón según el tipo de pregunta: la diapositiva o blanco. */
function applyBackground(el: HTMLElement, model: AnswersModel): void {
  const q = model.question;
  el.style.backgroundImage = q?.type === 'overSlide' ? `url("${slideUrl(model.sessionId, q.slideIndex ?? 0)}")` : '';
  el.style.aspectRatio = String(model.aspect);
}

/** Agrupa avisos de cambio y los procesa una vez por cuadro de animación. */
class FrameQueue {
  private ids = new Set<string>();
  private all = false;
  private requested = false;

  constructor(private readonly flush: (ids: ReadonlySet<string> | 'all') => void) {}

  push(id: string): void {
    this.ids.add(id);
    this.request();
  }

  pushAll(): void {
    this.all = true;
    this.request();
  }

  private request(): void {
    if (this.requested) return;
    this.requested = true;
    requestAnimationFrame(() => {
      this.requested = false;
      const ids = this.ids;
      const all = this.all;
      this.ids = new Set();
      this.all = false;
      this.flush(all ? 'all' : ids);
    });
  }
}

// ---------- Cuadrícula ----------

const TILE_CANVAS_WIDTH = 360;

type Tile = {
  el: HTMLElement;
  board: HTMLElement;
  canvas: HTMLCanvasElement | null;
  text: HTMLElement | null;
  name: HTMLElement;
};

export class AnswerGrid {
  private readonly tiles = new Map<string, Tile>();
  private showNames = false;
  private readonly queue = new FrameQueue((ids) => this.flush(ids));

  constructor(
    private readonly root: HTMLElement,
    private readonly model: AnswersModel,
    private readonly onPick: (studentId: string) => void,
  ) {
    model.subscribe({
      roster: () => this.syncRoster(),
      question: () => this.rebuildBoards(),
      student: (id) => this.queue.push(id),
    });
    root.addEventListener('click', (event) => {
      const el = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-student-id]') : null;
      if (el?.dataset.studentId) this.onPick(el.dataset.studentId);
    });
  }

  setShowNames(show: boolean): void {
    this.showNames = show;
    this.refreshNames();
  }

  private syncRoster(): void {
    const seen = new Set<string>();
    const ordered: HTMLElement[] = [];
    for (const student of this.model.roster) {
      seen.add(student.id);
      let tile = this.tiles.get(student.id);
      if (!tile) {
        tile = this.createTile(student.id);
        this.tiles.set(student.id, tile);
        this.queue.push(student.id);
      }
      tile.el.classList.toggle('offline', !student.connected);
      ordered.push(tile.el);
    }
    for (const [id, tile] of this.tiles) {
      if (seen.has(id)) continue;
      tile.el.remove();
      this.tiles.delete(id);
    }
    this.root.replaceChildren(...ordered);
    this.root.style.setProperty('--tile-min', `${tileMinWidth(ordered.length)}px`);
    this.refreshNames();
  }

  private createTile(id: string): Tile {
    const el = document.createElement('div');
    el.className = 'tile';
    el.dataset.studentId = id;
    el.dataset.strokeCount = '0';
    el.dataset.submitted = 'false';
    el.setAttribute('role', 'button');
    const board = document.createElement('div');
    board.className = 'tile-board';
    const badge = document.createElement('span');
    badge.className = 'tile-badge';
    badge.textContent = '✓';
    badge.title = 'Entregado';
    const name = document.createElement('span');
    name.className = 'tile-name';
    el.append(board, badge, name);
    const tile: Tile = { el, board, canvas: null, text: null, name };
    this.buildBoard(tile);
    return tile;
  }

  /** Canvas o recuadro de texto según el tipo de la pregunta actual. */
  private buildBoard(tile: Tile): void {
    const isText = this.model.question?.type === 'text';
    tile.board.classList.toggle('is-text', isText);
    applyBackground(tile.board, this.model);
    if (isText) {
      tile.canvas = null;
      tile.text = document.createElement('div');
      tile.text.className = 'tile-text';
      tile.board.replaceChildren(tile.text);
    } else {
      tile.text = null;
      tile.canvas = document.createElement('canvas');
      tile.board.replaceChildren(tile.canvas);
    }
  }

  private rebuildBoards(): void {
    for (const tile of this.tiles.values()) this.buildBoard(tile);
    this.queue.pushAll();
  }

  private refreshNames(): void {
    this.model.roster.forEach((student, i) => {
      const tile = this.tiles.get(student.id);
      if (tile) tile.name.textContent = this.showNames ? student.name : `Alumno ${i + 1}`;
    });
  }

  private flush(ids: ReadonlySet<string> | 'all'): void {
    for (const id of ids === 'all' ? this.tiles.keys() : ids) {
      const tile = this.tiles.get(id);
      if (tile) this.paint(id, tile);
    }
    // El estado de conexión llega con el roster, que ya se aplicó en syncRoster.
  }

  private paint(id: string, tile: Tile): void {
    const answer = this.model.answerOf(id);
    const strokes = answer?.strokes ?? [];
    if (tile.canvas) paintBoard(tile.canvas, strokes, this.model.aspect, TILE_CANVAS_WIDTH);
    if (tile.text) tile.text.textContent = answer?.text ?? '';
    const submitted = answer?.submittedAt !== undefined;
    tile.el.classList.toggle('submitted', submitted);
    tile.el.dataset.submitted = String(submitted);
    // Después de dibujar: quien lea el contador puede confiar en que el lienzo ya lo refleja.
    tile.el.dataset.strokeCount = String(strokes.length);
  }
}

/** Más alumnos, miniaturas más pequeñas; con pocos, más grandes. */
function tileMinWidth(count: number): number {
  if (count <= 4) return 300;
  if (count <= 9) return 220;
  if (count <= 16) return 170;
  if (count <= 30) return 140;
  return 120;
}

// ---------- Respuesta en grande ----------

const BIG_CANVAS_WIDTH = 1600;

export class BigAnswer {
  private studentId: string | null = null;
  private showName = false;
  private readonly area = document.createElement('div');
  private readonly board = document.createElement('div');
  private readonly nameEl = document.createElement('p');
  private canvas: HTMLCanvasElement | null = null;
  private text: HTMLElement | null = null;
  private readonly queue = new FrameQueue(() => this.paint());

  constructor(
    root: HTMLElement,
    private readonly model: AnswersModel,
  ) {
    this.area.className = 'big-area';
    this.board.className = 'big-board';
    this.nameEl.className = 'big-name';
    this.area.append(this.board);
    root.replaceChildren(this.area, this.nameEl);
    new ResizeObserver(() => this.fit()).observe(this.area);
    model.subscribe({
      roster: () => this.updateName(),
      question: () => {
        this.build();
        this.fit();
        this.queue.pushAll();
      },
      student: (id) => {
        if (id === this.studentId) this.queue.pushAll();
      },
    });
  }

  show(studentId: string | null, showName: boolean): void {
    this.studentId = studentId;
    this.showName = showName;
    this.updateName();
    this.build();
    this.fit();
    this.queue.pushAll();
  }

  /** Ajusta el pizarrón al espacio disponible conservando la proporción de la diapositiva. */
  private fit(): void {
    const aw = this.area.clientWidth;
    const ah = this.area.clientHeight;
    if (aw <= 0 || ah <= 0) return;
    const aspect = this.model.aspect;
    const w = Math.min(aw, ah * aspect);
    this.board.style.width = `${Math.floor(w)}px`;
    this.board.style.height = `${Math.floor(w / aspect)}px`;
  }

  private updateName(): void {
    const name = this.studentId && this.showName ? this.model.nameOf(this.studentId) : '';
    this.nameEl.textContent = name;
    this.nameEl.hidden = !name;
  }

  private build(): void {
    const isText = this.model.question?.type === 'text';
    this.board.classList.toggle('is-text', isText);
    applyBackground(this.board, this.model);
    if (isText) {
      this.canvas = null;
      this.text = document.createElement('div');
      this.text.className = 'big-text';
      this.board.replaceChildren(this.text);
    } else {
      this.text = null;
      this.canvas = document.createElement('canvas');
      this.board.replaceChildren(this.canvas);
    }
  }

  private paint(): void {
    if (!this.studentId) return;
    const answer = this.model.answerOf(this.studentId);
    if (this.canvas) paintBoard(this.canvas, answer?.strokes ?? [], this.model.aspect, BIG_CANVAS_WIDTH);
    if (this.text) this.text.textContent = answer?.text ?? '';
  }
}
