// Historial de sesiones en disco: data/classes/<classId>/sessions/<sid>/session.json (metadatos, preguntas
// y alumnos, sin trazos ni clientId) y answers/<qid>.json (respuestas de cada pregunta, por id público).
// Solo se reescribe el archivo de la pregunta que cambió: con 40 alumnos dibujando, reescribir toda la
// sesión cada vez sería demasiado.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  Answer,
  ClassInfo,
  QuestionStats,
  Session,
  SessionListItem,
  SessionRecord,
  SessionStatus,
  SessionSummary,
  StudentSummary,
} from '../shared/types.js';
import { DECK_ID_RE } from './classes.js';
import { readJson, writeJsonAtomic } from './files.js';
import { LiveStore } from './live.js';
import { ID_RE } from './validate.js';

/** Cada cuánto, como máximo, se guarda en disco una sesión que está cambiando (SPEC: cada 10 s). */
export const FLUSH_DELAY_MS = 10_000;
/** Para cambios que importan al retomar la clase (diapositiva, alumno nuevo, pregunta): casi de inmediato. */
export const FLUSH_SOON_MS = 300;

export function sessionDir(dataDir: string, classId: string, sessionId: string): string {
  return path.join(dataDir, 'classes', classId, 'sessions', sessionId);
}

/** Lo que se guarda de una sesión: nunca incluye `clientId` (la credencial de reconexión del alumno). */
export function toRecord(session: Session): SessionRecord {
  const record: SessionRecord = {
    id: session.id,
    classId: session.classId,
    startedAt: session.startedAt,
    students: [...session.students.values()].map(({ id, name }) => ({ id, name })),
    questions: session.questions.map((q) => ({ ...q })),
  };
  if (session.endedAt !== undefined) record.endedAt = session.endedAt;
  return record;
}

/** Respuestas de una pregunta en memoria, por id público de alumno. */
export function answersOf(session: Session, questionId: string): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (const student of session.students.values()) {
    const answer = student.answers[questionId];
    if (answer) answers[student.id] = answer;
  }
  return answers;
}

/** Guarda sesiones en disco agrupando cambios: como máximo una escritura cada `delayMs` por sesión. */
type PendingEntry = { session: Session; questions: Set<string>; timer?: NodeJS.Timeout; due?: number };

/**
 * Guarda sesiones en disco agrupando cambios: como máximo una escritura cada `delayMs` por sesión.
 * Mientras la clase no terminó también guarda su estado en vivo (data/live/), para retomarla tras un reinicio.
 */
export class Recorder {
  private readonly pending = new Map<string, PendingEntry>();
  /** Guardados en curso: al apagar el servidor hay que esperarlos a todos. */
  private readonly inflight = new Set<Promise<void>>();
  readonly live: LiveStore;

  constructor(
    private readonly dataDir: string,
    private readonly delayMs = FLUSH_DELAY_MS,
  ) {
    this.live = new LiveStore(dataDir);
  }

  /** Marca la sesión (y opcionalmente las respuestas de una pregunta) como pendientes de guardar. */
  touch(session: Session, questionId?: string): void {
    this.schedule(session, questionId, this.delayMs);
  }

  /** Como `touch`, pero guarda casi de inmediato (cambios necesarios para retomar la clase). */
  touchSoon(session: Session, questionId?: string): void {
    this.schedule(session, questionId, Math.min(FLUSH_SOON_MS, this.delayMs));
  }

  /** Guarda ya lo pendiente de la sesión (metadatos siempre). Los errores se registran, no se lanzan. */
  flush(session: Session, questionId?: string): Promise<void> {
    const work = this.write(session, questionId);
    this.inflight.add(work);
    void work.finally(() => this.inflight.delete(work));
    return work;
  }

  private async write(session: Session, questionId?: string): Promise<void> {
    const entry = this.pending.get(session.id);
    this.pending.delete(session.id);
    clearTimeout(entry?.timer);
    const questions = new Set(entry?.questions);
    if (questionId) questions.add(questionId);
    const dir = sessionDir(this.dataDir, session.classId, session.id);
    try {
      await writeJsonAtomic(path.join(dir, 'session.json'), toRecord(session));
      for (const qid of questions) {
        await writeJsonAtomic(path.join(dir, 'answers', `${qid}.json`), answersOf(session, qid));
      }
      if (session.endedAt === undefined) await this.live.save(session);
    } catch (err) {
      console.error(`No se pudo guardar la sesión ${session.id}:`, err);
    }
  }

  /**
   * Guarda lo pendiente y, además, todas las sesiones `live` indicadas (al apagar el servidor):
   * su estado en vivo y las respuestas de la pregunta abierta, para retomarlas al volver.
   */
  async flushAll(live: readonly Session[] = []): Promise<void> {
    const sessions = new Map<string, Session>();
    for (const entry of this.pending.values()) sessions.set(entry.session.id, entry.session);
    for (const s of live) sessions.set(s.id, s);
    await Promise.all(
      [...sessions.values()].map((s) => this.flush(s, s.question && !s.question.closed ? s.question.id : undefined)),
    );
    // También los que ya estaban en curso (p. ej. el de una pregunta recién cerrada).
    await Promise.all([...this.inflight]);
  }

  private schedule(session: Session, questionId: string | undefined, delay: number): void {
    let entry = this.pending.get(session.id);
    if (!entry) {
      entry = { session, questions: new Set() };
      this.pending.set(session.id, entry);
    }
    if (questionId) entry.questions.add(questionId);
    const due = Date.now() + delay;
    if (entry.timer && entry.due !== undefined && entry.due <= due) return; // Ya hay un guardado antes.
    clearTimeout(entry.timer);
    entry.due = due;
    entry.timer = setTimeout(() => void this.flush(session), delay);
    entry.timer.unref(); // No mantiene vivo el proceso ni las pruebas.
  }
}

/** Lectura del historial guardado. */
export class HistoryStore {
  constructor(private readonly dataDir: string) {}

  /** Sesiones de una clase, la más reciente primero. `live` es la sesión en curso, si la hay. */
  async listSessions(classId: string, live?: Session): Promise<SessionListItem[]> {
    let names: string[] = [];
    try {
      names = await readdir(path.join(this.dataDir, 'classes', classId, 'sessions'));
    } catch {
      // Clase sin sesiones todavía.
    }
    const records = await Promise.all(names.filter((n) => DECK_ID_RE.test(n)).map((n) => this.loadSession(classId, n)));
    const byId = new Map<string, SessionRecord>();
    for (const r of records) if (r) byId.set(r.id, r);
    if (live) byId.set(live.id, toRecord(live)); // La copia en memoria es la más fresca.
    return [...byId.values()]
      .map((r) => {
        const item: SessionListItem = {
          id: r.id,
          startedAt: r.startedAt,
          status: statusOf(r, live),
          studentCount: r.students.length,
          questionCount: r.questions.length,
        };
        if (r.endedAt !== undefined) item.endedAt = r.endedAt;
        return item;
      })
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async loadSession(classId: string, sessionId: string): Promise<SessionRecord | undefined> {
    if (!DECK_ID_RE.test(classId) || !DECK_ID_RE.test(sessionId)) return undefined;
    const record = await readJson<SessionRecord>(path.join(sessionDir(this.dataDir, classId, sessionId), 'session.json'));
    return record?.classId === classId ? record : undefined;
  }

  async loadAnswers(classId: string, sessionId: string, questionId: string): Promise<Record<string, Answer>> {
    if (!DECK_ID_RE.test(classId) || !DECK_ID_RE.test(sessionId) || !ID_RE.test(questionId)) return {};
    const dir = sessionDir(this.dataDir, classId, sessionId);
    return (await readJson<Record<string, Answer>>(path.join(dir, 'answers', `${questionId}.json`))) ?? {};
  }
}

export function statusOf(record: SessionRecord, live?: Session): SessionStatus {
  if (record.endedAt !== undefined) return 'ended';
  return live?.id === record.id ? 'live' : 'interrupted';
}

/** Resumen de una sesión: alumnos y, por pregunta, cuántos entregaron y cuántos respondieron algo. */
export async function summarize(
  info: ClassInfo,
  record: SessionRecord,
  status: SessionStatus,
  roster: StudentSummary[],
  getAnswers: (questionId: string) => Promise<Record<string, Answer>> | Record<string, Answer>,
): Promise<SessionSummary> {
  const questions: QuestionStats[] = [];
  for (const question of record.questions) {
    const answers = Object.values(await getAnswers(question.id));
    questions.push({
      question,
      submitted: answers.filter((a) => a.submittedAt !== undefined).length,
      answered: answers.filter((a) => a.strokes.length > 0 || Boolean(a.text)).length,
    });
  }
  const summary: SessionSummary = {
    id: record.id,
    classId: info.id,
    classTitle: info.title,
    slideCount: info.slideCount,
    startedAt: record.startedAt,
    status,
    students: roster,
    questions,
  };
  if (record.endedAt !== undefined) summary.endedAt = record.endedAt;
  return summary;
}
