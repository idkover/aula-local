// Integración: clase preparada → clase en vivo → terminar → resumen, y que todo sobreviva a un reinicio.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AckResult,
  ClassInfo,
  ClassListItem,
  QuestionAnswers,
  QuestionOpenPayload,
  SessionEndPayload,
  SessionInfo,
  SessionListItem,
  SessionSummary,
  Stroke,
} from '../shared/types.js';
import { makePdf } from './helpers.js';
import { Harness, next, type StudentSocket, type TeacherSocket } from './harness.js';

const h = new Harness();
let klass: ClassInfo;
let session: SessionInfo;
const stroke = (id: string): Stroke => ({ id, color: '#2563eb', size: 8, points: [[0.2, 0.2, 0.5], [0.6, 0.4, 0.5]] });

beforeAll(async () => {
  await h.boot();
}, 30_000);

afterAll(() => h.stop());

const join = async (clientId: string, name: string, code = session.code) => {
  const { socket, result } = await h.joinStudent(clientId, name, code);
  return { socket, result };
};

describe('Clase preparada de antemano', () => {
  it('se crea con título, se preparan preguntas y aparece en la biblioteca', async () => {
    const created = await h.api<ClassInfo>('POST', `/api/classes?title=${encodeURIComponent('Álgebra 1')}`, makePdf(3), 201);
    klass = await h.api<ClassInfo>('PUT', `/api/classes/${created.id}`, {
      title: 'Álgebra 1',
      questions: [
        { id: 'pq-dibuja', slideIndex: 1, type: 'overSlide', prompt: 'Marca la incógnita' },
        { id: 'pq-texto', slideIndex: 2, type: 'text', prompt: '¿Cuánto vale x?' },
      ],
    });
    expect(klass.questions).toHaveLength(2);
    await h.api('PUT', `/api/classes/${klass.id}`, { title: 'x', questions: [{ id: 'mal', slideIndex: 9, type: 'blank' }] }, 400);

    const list = await h.api<ClassListItem[]>('GET', '/api/classes');
    expect(list.find((c) => c.id === klass.id)).toMatchObject({ title: 'Álgebra 1', slideCount: 3, questionCount: 2, sessionCount: 0 });
    // El editor usa las diapositivas de la clase sin sesión.
    expect((await fetch(`${h.base}/slides/${klass.id}/2.png`)).status).toBe(200);
  }, 30_000);

  it('se da la clase: la pregunta preparada llega con su enunciado y se terminan guardando todas', async () => {
    session = await h.api<SessionInfo>('POST', `/api/classes/${klass.id}/sessions`, undefined, 201);
    expect(session.classId).toBe(klass.id);
    // "Dar clase" otra vez retoma la misma sesión en vivo.
    expect((await h.api<SessionInfo>('POST', `/api/classes/${klass.id}/sessions`, undefined, 201)).sessionId).toBe(session.sessionId);
    expect((await fetch(`${h.base}/slides/${session.sessionId}/0.png`)).status).toBe(200);
    await h.api('DELETE', `/api/classes/${klass.id}`, undefined, 409);

    const teacher = h.open<TeacherSocket>('/teacher', { sessionId: session.sessionId });
    await next(teacher, 'state:sync');
    const ana = (await join('client-ana-000001', 'Ana')).socket;
    const beto = (await join('client-beto-00002', 'Beto')).socket;

    // Pregunta preparada sobre la diapositiva 1.
    const opened = next<QuestionOpenPayload>(ana, 'question:open');
    teacher.emit('question:open', { id: 'live-0001', preparedId: 'pq-dibuja', type: 'overSlide', slideIndex: 1, prompt: 'Marca la incógnita' });
    expect(await opened).toEqual({ id: 'live-0001', preparedId: 'pq-dibuja', type: 'overSlide', slideIndex: 1, prompt: 'Marca la incógnita' });
    ana.emit('stroke:add', { questionId: 'live-0001', stroke: stroke('s-ana-1') });
    beto.emit('stroke:add', { questionId: 'live-0001', stroke: stroke('s-beto-1') });
    await new Promise((resolve) => ana.emit('answer:submit', { questionId: 'live-0001' }, resolve));

    // Pregunta de texto improvisada (cierra la anterior).
    const opened2 = next<QuestionOpenPayload>(beto, 'question:open');
    teacher.emit('question:open', { id: 'live-0002', type: 'text', prompt: '¿Cuánto vale x?' });
    await opened2;
    await new Promise((resolve) => beto.emit('answer:submit', { questionId: 'live-0002', text: 'x = 4' }, resolve));

    // El resumen ya funciona con la clase en curso.
    const liveSummary = await h.api<SessionSummary>('GET', `/api/classes/${klass.id}/sessions/${session.sessionId}`);
    expect(liveSummary.status).toBe('live');
    expect(liveSummary.questions.map((q) => q.question.id)).toEqual(['live-0001', 'live-0002']);

    // Terminar la clase: alumnos y profesor reciben session:end.
    const anaEnd = next(ana, 'session:end');
    const teacherEnd = next<SessionEndPayload>(teacher, 'session:end');
    const ack = await new Promise<AckResult>((resolve) => teacher.emit('session:end', resolve));
    expect(ack).toEqual({ ok: true });
    await anaEnd;
    expect(await teacherEnd).toEqual({ classId: klass.id, sessionId: session.sessionId });
    expect((await join('client-caro-00003', 'Caro')).result).toMatchObject({ ok: false });

    // Un profesor que vuelve a conectarse sabe que terminó y a qué clase pertenece.
    const late = h.open<TeacherSocket>('/teacher', { sessionId: session.sessionId });
    const err = await next<Error & { data?: unknown }>(late, 'connect_error');
    expect(err.message).toBe('SESSION_ENDED');
    expect(err.data).toEqual({ classId: klass.id, sessionId: session.sessionId });
  }, 30_000);

  it('después de reiniciar el servidor siguen la clase, el historial y todas las respuestas', async () => {
    await h.restart();

    const list = await h.api<ClassListItem[]>('GET', '/api/classes');
    expect(list.find((c) => c.id === klass.id)).toMatchObject({ questionCount: 2, sessionCount: 1 });
    const sessions = await h.api<SessionListItem[]>('GET', `/api/classes/${klass.id}/sessions`);
    expect(sessions).toEqual([
      expect.objectContaining({ id: session.sessionId, status: 'ended', studentCount: 2, questionCount: 2 }),
    ]);

    const summary = await h.api<SessionSummary>('GET', `/api/classes/${klass.id}/sessions/${session.sessionId}`);
    expect(summary).toMatchObject({ classTitle: 'Álgebra 1', slideCount: 3, status: 'ended' });
    expect(summary.students.map((s) => s.name)).toEqual(['Ana', 'Beto']);
    expect(summary.questions.map((q) => [q.question.id, q.question.prompt, q.submitted, q.answered])).toEqual([
      ['live-0001', 'Marca la incógnita', 1, 2],
      ['live-0002', '¿Cuánto vale x?', 1, 1],
    ]);

    const drawing = await h.api<QuestionAnswers>('GET', `/api/classes/${klass.id}/sessions/${session.sessionId}/questions/live-0001`);
    expect(drawing.question).toMatchObject({ preparedId: 'pq-dibuja', closed: true });
    const anaId = drawing.roster.find((s) => s.name === 'Ana')?.id ?? '';
    expect(drawing.answers[anaId]).toMatchObject({ strokes: [stroke('s-ana-1')], submittedAt: expect.any(Number) });
    const text = await h.api<QuestionAnswers>('GET', `/api/classes/${klass.id}/sessions/${session.sessionId}/questions/live-0002`);
    expect(Object.values(text.answers).map((a) => a.text)).toEqual(['x = 4']);

    await h.api('GET', `/api/classes/${klass.id}/sessions/${session.sessionId}/questions/no-existe`, undefined, 404);
    expect((await fetch(`${h.base}/slides/${klass.id}/..%2Fclass.json`)).status).toBe(404);
  }, 30_000);

  it('una clase sin terminar se retoma tras reiniciar; si pasó demasiado tiempo queda interrumpida', async () => {
    const live = await h.api<SessionInfo>('POST', `/api/classes/${klass.id}/sessions`, undefined, 201);
    const teacher = h.open<TeacherSocket>('/teacher', { sessionId: live.sessionId });
    await next(teacher, 'state:sync');
    const ana: StudentSocket = (await join('client-ana-000001', 'Ana', live.code)).socket;
    const opened = next(ana, 'question:open');
    teacher.emit('question:open', { id: 'live-0099', type: 'blank' });
    await opened;
    ana.emit('stroke:add', { questionId: 'live-0099', stroke: stroke('s-late') });
    await new Promise((resolve) => ana.emit('answer:submit', { questionId: 'live-0099' }, resolve));

    await h.restart(); // sin "Terminar clase": la clase se retoma
    let sessions = await h.api<SessionListItem[]>('GET', `/api/classes/${klass.id}/sessions`);
    expect(sessions.find((s) => s.id === live.sessionId)?.status).toBe('live');

    // Si el servidor estuvo apagado más de 12 h, la clase ya no se retoma: queda interrumpida.
    await h.restart(async () => {
      const file = path.join(h.dataDir, 'live', `${live.sessionId}.json`);
      const snapshot = JSON.parse(await readFile(file, 'utf8')) as { savedAt: number };
      snapshot.savedAt -= 13 * 60 * 60 * 1000;
      await writeFile(file, JSON.stringify(snapshot));
    });
    sessions = await h.api<SessionListItem[]>('GET', `/api/classes/${klass.id}/sessions`);
    expect(sessions.find((s) => s.id === live.sessionId)?.status).toBe('interrupted');
    expect(existsSync(path.join(h.dataDir, 'live', `${live.sessionId}.json`))).toBe(false);
    const answers = await h.api<QuestionAnswers>('GET', `/api/classes/${klass.id}/sessions/${live.sessionId}/questions/live-0099`);
    expect(Object.values(answers.answers)[0]?.strokes).toEqual([stroke('s-late')]);

    // Ya sin sesión en vivo, la clase se puede borrar con todo su historial.
    await h.api('DELETE', `/api/classes/${klass.id}`, undefined, 204);
    await h.api('GET', `/api/classes/${klass.id}/sessions`, undefined, 404);
  }, 30_000);
});
