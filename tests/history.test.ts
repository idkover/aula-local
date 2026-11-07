import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HistoryStore, Recorder, sessionDir, toRecord } from '../server/history.js';
import { SessionStore } from '../server/session.js';
import type { Stroke } from '../shared/types.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'aula-history-'));
afterAll(() => rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const CLASS_ID = 'aaaaaaaaaaaa';
const stroke = (id: string): Stroke => ({ id, color: '#111111', size: 8, points: [[0.1, 0.1, 0.5]] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (file: string) => stat(file).then(() => true, () => false);

function liveSession() {
  const store = new SessionStore();
  const session = store.create(3, undefined, CLASS_ID, 1000);
  store.join({ code: session.code, name: 'Ana', clientId: 'client-secret-ana' }, 's1');
  return { store, session };
}

describe('SessionStore con historial', () => {
  it('guarda todas las preguntas, con enunciado, y no permite reusar un id', () => {
    const { store, session } = liveSession();
    expect(store.openQuestion(session.id, { id: 'q-0001', type: 'blank', prompt: ' Dibuja ', preparedId: 'pq-0001' })).toBeDefined();
    expect(store.openQuestion(session.id, { id: 'q-0002', type: 'text' })).toBeDefined();
    expect(store.openQuestion(session.id, { id: 'q-0001', type: 'blank' })).toBeUndefined(); // ya se usó
    expect(session.questions.map((q) => [q.id, q.closed, q.prompt, q.preparedId])).toEqual([
      ['q-0001', true, 'Dibuja', 'pq-0001'],
      ['q-0002', false, undefined, undefined],
    ]);
  });

  it('terminar la clase cierra la pregunta y deja de aceptar alumnos', () => {
    const { store, session } = liveSession();
    store.openQuestion(session.id, { id: 'q-0001', type: 'blank' });
    const ended = store.endSession(session.id, 5000);
    expect(ended?.closed?.id).toBe('q-0001');
    expect(session.endedAt).toBe(5000);
    expect(store.endSession(session.id)).toBeUndefined();
    expect(store.join({ code: session.code, name: 'Beto', clientId: 'client-beto-0002' }, 's2')).toMatchObject({ ok: false });
    expect(store.openQuestion(session.id, { id: 'q-0002', type: 'blank' })).toBeUndefined();
  });

  it('el registro guardado nunca incluye el clientId', () => {
    const { session } = liveSession();
    const record = toRecord(session);
    expect(record.students).toEqual([{ id: expect.any(String), name: 'Ana' }]);
    expect(JSON.stringify(record)).not.toContain('client-secret-ana');
  });
});

describe('Recorder', () => {
  it('agrupa los cambios y guarda tras la espera; flush guarda al instante', async () => {
    const { store, session } = liveSession();
    const recorder = new Recorder(tmp, 80);
    const dir = sessionDir(tmp, CLASS_ID, session.id);
    store.openQuestion(session.id, { id: 'q-0001', type: 'blank' });
    store.addStroke(session.id, 'client-secret-ana', { questionId: 'q-0001', stroke: stroke('s-0001') });

    recorder.touch(session, 'q-0001');
    recorder.touch(session, 'q-0001');
    expect(await exists(path.join(dir, 'session.json'))).toBe(false); // todavía en espera
    await sleep(250);
    const answers = JSON.parse(await readFile(path.join(dir, 'answers', 'q-0001.json'), 'utf8'));
    expect(Object.values(answers)).toEqual([{ strokes: [stroke('s-0001')] }]);

    // Un cambio nuevo seguido de flush inmediato no se pierde.
    store.addStroke(session.id, 'client-secret-ana', { questionId: 'q-0001', stroke: stroke('s-0002') });
    recorder.touch(session, 'q-0001');
    await recorder.flush(session);
    const again = JSON.parse(await readFile(path.join(dir, 'answers', 'q-0001.json'), 'utf8'));
    expect((Object.values(again)[0] as { strokes: Stroke[] }).strokes).toHaveLength(2);
  });

  it('el historial distingue sesiones terminadas, en curso e interrumpidas', async () => {
    const recorder = new Recorder(tmp, 10_000);
    const history = new HistoryStore(tmp);
    const a = liveSession();
    const b = liveSession();
    const c = liveSession();
    a.store.endSession(a.session.id);
    for (const s of [a.session, b.session, c.session]) await recorder.flush(s);

    const list = await history.listSessions(CLASS_ID, c.session);
    const statusOf = (id: string) => list.find((s) => s.id === id)?.status;
    expect(statusOf(a.session.id)).toBe('ended');
    expect(statusOf(b.session.id)).toBe('interrupted');
    expect(statusOf(c.session.id)).toBe('live');
    expect(await history.loadSession(CLASS_ID, '../../etc')).toBeUndefined();
  });
});
