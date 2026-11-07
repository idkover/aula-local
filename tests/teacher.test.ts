// Integración de la Fase 3: lo que recibe la vista del profesor (lista, foto inicial, relevo, spotlight).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AnswersSyncPayload,
  AnswerSpotlightPayload,
  AnswerSubmittedPayload,
  FromStudent,
  RosterSyncPayload,
  StrokeAddPayload,
  Stroke,
} from '../shared/types.js';
import { Harness, next, nextWhere, type StudentSocket, type TeacherSocket } from './harness.js';

const h = new Harness();
let teacher: TeacherSocket;
let ana: StudentSocket;
let anaId = '';

const stroke = (id: string): Stroke => ({ id, color: '#e11d48', size: 8, points: [[0.1, 0.1, 0.5], [0.3, 0.2, 0.5]] });

beforeAll(async () => {
  await h.start(2);
  teacher = (await h.teacher()).socket;
}, 30_000);

afterAll(() => h.stop());

describe('Vista del profesor', () => {
  it('recibe la lista de alumnos con id público, nunca el clientId', async () => {
    const roster = nextWhere<RosterSyncPayload>(teacher, 'roster:sync', (r) => r.students.length === 1);
    ana = (await h.joinStudent('client-ana-secret', 'Ana')).socket;
    const { students } = await roster;
    expect(students).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{8}$/), name: 'Ana', connected: true }]);
    expect(JSON.stringify(students)).not.toContain('client-ana-secret');
    anaId = students[0]?.id ?? '';

    const offline = nextWhere<RosterSyncPayload>(teacher, 'roster:sync', (r) => r.students[0]?.connected === false);
    ana.disconnect();
    await offline;
    const back = nextWhere<RosterSyncPayload>(teacher, 'roster:sync', (r) => r.students[0]?.connected === true);
    ana = (await h.joinStudent('client-ana-secret', 'Ana')).socket;
    expect((await back).students.map((s) => s.id)).toEqual([anaId]); // mismo id al reconectar
  });

  it('recibe cada cambio del pizarrón con el id del alumno', async () => {
    teacher.emit('question:open', { id: 'q-grid-1', type: 'blank' });
    await next(ana, 'question:open');

    const added = next<FromStudent<StrokeAddPayload>>(teacher, 'stroke:add');
    ana.emit('stroke:add', { questionId: 'q-grid-1', stroke: { ...stroke('s-0001'), extra: 'x' } as Stroke });
    const relayed = await added;
    expect(relayed).toEqual({ studentId: anaId, questionId: 'q-grid-1', stroke: stroke('s-0001') }); // limpio, sin campos extra

    ana.emit('stroke:add', { questionId: 'q-grid-1', stroke: stroke('s-0002') });
    await next(teacher, 'stroke:add');
    const removed = next(teacher, 'stroke:remove');
    ana.emit('stroke:remove', { questionId: 'q-grid-1', strokeId: 's-0001' });
    expect(await removed).toEqual({ studentId: anaId, questionId: 'q-grid-1', strokeId: 's-0001' });
    const undone = next(teacher, 'stroke:undo');
    ana.emit('stroke:undo', { questionId: 'q-grid-1' });
    expect(await undone).toEqual({ studentId: anaId, questionId: 'q-grid-1' });
    ana.emit('stroke:add', { questionId: 'q-grid-1', stroke: stroke('s-0003') });
    await next(teacher, 'stroke:add');

    // Los cambios inválidos no se reenvían.
    const nothing = next(teacher, 'stroke:add', 300);
    ana.emit('stroke:add', { questionId: 'otra-pregunta', stroke: stroke('s-0004') });
    await expect(nothing).rejects.toThrow();
  });

  it('una ventana nueva del profesor recibe la foto completa de las respuestas', async () => {
    const teacher2 = h.open<TeacherSocket>('/teacher', { sessionId: h.info.sessionId });
    const roster = next<RosterSyncPayload>(teacher2, 'roster:sync');
    const snapshot = next<AnswersSyncPayload>(teacher2, 'answers:sync');
    expect((await roster).students).toHaveLength(1);
    const { question, answers } = await snapshot;
    expect(question).toMatchObject({ id: 'q-grid-1', closed: false });
    expect(answers[anaId]?.strokes.map((s) => s.id)).toEqual(['s-0003']);
    teacher2.disconnect();
  });

  it('avisa cada entrega con el texto, si lo hay', async () => {
    const submitted = next<AnswerSubmittedPayload>(teacher, 'answer:submitted');
    await new Promise((resolve) => ana.emit('answer:submit', { questionId: 'q-grid-1' }, resolve));
    expect(await submitted).toEqual({ studentId: anaId, questionId: 'q-grid-1', submittedAt: expect.any(Number) });
  });

  it('sincroniza la respuesta en grande entre ventanas y la quita al abrir otra pregunta', async () => {
    const projector = h.open<TeacherSocket>('/teacher', { sessionId: h.info.sessionId });
    await next(projector, 'state:sync');

    const shown = next<AnswerSpotlightPayload>(projector, 'answer:spotlight');
    teacher.emit('answer:spotlight', { studentId: anaId, showName: true });
    expect(await shown).toEqual({ studentId: anaId, showName: true });

    // Ids desconocidos se ignoran.
    const ignored = next(projector, 'answer:spotlight', 300);
    teacher.emit('answer:spotlight', { studentId: 'desconocido', showName: false });
    await expect(ignored).rejects.toThrow();

    // Tras cerrar, la respuesta sigue revisable y la foto la conserva.
    teacher.emit('question:close', { id: 'q-grid-1' });
    await next(projector, 'question:close');
    const late = h.open<TeacherSocket>('/teacher', { sessionId: h.info.sessionId });
    const lateSnapshot = next<AnswersSyncPayload>(late, 'answers:sync');
    const lateSpotlight = next<AnswerSpotlightPayload>(late, 'answer:spotlight');
    expect((await lateSnapshot).question).toMatchObject({ id: 'q-grid-1', closed: true });
    expect(await lateSpotlight).toEqual({ studentId: anaId, showName: true });

    const cleared = next<AnswerSpotlightPayload>(projector, 'answer:spotlight');
    teacher.emit('question:open', { id: 'q-grid-2', type: 'text' });
    expect(await cleared).toEqual({ studentId: null, showName: false });
  });

  it('el profesor puede quitar la respuesta en grande', async () => {
    teacher.emit('answer:spotlight', { studentId: anaId, showName: false });
    await next(teacher, 'answer:spotlight');
    const cleared = next<AnswerSpotlightPayload>(teacher, 'answer:spotlight');
    teacher.emit('answer:spotlight', { studentId: null, showName: false });
    expect(await cleared).toEqual({ studentId: null, showName: false });
  });
});
