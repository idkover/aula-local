// Integración de la Fase 2: preguntas, trazos, entregas y cierre (manual y por tiempo) a través de Socket.IO.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AckResult,
  AnswerStatusPayload,
  QuestionClosePayload,
  QuestionOpenPayload,
  StateSyncPayload,
  Stroke,
} from '../shared/types.js';
import { Harness, next, nextWhere, type StudentSocket, type TeacherSocket } from './harness.js';

const h = new Harness();
let teacher: TeacherSocket;
let ana: StudentSocket;
let beto: StudentSocket;

const stroke = (id: string): Stroke => ({
  id,
  color: '#2563eb',
  size: 6,
  points: [
    [0.2, 0.2, 0.5],
    [0.4, 0.3, 0.7],
  ],
});

const submit = (socket: StudentSocket, payload: { questionId: string; text?: string }) =>
  new Promise<AckResult>((resolve) => socket.emit('answer:submit', payload, resolve));

/** Espera a que el servidor procese los eventos previos del socket (Socket.IO conserva el orden). */
const flush = async (socket: StudentSocket, questionId: string) => {
  await submit(socket, { questionId: `${questionId}-flush` });
};

beforeAll(async () => {
  await h.start(3);
  teacher = (await h.teacher()).socket;
  ana = (await h.joinStudent('client-ana-0001', 'Ana')).socket;
  beto = (await h.joinStudent('client-beto-0002', 'Beto')).socket;
}, 30_000);

afterAll(() => h.stop());

describe('Pregunta con pizarrón', () => {
  const q: QuestionOpenPayload = { id: 'q-board-1', type: 'overSlide' };

  it('el profesor lanza la pregunta y todos la reciben con la diapositiva actual', async () => {
    teacher.emit('slide:goto', { index: 1 });
    await next(ana, 'slide:goto');
    const received = [ana, beto, teacher].map((s) => next<QuestionOpenPayload>(s, 'question:open'));
    teacher.emit('question:open', q);
    for (const payload of await Promise.all(received)) {
      expect(payload).toEqual({ id: 'q-board-1', type: 'overSlide', slideIndex: 1 });
    }
  });

  it('los trazos se guardan y un alumno que recarga recupera su pizarrón', async () => {
    ana.emit('stroke:add', { questionId: q.id, stroke: stroke('s-ana-1') });
    ana.emit('stroke:add', { questionId: q.id, stroke: stroke('s-ana-2') });
    ana.emit('stroke:add', { questionId: q.id, stroke: stroke('s-ana-3') });
    ana.emit('stroke:remove', { questionId: q.id, strokeId: 's-ana-1' });
    ana.emit('stroke:undo', { questionId: q.id });
    beto.emit('stroke:add', { questionId: q.id, stroke: stroke('s-beto-1') });
    beto.emit('board:clear', { questionId: q.id });
    await flush(ana, q.id);
    await flush(beto, q.id);

    ana.disconnect();
    const again = await h.joinStudent('client-ana-0001', 'Ana');
    ana = again.socket;
    const sync = await again.synced;
    expect(sync.question).toMatchObject({ id: q.id, type: 'overSlide', slideIndex: 1, closed: false });
    expect(sync.myAnswer?.strokes.map((s) => s.id)).toEqual(['s-ana-2']);
    expect(sync.myAnswer?.strokes[0]).toEqual(stroke('s-ana-2'));
    expect(typeof sync.serverNow).toBe('number');
  });

  it('entregar actualiza el contador del profesor; reenviar no lo duplica', async () => {
    const submittedStatus = () => nextWhere<AnswerStatusPayload>(teacher, 'answer:status', (p) => p.submitted > 0);
    let status = submittedStatus();
    expect(await submit(ana, { questionId: q.id })).toEqual({ ok: true });
    expect(await status).toEqual({ connected: 2, submitted: 1 });

    ana.emit('stroke:add', { questionId: q.id, stroke: stroke('s-ana-4') });
    status = submittedStatus();
    expect(await submit(ana, { questionId: q.id })).toEqual({ ok: true });
    expect(await status).toEqual({ connected: 2, submitted: 1 });

    expect(await submit(ana, { questionId: 'otra' })).toMatchObject({ ok: false });
  });

  it('cerrar la pregunta la quita de todos y bloquea nuevos trazos', async () => {
    const closed = [ana, beto, teacher].map((s) => next<QuestionClosePayload>(s, 'question:close'));
    teacher.emit('question:close', { id: q.id });
    expect(await Promise.all(closed)).toEqual([{ id: q.id }, { id: q.id }, { id: q.id }]);

    ana.emit('stroke:add', { questionId: q.id, stroke: stroke('s-ana-5') });
    expect(await submit(ana, { questionId: q.id })).toMatchObject({ ok: false });
    const answer = h.server.store.get(h.info.sessionId)?.students.get('client-ana-0001')?.answers[q.id];
    expect(answer?.strokes.map((s) => s.id)).toEqual(['s-ana-2', 's-ana-4']);

    const teacher2 = h.open<TeacherSocket>('/teacher', { sessionId: h.info.sessionId });
    expect((await next<StateSyncPayload>(teacher2, 'state:sync')).question).toBeUndefined();
  });
});

describe('Pregunta de texto con límite de tiempo', () => {
  it('acepta el texto y el servidor cierra la pregunta sola al vencer el tiempo', async () => {
    const opened = next<QuestionOpenPayload>(beto, 'question:open');
    teacher.emit('question:open', { id: 'q-text-1', type: 'text', timeLimitSec: 1 });
    expect(await opened).toMatchObject({ id: 'q-text-1', type: 'text', timeLimitSec: 1 });

    expect(await submit(beto, { questionId: 'q-text-1', text: '' })).toMatchObject({ ok: false });
    expect(await submit(beto, { questionId: 'q-text-1', text: '  42  ' })).toEqual({ ok: true });
    const answer = h.server.store.get(h.info.sessionId)?.students.get('client-beto-0002')?.answers['q-text-1'];
    expect(answer?.text).toBe('42');

    const start = Date.now();
    const closed = [beto, teacher].map((s) => next<QuestionClosePayload>(s, 'question:close', 3000));
    expect(await Promise.all(closed)).toEqual([{ id: 'q-text-1' }, { id: 'q-text-1' }]);
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('abrir una pregunta nueva cierra la anterior', async () => {
    teacher.emit('question:open', { id: 'q-aaaa', type: 'blank' });
    await next(ana, 'question:open');
    const closed = next<QuestionClosePayload>(ana, 'question:close');
    const opened = next<QuestionOpenPayload>(ana, 'question:open');
    teacher.emit('question:open', { id: 'q-bbbb', type: 'blank', timeLimitSec: 60 });
    expect(await closed).toEqual({ id: 'q-aaaa' });
    expect(await opened).toMatchObject({ id: 'q-bbbb' });
  });
});
