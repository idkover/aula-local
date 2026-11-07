// Estado en memoria y reglas de la sesión. Sin E/S: el transporte (Socket.IO/HTTP) vive en index.ts.
import { randomBytes, randomInt } from 'node:crypto';
import { slideUrl } from '../shared/slides.js';
import { MAX_STROKES_PER_ANSWER, MAX_TEXT_LENGTH, parseStroke } from '../shared/strokes.js';
import type {
  AckResult,
  Answer,
  AnswersSyncPayload,
  AnswerStatusPayload,
  Question,
  Session,
  SessionRecord,
  Spotlight,
  StateSyncPayload,
  Stroke,
  Student,
  StudentJoinPayload,
  StudentSummary,
} from '../shared/types.js';
import type { LiveSnapshot } from './live.js';
import { ID_RE, parseQuestionSpec } from './validate.js';

export const NAME_MAX_LENGTH = 40;
export { TIME_LIMIT_MAX_SEC } from './validate.js';

export type JoinOutcome =
  | { ok: true; session: Session; student: Student; isNew: boolean }
  | { ok: false; error: string };

export type OpenOutcome = { question: Question; closedPrevious?: Question };

export class SessionStore {
  private readonly byId = new Map<string, Session>();

  /**
   * Crea una sesión de la clase `classId` con un código de 4 dígitos único entre las sesiones vivas.
   * Las URLs de las diapositivas usan el id de la sesión: el servidor lo resuelve a la carpeta de la clase.
   */
  create(slideCount: number, id: string = newSessionId(), classId: string = id, now = Date.now()): Session {
    if (!Number.isInteger(slideCount) || slideCount < 1) {
      throw new Error('La presentación no tiene páginas.');
    }
    const session: Session = {
      id,
      classId,
      code: this.uniqueCode(),
      pinHash: '', // PIN del profesor: Fase 4.
      slides: Array.from({ length: slideCount }, (_, i) => slideUrl(id, i)),
      slideIndex: 0,
      questions: [],
      startedAt: now,
      students: new Map(),
    };
    this.byId.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.byId.get(id);
  }

  /** Solo sesiones vivas: una clase terminada ya no acepta alumnos. */
  getByCode(code: string): Session | undefined {
    for (const session of this.byId.values()) {
      if (session.code === code && session.endedAt === undefined) return session;
    }
    return undefined;
  }

  /** Sesión en curso de una clase, si la hay. */
  liveForClass(classId: string): Session | undefined {
    for (const session of this.byId.values()) {
      if (session.classId === classId && session.endedAt === undefined) return session;
    }
    return undefined;
  }

  all(): Session[] {
    return [...this.byId.values()];
  }

  /**
   * Termina la clase: cierra la pregunta abierta (la devuelve para avisar a todos) y marca el fin.
   * La sesión sigue en memoria hasta `delete`, para que el servidor alcance a guardarla.
   */
  endSession(sessionId: string, now = Date.now()): { session: Session; closed?: Question } | undefined {
    const session = this.byId.get(sessionId);
    if (!session || session.endedAt !== undefined) return undefined;
    const open = session.question && !session.question.closed ? session.question : undefined;
    if (open) open.closed = true;
    delete session.spotlight;
    session.endedAt = now;
    return open ? { session, closed: open } : { session };
  }

  delete(sessionId: string): void {
    this.byId.delete(sessionId);
  }

  /**
   * Reconstruye una clase en curso tras reiniciar el servidor: historial guardado (`record`), respuestas
   * por pregunta y estado privado (`snapshot`: código, diapositiva y clientId de cada alumno). Los
   * alumnos vuelven desconectados hasta que su celular se reconecta con su clientId. Si el código ya lo
   * usa otra sesión viva, se asigna uno nuevo.
   */
  restore(
    snapshot: LiveSnapshot,
    record: SessionRecord,
    slideCount: number,
    answers: Record<string, Record<string, Answer>>,
  ): Session {
    const session = this.create(slideCount, record.id, record.classId, record.startedAt);
    if (snapshot.code !== session.code && !this.getByCode(snapshot.code)) session.code = snapshot.code;
    session.slideIndex = Math.min(Math.max(0, snapshot.slideIndex), slideCount - 1);
    session.questions = record.questions.map((q) => ({ ...q }));
    const last = session.questions.at(-1);
    if (last) session.question = last;
    const names = new Map(record.students.map((s) => [s.id, s.name]));
    for (const [clientId, studentId] of Object.entries(snapshot.clients)) {
      const name = names.get(studentId);
      if (name === undefined) continue;
      const student: Student = { id: studentId, clientId, name, connected: false, answers: {} };
      for (const [questionId, byStudent] of Object.entries(answers)) {
        const answer = byStudent[studentId];
        if (answer) student.answers[questionId] = answer;
      }
      session.students.set(clientId, student);
    }
    if (snapshot.spotlight && session.question) session.spotlight = snapshot.spotlight;
    return session;
  }

  /** Registra al alumno o lo recupera por `clientId`, y lo asocia al socket actual. */
  join(payload: unknown, socketId: string): JoinOutcome {
    const parsed = parseJoinPayload(payload);
    if (!parsed) return { ok: false, error: 'Datos de ingreso inválidos.' };
    const session = this.getByCode(parsed.code);
    if (!session) return { ok: false, error: 'No existe una sesión con ese código.' };

    let student = session.students.get(parsed.clientId);
    const isNew = !student;
    if (!student) {
      student = { id: uniqueStudentId(session), clientId: parsed.clientId, name: parsed.name, connected: true, answers: {} };
      session.students.set(parsed.clientId, student);
    }
    student.name = parsed.name;
    student.socketId = socketId;
    student.connected = true;
    return { ok: true, session, student, isNew };
  }

  /**
   * Marca al alumno como desconectado solo si el socket que se cae es el vigente
   * (un alumno puede reconectar con un socket nuevo antes de que el viejo expire).
   */
  disconnect(sessionId: string, clientId: string, socketId: string): boolean {
    const student = this.byId.get(sessionId)?.students.get(clientId);
    if (!student || student.socketId !== socketId) return false;
    student.connected = false;
    delete student.socketId;
    return true;
  }

  /** Cambia la diapositiva actual. Devuelve false si el índice no es válido. */
  gotoSlide(sessionId: string, index: unknown): boolean {
    const session = this.byId.get(sessionId);
    if (!session || !Number.isInteger(index)) return false;
    const i = index as number;
    if (i < 0 || i >= session.slides.length) return false;
    session.slideIndex = i;
    return true;
  }

  // ---------- Preguntas ----------

  /**
   * Abre una pregunta. Si había otra abierta, la cierra primero (solo hay una a la vez).
   * Si no se indica diapositiva, la pregunta queda asociada a la actual. El id debe ser nuevo en
   * toda la sesión: las respuestas se guardan por id y reusar uno mezclaría preguntas distintas.
   */
  openQuestion(sessionId: string, payload: unknown, now = Date.now()): OpenOutcome | undefined {
    const session = this.byId.get(sessionId);
    if (!session || session.endedAt !== undefined) return undefined;
    const spec = parseQuestionSpec(payload, session.slides.length);
    const { id, preparedId } = (payload ?? {}) as Record<string, unknown>;
    if (!spec || typeof id !== 'string' || !ID_RE.test(id) || session.questions.some((q) => q.id === id)) {
      return undefined;
    }
    if (preparedId !== undefined && (typeof preparedId !== 'string' || !ID_RE.test(preparedId))) return undefined;

    const previous = session.question && !session.question.closed ? session.question : undefined;
    if (previous) previous.closed = true;
    delete session.spotlight; // La respuesta en grande era de la pregunta anterior.

    const question: Question = {
      id,
      type: spec.type,
      slideIndex: spec.slideIndex ?? session.slideIndex,
      openedAt: now,
      closed: false,
    };
    if (spec.timeLimitSec !== undefined) question.timeLimitSec = spec.timeLimitSec;
    if (spec.prompt !== undefined) question.prompt = spec.prompt;
    if (preparedId !== undefined) question.preparedId = preparedId;
    session.question = question;
    session.questions.push(question);
    return previous ? { question, closedPrevious: previous } : { question };
  }

  /** Cierra la pregunta abierta si coincide el id. Devuelve la pregunta cerrada. */
  closeQuestion(sessionId: string, questionId: unknown): Question | undefined {
    const question = this.byId.get(sessionId)?.question;
    if (!question || question.closed || question.id !== questionId) return undefined;
    question.closed = true;
    return question;
  }

  // ---------- Pizarrón y entregas ----------

  /** Agrega un trazo validado. Devuelve el trazo limpio (el que se reenvía al profesor) o undefined. */
  addStroke(sessionId: string, clientId: string, payload: unknown): Stroke | undefined {
    const answer = this.boardAnswer(sessionId, clientId, payload);
    if (!answer || answer.strokes.length >= MAX_STROKES_PER_ANSWER) return undefined;
    const stroke = parseStroke((payload as { stroke?: unknown }).stroke);
    if (!stroke || answer.strokes.some((s) => s.id === stroke.id)) return undefined;
    answer.strokes.push(stroke);
    return stroke;
  }

  /** Deshace el último trazo agregado. */
  undoStroke(sessionId: string, clientId: string, payload: unknown): boolean {
    const answer = this.boardAnswer(sessionId, clientId, payload);
    return Boolean(answer?.strokes.pop());
  }

  /** Borrador de trazo completo: elimina un trazo por id. */
  removeStroke(sessionId: string, clientId: string, payload: unknown): boolean {
    const answer = this.boardAnswer(sessionId, clientId, payload);
    const strokeId = (payload as { strokeId?: unknown }).strokeId;
    if (!answer || typeof strokeId !== 'string') return false;
    const index = answer.strokes.findIndex((s) => s.id === strokeId);
    if (index < 0) return false;
    answer.strokes.splice(index, 1);
    return true;
  }

  clearBoard(sessionId: string, clientId: string, payload: unknown): boolean {
    const answer = this.boardAnswer(sessionId, clientId, payload);
    if (!answer) return false;
    answer.strokes = [];
    return true;
  }

  /** Marca la respuesta como entregada. Se puede reenviar mientras la pregunta siga abierta. */
  submitAnswer(sessionId: string, clientId: string, payload: unknown, now = Date.now()): AckResult {
    const found = this.openAnswer(sessionId, clientId, payload);
    if (!found) return { ok: false, error: 'La pregunta ya se cerró.' };
    const { answer, question } = found;
    if (question.type === 'text') {
      const text = (payload as { text?: unknown }).text;
      const clean = typeof text === 'string' ? text.trim().slice(0, MAX_TEXT_LENGTH) : '';
      if (!clean) return { ok: false, error: 'Escribe tu respuesta antes de entregar.' };
      answer.text = clean;
    }
    answer.submittedAt = now;
    return { ok: true };
  }

  stateFor(session: Session, student?: Student, now = Date.now()): StateSyncPayload {
    const state: StateSyncPayload = {
      sessionId: session.id,
      classId: session.classId,
      slideIndex: session.slideIndex,
      slideCount: session.slides.length,
      serverNow: now,
    };
    if (session.question && !session.question.closed) {
      state.question = session.question;
      const answer = student?.answers[session.question.id];
      if (answer) state.myAnswer = answer;
    }
    return state;
  }

  // ---------- Vista del profesor ----------

  /** Alumnos en orden de llegada, sin datos privados (`clientId`, socket). */
  roster(session: Session): StudentSummary[] {
    return [...session.students.values()].map(({ id, name, connected }) => ({ id, name, connected }));
  }

  /** Respuestas a la pregunta actual o a la última cerrada, por id público de alumno. */
  answersFor(session: Session): AnswersSyncPayload | undefined {
    const question = session.question;
    if (!question) return undefined;
    const answers: Record<string, Answer> = {};
    for (const student of session.students.values()) {
      const answer = student.answers[question.id];
      if (answer) answers[student.id] = answer;
    }
    return { question, answers };
  }

  /**
   * Muestra (o quita, con `studentId: null`) una respuesta en grande. Solo se permite con una
   * pregunta abierta o recién cerrada y un alumno de la sesión. Devuelve undefined si no es válido.
   */
  setSpotlight(sessionId: string, payload: unknown): Spotlight | null | undefined {
    const session = this.byId.get(sessionId);
    if (!session || typeof payload !== 'object' || payload === null) return undefined;
    const { studentId, showName } = payload as Record<string, unknown>;
    if (studentId === null) {
      delete session.spotlight;
      return null;
    }
    if (typeof studentId !== 'string' || typeof showName !== 'boolean' || !session.question) return undefined;
    if (![...session.students.values()].some((s) => s.id === studentId)) return undefined;
    session.spotlight = { studentId, showName };
    return session.spotlight;
  }

  status(session: Session): AnswerStatusPayload {
    let connected = 0;
    let submitted = 0;
    const questionId = session.question?.id;
    for (const student of session.students.values()) {
      if (student.connected) connected++;
      if (questionId && student.answers[questionId]?.submittedAt !== undefined) submitted++;
    }
    return { connected, submitted };
  }

  /** Respuesta del alumno a la pregunta abierta indicada en `payload.questionId` (la crea si no existe). */
  private openAnswer(
    sessionId: string,
    clientId: string,
    payload: unknown,
  ): { answer: Answer; question: Question } | undefined {
    const session = this.byId.get(sessionId);
    const question = session?.question;
    const student = session?.students.get(clientId);
    if (!question || question.closed || !student || typeof payload !== 'object' || payload === null) return undefined;
    if ((payload as { questionId?: unknown }).questionId !== question.id) return undefined;
    const answer = (student.answers[question.id] ??= { strokes: [] });
    return { answer, question };
  }

  private boardAnswer(sessionId: string, clientId: string, payload: unknown): Answer | undefined {
    const found = this.openAnswer(sessionId, clientId, payload);
    return found && found.question.type !== 'text' ? found.answer : undefined;
  }

  private uniqueCode(): string {
    for (;;) {
      const code = String(randomInt(0, 10_000)).padStart(4, '0');
      if (!this.getByCode(code)) return code;
    }
  }
}

function uniqueStudentId(session: Session): string {
  for (;;) {
    const id = randomBytes(4).toString('hex');
    if (![...session.students.values()].some((s) => s.id === id)) return id;
  }
}

export function newSessionId(): string {
  return randomBytes(6).toString('hex');
}

function parseJoinPayload(payload: unknown): StudentJoinPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { code, name, clientId } = payload as Record<string, unknown>;
  if (typeof code !== 'string' || typeof name !== 'string' || typeof clientId !== 'string') {
    return undefined;
  }
  const cleanCode = code.trim();
  const cleanName = name.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX_LENGTH);
  if (!/^\d{4}$/.test(cleanCode) || !cleanName || !/^[\w-]{8,64}$/.test(clientId)) {
    return undefined;
  }
  return { code: cleanCode, name: cleanName, clientId };
}
