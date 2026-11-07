// Fase 3: las miniaturas del profesor se actualizan en menos de 1 s con 40 alumnos simulados.
// El profesor es la página real (Chromium); los alumnos son 40 sockets de socket.io-client en Node.
//
// Método de medición (mismo reloj: la misma máquina, tiempo en ms de época):
//  - Nodo: justo antes de cada `emit('stroke:add')` se guarda `Date.now()` por alumno y número de trazo.
//  - Página: un MutationObserver sobre `#answer-grid` (atributo `data-stroke-count`) guarda, por miniatura,
//    `performance.timeOrigin + performance.now()` cada vez que el contador cambia. Eso ocurre justo
//    después de redibujar el lienzo, así que mide emisión -> servidor -> profesor -> miniatura redibujada.
//  - Latencia del trazo n de un alumno = (primera observación de su miniatura con contador >= n) - (emisión de n).
//    Si el navegador agrupara dos trazos en un solo redibujo, el segundo cuenta con ese mismo instante
//    (nunca se subestima la latencia).
//  - Alumno -> miniatura: el test abre además un socket de profesor para leer `roster:sync`
//    ({ id público, name }) y relacionar el nombre del alumno con `data-student-id`.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';
import type { AulaServer, createAulaServer } from '../../server/index.js';
import type {
  QuestionOpenPayload,
  RosterSyncPayload,
  ServerToStudentEvents,
  ServerToTeacherEvents,
  SessionInfo,
  Stroke,
  StudentJoinResult,
  StudentToServerEvents,
  TeacherToServerEvents,
} from '../../shared/types.js';
import { makePdf } from '../helpers.js';

const STUDENTS = 40;
const LIMIT_MS = 1000;
const EXTRA_STROKES = 5;
const STROKE_INTERVAL_MS = 200;

type StudentSocket = Socket<ServerToStudentEvents, StudentToServerEvents>;
type TeacherSocket = Socket<ServerToTeacherEvents, TeacherToServerEvents>;
type Observation = { id: string; count: number; t: number };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Trazo válido para el servidor y distinguible por alumno y número. */
function makeStroke(student: number, n: number): Stroke {
  const base = (student % 10) / 10;
  return {
    id: `e2e-${student}-${n}`,
    color: '#1a73e8',
    size: 6,
    points: [
      [base, 0.1 * n, 0.5],
      [Math.min(1, base + 0.05), Math.min(1, 0.1 * n + 0.05), 0.6],
      [Math.min(1, base + 0.1), Math.min(1, 0.1 * n + 0.1), 0.5],
    ],
  };
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 };
}

// Código que corre dentro de la página (como texto, para no depender de los tipos del DOM).
const INSTALL_OBSERVER = `(() => {
  const grid = document.querySelector('#answer-grid');
  const log = [];
  window.__strokeLog = log;
  const record = (el) => {
    const id = el.getAttribute('data-student-id');
    if (id === null) return;
    log.push({ id, count: Number(el.getAttribute('data-stroke-count') ?? 0), t: performance.timeOrigin + performance.now() });
  };
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'data-stroke-count') record(m.target);
      if (m.type === 'childList') m.addedNodes.forEach((n) => { if (n.nodeType === 1) record(n); });
    }
  }).observe(grid, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-stroke-count'] });
})()`;

test.describe('Fase 3: cuadrícula del profesor con 40 alumnos', () => {
  let server: AulaServer | undefined;
  let tmp = '';
  const sockets: Socket[] = [];

  test.afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await server?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('las miniaturas se actualizan en menos de 1 s', async ({ page }) => {
    // --- Servidor compilado (dist/server), puerto libre ---
    tmp = await mkdtemp(path.join(os.tmpdir(), 'aula-e2e-'));
    const dataDir = path.join(tmp, 'data');
    const entry = path.resolve(import.meta.dirname, '../../dist/server/index.js');
    const mod = (await import(pathToFileURL(entry).href)) as { createAulaServer: typeof createAulaServer };
    server = await mod.createAulaServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      updateCheck: { enabled: false },
    });
    const base = `http://127.0.0.1:${server.port}`;

    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: makePdf(3),
    });
    expect(res.status).toBe(201);
    const info = (await res.json()) as SessionInfo;

    // --- Profesor: página real ---
    await page.addInitScript((sessionId) => {
      localStorage.setItem('aula.teacher.sessionId', sessionId);
    }, info.sessionId);
    await page.goto(`${base}/teacher`);
    await expect(page.locator('#open-question')).toBeVisible();

    // Socket de profesor solo para leer el roster (id público <-> nombre).
    const rosterSocket = io(`${base}/teacher`, {
      transports: ['websocket'],
      forceNew: true,
      auth: { sessionId: info.sessionId },
    }) as TeacherSocket;
    sockets.push(rosterSocket);
    let roster: RosterSyncPayload = { students: [] };
    rosterSocket.on('roster:sync', (payload) => {
      roster = payload;
    });

    // --- 40 alumnos simulados ---
    const students: StudentSocket[] = [];
    for (let i = 0; i < STUDENTS; i++) {
      const socket = io(`${base}/student`, { transports: ['websocket'], forceNew: true }) as StudentSocket;
      sockets.push(socket);
      students.push(socket);
    }
    let questionId = '';
    students[0]?.on('question:open', (payload: QuestionOpenPayload) => {
      questionId = payload.id;
    });
    await Promise.all(
      students.map(
        (socket, i) =>
          new Promise<void>((resolve, reject) => {
            const join = () =>
              socket.emit(
                'student:join',
                { code: info.code, name: `Alumno ${i}`, clientId: `e2e-client-${String(i).padStart(3, '0')}` },
                (result: StudentJoinResult) => (result.ok ? resolve() : reject(new Error(`join: ${result.error}`))),
              );
            if (socket.connected) join();
            else socket.once('connect', join);
          }),
      ),
    );
    await expect.poll(() => roster.students.length, { timeout: 10_000 }).toBe(STUDENTS);
    const publicId = new Map(roster.students.map((s) => [s.name, s.id]));

    // --- Pregunta lanzada con la interfaz real ---
    await page.click('#open-question');
    await page.locator('#question-form input[name="type"][value="blank"]').check();
    await page.click('#question-form button[value="launch"]');
    await expect(page.locator('#answer-grid [data-student-id]')).toHaveCount(STUDENTS, { timeout: 15_000 });
    await expect.poll(() => questionId, { timeout: 5000 }).not.toBe('');

    await page.evaluate(INSTALL_OBSERVER);

    // Instante de emisión por alumno y número de trazo.
    const emitted = new Map<string, number>(); // `${i}:${n}` -> epoch ms
    const send = (i: number, n: number) => {
      emitted.set(`${i}:${n}`, Date.now());
      students[i]?.emit('stroke:add', { questionId, stroke: makeStroke(i, n) });
    };

    const readLog = () => page.evaluate<Observation[]>('window.__strokeLog');
    const waitForCounts = async (count: number) => {
      await expect
        .poll(
          async () => {
            const done = new Set((await readLog()).filter((o) => o.count >= count).map((o) => o.id));
            return done.size;
          },
          { timeout: 15_000, intervals: [50] },
        )
        .toBe(STUDENTS);
    };
    /** Latencias del trazo n de cada alumno (ms). */
    const latencies = async (n: number): Promise<number[]> => {
      const log = await readLog();
      return students.map((_, i) => {
        const id = publicId.get(`Alumno ${i}`);
        const seen = log.filter((o) => o.id === id && o.count >= n).map((o) => o.t);
        const sent = emitted.get(`${i}:${n}`);
        if (seen.length === 0 || sent === undefined) throw new Error(`Sin observación del trazo ${n} del alumno ${i}`);
        return Math.min(...seen) - sent;
      });
    };

    // --- Escenario A: ráfaga, los 40 a la vez ---
    for (let i = 0; i < STUDENTS; i++) send(i, 1);
    await waitForCounts(1);
    const burst = stats(await latencies(1));
    console.log(`Ráfaga (${burst.n} trazos) p50=${burst.p50.toFixed(0)} ms p95=${burst.p95.toFixed(0)} ms max=${burst.max.toFixed(0)} ms`);
    expect(burst.max).toBeLessThan(LIMIT_MS);

    // --- Escenario B: sostenido, 5 trazos más por alumno, uno cada ~200 ms, escalonados ---
    const offset = STROKE_INTERVAL_MS / STUDENTS; // 5 ms entre alumnos
    const timers: Promise<void>[] = [];
    for (let i = 0; i < STUDENTS; i++) {
      timers.push(
        (async () => {
          await sleep(i * offset);
          for (let n = 2; n <= 1 + EXTRA_STROKES; n++) {
            send(i, n);
            if (n < 1 + EXTRA_STROKES) await sleep(STROKE_INTERVAL_MS);
          }
        })(),
      );
    }
    await Promise.all(timers);
    await waitForCounts(1 + EXTRA_STROKES);

    const all: number[] = [];
    for (let n = 2; n <= 1 + EXTRA_STROKES; n++) all.push(...(await latencies(n)));
    const sustained = stats(all);
    console.log(`Sostenido (${sustained.n} trazos) p50=${sustained.p50.toFixed(0)} ms p95=${sustained.p95.toFixed(0)} ms max=${sustained.max.toFixed(0)} ms`);
    expect(sustained.max).toBeLessThan(LIMIT_MS);

    // Todas las miniaturas terminan con los 6 trazos.
    const finalCounts = await page.evaluate<string[]>(
      `Array.from(document.querySelectorAll('#answer-grid [data-student-id]')).map((e) => e.getAttribute('data-stroke-count'))`,
    );
    expect(finalCounts).toHaveLength(STUDENTS);
    expect(new Set(finalCounts)).toEqual(new Set([String(1 + EXTRA_STROKES)]));
  });
});
