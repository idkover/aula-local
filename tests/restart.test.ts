// Fase 4: "Reiniciar el servidor conserva la sesión". La clase en curso vuelve con el mismo código,
// diapositiva, alumnos (que se reconectan solos con su clientId), respuestas y pregunta abierta.
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AckResult,
  AnswersSyncPayload,
  RosterSyncPayload,
  SessionInfo,
  StateSyncPayload,
  Stroke,
} from '../shared/types.js';
import { Harness, next, type StudentSocket, type TeacherSocket } from './harness.js';

const h = new Harness();
const ANA = 'client-ana-restart-1';
const stroke = (id: string): Stroke => ({ id, color: '#16a34a', size: 8, points: [[0.3, 0.3, 0.5], [0.5, 0.6, 0.5]] });

let info: SessionInfo;

beforeAll(async () => {
  await h.start(4);
  info = h.info;
}, 30_000);

afterAll(() => h.stop());

const teacher = async () => {
  const socket = h.open<TeacherSocket>('/teacher', { sessionId: info.sessionId });
  const synced = next<StateSyncPayload>(socket, 'state:sync');
  return { socket, synced: await synced };
};

/** Todos los archivos de texto bajo una carpeta, concatenados (para buscar datos que no deben estar). */
async function readTree(dir: string): Promise<string> {
  let out = '';
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) out += await readFile(path.join(entry.parentPath, entry.name), 'utf8');
  }
  return out;
}

describe('Reinicio del servidor a mitad de clase', () => {
  it('retoma código, diapositiva, alumnos, respuestas y la pregunta abierta', async () => {
    const t = await teacher();
    const ana = (await h.joinStudent(ANA, 'Ana')).socket as StudentSocket;
    t.socket.emit('slide:goto', { index: 2 });
    await next(ana, 'slide:goto');
    const opened = next(ana, 'question:open');
    t.socket.emit('question:open', { id: 'q-restart-1', type: 'overSlide', timeLimitSec: 600, prompt: 'Marca la respuesta' });
    await opened;
    ana.emit('stroke:add', { questionId: 'q-restart-1', stroke: stroke('s-r-1') });
    await new Promise<AckResult>((resolve) => ana.emit('answer:submit', { questionId: 'q-restart-1' }, resolve));

    await h.restart();

    // El profesor recupera la clase con su sessionId guardado: mismo código.
    const again = await h.api<SessionInfo>('GET', `/api/sessions/${info.sessionId}`);
    expect(again).toMatchObject({ sessionId: info.sessionId, code: info.code, slideIndex: 2 });

    // El celular de Ana se reconecta solo con sus credenciales guardadas (mismo clientId y código).
    const back = await h.joinStudent(ANA, 'Ana', info.code);
    expect(back.result).toEqual({ ok: true });
    const sync = await back.synced;
    expect(sync).toMatchObject({ sessionId: info.sessionId, slideIndex: 2 });
    expect(sync.question).toMatchObject({ id: 'q-restart-1', closed: false, prompt: 'Marca la respuesta', timeLimitSec: 600 });
    expect(sync.myAnswer).toMatchObject({ strokes: [stroke('s-r-1')], submittedAt: expect.any(Number) });

    // El profesor ve a Ana (mismo id público) y su respuesta.
    const t2 = h.open<TeacherSocket>('/teacher', { sessionId: info.sessionId });
    // El servidor manda ambos seguidos al conectar: se escuchan los dos antes de esperar.
    const rosterP = next<RosterSyncPayload>(t2, 'roster:sync');
    const answersP = next<AnswersSyncPayload>(t2, 'answers:sync');
    const [roster, answers] = await Promise.all([rosterP, answersP]);
    const anaId = roster.students.find((s) => s.name === 'Ana')?.id ?? '';
    expect(answers.answers[anaId]?.strokes).toEqual([stroke('s-r-1')]);

    // La pregunta sigue abierta de verdad: se puede seguir dibujando.
    const added = next(t2, 'stroke:add');
    back.socket.emit('stroke:add', { questionId: 'q-restart-1', stroke: stroke('s-r-2') });
    await added;
  }, 30_000);

  it('una pregunta cuyo tiempo venció mientras el servidor estaba apagado se cierra al retomar', async () => {
    const t = await teacher();
    t.socket.emit('question:open', { id: 'q-restart-2', type: 'blank', timeLimitSec: 30 });
    await next(t.socket, 'question:open');

    await h.restart(async () => {
      // Simula que el servidor estuvo apagado más que el límite de tiempo.
      const file = path.join(h.dataDir, 'classes', info.classId, 'sessions', info.sessionId, 'session.json');
      const record = JSON.parse(await readFile(file, 'utf8')) as { questions: { id: string; openedAt: number }[] };
      const q = record.questions.find((x) => x.id === 'q-restart-2');
      if (q) q.openedAt -= 60_000;
      await writeFile(file, JSON.stringify(record));
    });

    const back = await h.joinStudent(ANA, 'Ana', info.code);
    expect((await back.synced).question).toBeUndefined();
    const t2 = await teacher();
    expect(t2.synced.question).toBeUndefined();
  }, 30_000);

  it('el estado privado vive fuera del historial y se borra al terminar la clase', async () => {
    const liveFile = path.join(h.dataDir, 'live', `${info.sessionId}.json`);
    expect(await readFile(liveFile, 'utf8')).toContain(ANA);
    expect(await readTree(path.join(h.dataDir, 'classes'))).not.toContain(ANA); // el historial nunca tiene clientId

    const t = await teacher();
    await new Promise<AckResult>((resolve) => t.socket.emit('session:end', resolve));
    expect(existsSync(liveFile)).toBe(false);

    // Tras otro reinicio no resucita: la clase terminada sigue terminada.
    await h.restart();
    await h.api('GET', `/api/sessions/${info.sessionId}`, undefined, 404);
    expect((await h.joinStudent(ANA, 'Ana', info.code)).result).toMatchObject({ ok: false });
  }, 30_000);
});
