// Fase 4, "Apagar y prender el Wi-Fi de un alumno no pierde sus trazos": el tablero local del alumno
// manda y, al volver a unirse, se reconcilia con el servidor (shared/boardSync.ts, el mismo código que
// usa client/student/main.ts).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  boardKey,
  diffBoard,
  parseBoardState,
  reconcileBoard,
  serializeBoardState,
  staleBoardKeys,
  type BoardDiff,
  type LocalBoardState,
  type SyncChannel,
} from '../shared/boardSync.js';
import type {
  AckResult,
  Answer,
  AnswersSyncPayload,
  QuestionOpenPayload,
  RosterSyncPayload,
  StateSyncPayload,
  Stroke,
} from '../shared/types.js';
import { Harness, next, type StudentSocket, type TeacherSocket } from './harness.js';

const stroke = (id: string): Stroke => ({
  id,
  color: '#2563eb',
  size: 8,
  points: [
    [0.2, 0.2, 0.5],
    [0.4, 0.3, 0.7],
  ],
});
const ids = (strokes: readonly Stroke[] | undefined) => (strokes ?? []).map((s) => s.id);

// ---------- Unitarias ----------

describe('diffBoard', () => {
  const [a, b, c, d] = ['aaaa', 'bbbb', 'cccc', 'dddd'].map(stroke) as [Stroke, Stroke, Stroke, Stroke];

  it('vacío contra vacío no hace nada', () => {
    expect(diffBoard([], [])).toEqual({ clear: false, remove: [], add: [] });
  });

  it('tableros iguales no hacen nada', () => {
    expect(diffBoard([a, b], [a, b])).toEqual({ clear: false, remove: [], add: [] });
  });

  it('trazos solo del alumno se agregan, en el orden local', () => {
    expect(diffBoard([a, b, c], [])).toEqual({ clear: false, remove: [], add: [a, b, c] });
    expect(diffBoard([c, a], [a])).toEqual({ clear: false, remove: [], add: [c] });
  });

  it('trazos solo del servidor se quitan', () => {
    expect(diffBoard([a], [a, b, c])).toEqual({ clear: false, remove: ['bbbb', 'cccc'], add: [] });
  });

  it('caso mixto: quita lo que sobra y agrega lo que falta', () => {
    expect(diffBoard([a, c, d], [a, b])).toEqual({ clear: false, remove: ['bbbb'], add: [c, d] });
  });

  it('tablero local vacío y servidor con trazos: un solo clear', () => {
    expect(diffBoard([], [a, b])).toEqual({ clear: true, remove: [], add: [] });
  });
});

describe('reconcileBoard', () => {
  const record = () => {
    const events: string[] = [];
    const channel: SyncChannel = {
      strokeAdd: (p) => events.push(`add:${p.stroke.id}`),
      strokeRemove: (p) => events.push(`remove:${p.strokeId}`),
      boardClear: () => events.push('clear'),
      answerSubmit: (p) => {
        events.push(`submit:${p.text ?? ''}`);
        return Promise.resolve<AckResult>({ ok: true });
      },
    };
    return { events, channel };
  };

  it('emite primero los borrados, luego los trazos nuevos y al final la entrega', async () => {
    const { events, channel } = record();
    const result = reconcileBoard({
      questionId: 'q-1',
      local: [stroke('aaaa'), stroke('cccc')],
      server: [stroke('aaaa'), stroke('bbbb')],
      channel,
      submit: { text: 'hola' },
    });
    expect(events).toEqual(['remove:bbbb', 'add:cccc', 'submit:hola']);
    expect(await result.submitted).toEqual({ ok: true });
  });

  it('con el tablero local vacío manda un solo board:clear', () => {
    const { events, channel } = record();
    const result = reconcileBoard({ questionId: 'q-1', local: [], server: [stroke('aaaa'), stroke('bbbb')], channel });
    expect(events).toEqual(['clear']);
    expect(result.submitted).toBeUndefined();
  });
});

describe('estado local persistido', () => {
  const state: LocalBoardState = {
    v: 1,
    strokes: [stroke('aaaa'), stroke('bbbb')],
    text: 'respuesta',
    pendingSubmit: true,
    submitted: false,
    dirty: true,
    savedAt: 1_700_000_000_000,
  };

  it('se guarda y se lee igual', () => {
    expect(parseBoardState(serializeBoardState(state))).toEqual(state);
    const minimal: LocalBoardState = { v: 1, strokes: [], pendingSubmit: false, savedAt: 1 };
    expect(parseBoardState(serializeBoardState(minimal))).toEqual(minimal);
  });

  it('rechaza lo que no es un estado válido', () => {
    const garbage: (string | null | undefined)[] = [
      null,
      undefined,
      '',
      'no es json',
      '[]',
      '42',
      'null',
      '{}',
      JSON.stringify({ ...state, v: 2 }),
      JSON.stringify({ ...state, strokes: 'x' }),
      JSON.stringify({ ...state, pendingSubmit: 'sí' }),
      JSON.stringify({ ...state, text: 5 }),
      JSON.stringify({ ...state, savedAt: 'ayer' }),
      JSON.stringify({ ...state, savedAt: null }),
    ];
    for (const raw of garbage) expect(parseBoardState(raw), String(raw)).toBeUndefined();
  });

  it('descarta trazos inválidos o repetidos y recorta el texto', () => {
    const raw = JSON.stringify({
      ...state,
      text: 'x'.repeat(900),
      strokes: [stroke('aaaa'), { id: 'mal' }, null, 7, stroke('aaaa'), { ...stroke('bbbb'), color: 'rojo' }, stroke('cccc')],
    });
    const parsed = parseBoardState(raw);
    expect(ids(parsed?.strokes)).toEqual(['aaaa', 'cccc']);
    expect(parsed?.text).toHaveLength(500);
  });

  it('las claves viejas se limpian y las ajenas no se tocan', () => {
    const keep = boardKey('s1', 'q2');
    expect(keep).toBe('aula.board.s1.q2');
    const keys = [keep, boardKey('s1', 'q1'), boardKey('s0', 'q9'), 'aula.clientId', 'aula.name'];
    expect(staleBoardKeys(keys, keep)).toEqual(['aula.board.s1.q1', 'aula.board.s0.q9']);
    expect(staleBoardKeys(keys)).toEqual([keep, 'aula.board.s1.q1', 'aula.board.s0.q9']);
  });
});

// ---------- Integración: un "celular" que hace lo mismo que client/student/main.ts ----------

/**
 * Reproduce la lógica del alumno sin DOM: tablero local, entrega pendiente y reconciliación en cada
 * `state:sync` con `reconcileBoard`. La reconexión es manual (`reconnect`) para controlar cuánto tiempo
 * está "sin Wi-Fi"; `drop` corta el transporte como lo haría una caída real.
 */
class SimStudent {
  socket!: StudentSocket;
  local: Stroke[] = [];
  questionId: string | null = null;
  synced = false;
  pendingSubmit = false;
  submitted = false;
  discarded = false;
  lastDiff: BoardDiff | undefined;
  /** Todo lo que este "celular" emitió hacia el servidor, en orden. */
  readonly sent: string[] = [];
  /** Se ejecuta al conectar, antes del `student:join` (socket.io reenvía su búfer en ese momento). */
  beforeJoin: (() => void) | undefined;
  private settling: Promise<void> = Promise.resolve();

  constructor(
    private readonly h: Harness,
    readonly clientId: string,
    readonly name: string,
  ) {}

  private readonly channel: SyncChannel = {
    strokeAdd: (p) => {
      this.sent.push(`add:${p.questionId}:${p.stroke.id}`);
      this.socket.emit('stroke:add', p);
    },
    strokeRemove: (p) => {
      this.sent.push(`remove:${p.questionId}:${p.strokeId}`);
      this.socket.emit('stroke:remove', p);
    },
    boardClear: (p) => {
      this.sent.push(`clear:${p.questionId}`);
      this.socket.emit('board:clear', p);
    },
    answerSubmit: (p) => {
      this.sent.push(`submit:${p.questionId}`);
      return new Promise<AckResult>((resolve) => this.socket.emit('answer:submit', p, resolve));
    },
  };

  /** Abre un socket nuevo (también tras reiniciar el servidor, que cambia de puerto) y espera la reconciliación. */
  async attach(): Promise<void> {
    const socket = this.h.open<StudentSocket>('/student');
    socket.io.reconnection(false); // La reconexión la decide la prueba.
    this.socket = socket;
    socket.on('connect', () => {
      this.synced = false;
      this.beforeJoin?.();
      socket.emit('student:join', { code: this.h.info.code, name: this.name, clientId: this.clientId }, () => undefined);
    });
    socket.on('disconnect', () => {
      this.synced = false;
    });
    socket.on('question:open', (q) => this.adopt(q));
    socket.on('state:sync', (state) => this.onSync(state));
    const synced = next<StateSyncPayload>(socket, 'state:sync');
    await synced;
    await this.settling;
    await this.barrier(); // El servidor ya procesó todo lo que salió de la reconciliación.
  }

  /** Corta el transporte sin avisar, como al apagar el Wi-Fi. */
  async drop(): Promise<void> {
    const gone = new Promise<void>((resolve) => this.socket.once('disconnect', () => resolve()));
    this.socket.io.engine.close();
    await gone;
  }

  /** Vuelve la red: mismo socket, nueva conexión; resuelve cuando termina la reconciliación. */
  async reconnect(): Promise<void> {
    const synced = next<StateSyncPayload>(this.socket, 'state:sync');
    this.socket.connect();
    await synced;
    await this.settling;
    await this.barrier(); // El servidor ya procesó todo lo que salió de la reconciliación.
  }

  draw(s: Stroke): void {
    this.local.push(s);
    if (this.socket.connected) this.channel.strokeAdd({ questionId: this.questionId ?? '', stroke: s });
  }

  erase(strokeId: string): void {
    this.local = this.local.filter((s) => s.id !== strokeId);
    if (this.socket.connected) this.channel.strokeRemove({ questionId: this.questionId ?? '', strokeId });
  }

  clear(): void {
    this.local = [];
    if (this.socket.connected) this.channel.boardClear({ questionId: this.questionId ?? '' });
  }

  async submit(): Promise<void> {
    if (!this.synced) {
      this.pendingSubmit = true;
      return;
    }
    const result = await this.channel.answerSubmit({ questionId: this.questionId ?? '' });
    if (result.ok) this.submitted = true;
  }

  /** Espera a que el servidor procese lo emitido (Socket.IO conserva el orden por socket). */
  async barrier(): Promise<void> {
    await new Promise<AckResult>((resolve) => this.socket.emit('answer:submit', { questionId: 'barrera' }, resolve));
  }

  private adopt(q: { id: string }): void {
    this.questionId = q.id;
    this.local = [];
    this.pendingSubmit = false;
    this.submitted = false;
    this.discarded = false;
  }

  private discard(): void {
    this.questionId = null;
    this.local = [];
    this.pendingSubmit = false;
    this.submitted = false;
    this.discarded = true;
  }

  private onSync(state: StateSyncPayload): void {
    const q = state.question;
    if (this.questionId && q?.id !== this.questionId) this.discard();
    this.synced = true;
    if (!q) return;
    if (this.questionId === null) {
      this.adopt(q);
      this.local = [...(state.myAnswer?.strokes ?? [])];
      this.submitted = state.myAnswer?.submittedAt !== undefined;
    }
    if (this.submitted && state.myAnswer?.submittedAt === undefined) this.pendingSubmit = true;
    const { diff, submitted } = reconcileBoard({
      questionId: q.id,
      local: this.local,
      server: state.myAnswer?.strokes ?? [],
      channel: this.channel,
      ...(this.pendingSubmit ? { submit: {} } : {}),
    });
    this.lastDiff = diff;
    if (submitted) {
      this.settling = submitted.then((result) => {
        if (result.ok) {
          this.pendingSubmit = false;
          this.submitted = true;
        }
      });
    }
  }
}

const serverAnswer = (h: Harness, clientId: string, questionId: string): Answer | undefined =>
  h.server.store.get(h.info.sessionId)?.students.get(clientId)?.answers[questionId];

/** Lo que vería el profesor al abrir la clase: la foto de respuestas de la pregunta actual. */
async function teacherView(h: Harness, name: string): Promise<{ questionId: string; answer: Answer | undefined }> {
  const socket = h.open<TeacherSocket>('/teacher', { sessionId: h.info.sessionId });
  const rosterP = next<RosterSyncPayload>(socket, 'roster:sync');
  const answersP = next<AnswersSyncPayload>(socket, 'answers:sync');
  const [roster, answers] = await Promise.all([rosterP, answersP]);
  socket.disconnect();
  const id = roster.students.find((s) => s.name === name)?.id ?? '';
  return { questionId: answers.question.id, answer: answers.answers[id] };
}

async function openQuestion(teacher: TeacherSocket, student: SimStudent, q: QuestionOpenPayload): Promise<void> {
  const opened = next(student.socket, 'question:open');
  teacher.emit('question:open', q);
  await opened;
}

describe('Dibujo sin conexión: caída de Wi-Fi', () => {
  const h = new Harness();
  let teacher: TeacherSocket;
  beforeAll(async () => {
    await h.start(3);
    teacher = (await h.teacher()).socket;
  }, 30_000);
  afterAll(() => h.stop());

  it('lo dibujado, borrado y entregado sin conexión llega al volver y deja al servidor igual que el alumno', async () => {
    const ana = new SimStudent(h, 'client-ana-offline-1', 'Ana');
    await ana.attach();
    await openQuestion(teacher, ana, { id: 'q-off-1', type: 'blank' });

    ana.draw(stroke('a1-aaaa'));
    ana.draw(stroke('a2-aaaa'));
    ana.draw(stroke('a3-aaaa'));
    await ana.barrier();
    expect(ids(serverAnswer(h, ana.clientId, 'q-off-1')?.strokes)).toEqual(['a1-aaaa', 'a2-aaaa', 'a3-aaaa']);

    await ana.drop();
    ana.draw(stroke('a4-aaaa'));
    ana.draw(stroke('a5-aaaa'));
    ana.erase('a2-aaaa');
    ana.draw(stroke('a6-aaaa'));
    ana.erase('a5-aaaa');
    await ana.submit();
    expect(ana.pendingSubmit).toBe(true);
    expect(ana.sent.filter((e) => e.startsWith('submit'))).toEqual([]);
    // Mientras tanto el servidor sigue como estaba.
    expect(ids(serverAnswer(h, ana.clientId, 'q-off-1')?.strokes)).toEqual(['a1-aaaa', 'a2-aaaa', 'a3-aaaa']);
    expect(serverAnswer(h, ana.clientId, 'q-off-1')?.submittedAt).toBeUndefined();

    await ana.reconnect();
    expect(ana.lastDiff).toMatchObject({ clear: false, remove: ['a2-aaaa'] });
    expect(ids(ana.lastDiff?.add)).toEqual(['a4-aaaa', 'a6-aaaa']);
    expect(ana.pendingSubmit).toBe(false);
    expect(ana.submitted).toBe(true);

    const expected = ['a1-aaaa', 'a3-aaaa', 'a4-aaaa', 'a6-aaaa'];
    expect(ids(ana.local)).toEqual(expected);
    expect(ids(serverAnswer(h, ana.clientId, 'q-off-1')?.strokes)).toEqual(expected);
    expect(serverAnswer(h, ana.clientId, 'q-off-1')?.submittedAt).toEqual(expect.any(Number));

    // Y es lo que ve el profesor al (re)abrir la clase.
    const view = await teacherView(h, 'Ana');
    expect(view.questionId).toBe('q-off-1');
    expect(ids(view.answer?.strokes)).toEqual(expected);
    expect(view.answer?.submittedAt).toEqual(expect.any(Number));
  }, 30_000);

  it('limpiar el pizarrón sin conexión vacía también el del servidor', async () => {
    const beto = new SimStudent(h, 'client-beto-offline-2', 'Beto');
    await beto.attach();
    await openQuestion(teacher, beto, { id: 'q-off-2', type: 'blank' });
    beto.draw(stroke('b1-bbbb'));
    beto.draw(stroke('b2-bbbb'));
    await beto.barrier();

    await beto.drop();
    beto.clear();
    await beto.reconnect();
    expect(beto.lastDiff).toEqual({ clear: true, remove: [], add: [] });
    expect(serverAnswer(h, beto.clientId, 'q-off-2')?.strokes).toEqual([]);
  }, 30_000);

  it('los eventos que el servidor descarta (antes del student:join) también se recuperan', async () => {
    const eva = new SimStudent(h, 'client-eva-offline-3', 'Eva');
    await eva.attach();
    await openQuestion(teacher, eva, { id: 'q-off-3', type: 'blank' });
    eva.draw(stroke('e1-eeee'));
    await eva.barrier();

    await eva.drop();
    // El trazo sale justo al reconectar, antes del join: el servidor aún no sabe quién es y lo ignora.
    eva.beforeJoin = () => eva.draw(stroke('e2-eeee'));
    await eva.reconnect();
    expect(ids(eva.lastDiff?.add)).toEqual(['e2-eeee']);
    expect(ids(serverAnswer(h, eva.clientId, 'q-off-3')?.strokes)).toEqual(['e1-eeee', 'e2-eeee']);
  }, 30_000);

  it('entregar sin conexión y volver a conectar dos veces no duplica trazos ni entregas', async () => {
    const dani = new SimStudent(h, 'client-dani-offline-4', 'Dani');
    await dani.attach();
    await openQuestion(teacher, dani, { id: 'q-off-4', type: 'blank' });
    dani.draw(stroke('d1-dddd'));
    await dani.drop();
    dani.draw(stroke('d2-dddd'));
    await dani.reconnect();
    await dani.drop();
    await dani.reconnect();
    expect(dani.lastDiff).toEqual({ clear: false, remove: [], add: [] });
    expect(ids(serverAnswer(h, dani.clientId, 'q-off-4')?.strokes)).toEqual(['d1-dddd', 'd2-dddd']);
  }, 30_000);
});

describe('Dibujo sin conexión: el servidor se reinicia', () => {
  const h = new Harness();
  let teacher: TeacherSocket;
  beforeAll(async () => {
    await h.start(3);
    teacher = (await h.teacher()).socket;
  }, 30_000);
  afterAll(() => h.stop());

  it('el alumno tiene trazos más nuevos que el último guardado del servidor y los recupera al volver a entrar', async () => {
    const ana = new SimStudent(h, 'client-ana-restart-5', 'Ana');
    await ana.attach();
    await openQuestion(teacher, ana, { id: 'q-rs-1', type: 'blank', timeLimitSec: 600 });
    ana.draw(stroke('r1-aaaa'));
    ana.draw(stroke('r2-aaaa'));
    await ana.submit();
    await ana.barrier();
    expect(ana.submitted).toBe(true);

    await h.restart(async () => {
      // Lo que quedó en disco es más viejo que el alumno: solo el primer trazo y sin entrega.
      const file = path.join(h.dataDir, 'classes', h.info.classId, 'sessions', h.info.sessionId, 'answers', 'q-rs-1.json');
      const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, Answer>;
      for (const answer of Object.values(saved)) {
        answer.strokes = answer.strokes.slice(0, 1);
        delete answer.submittedAt;
      }
      await writeFile(file, JSON.stringify(saved));
    });
    // El celular, mientras tanto, siguió editando.
    expect(ana.synced).toBe(false);
    ana.draw(stroke('r3-aaaa'));
    ana.erase('r1-aaaa');

    await ana.attach();
    expect(ana.lastDiff).toMatchObject({ clear: false, remove: ['r1-aaaa'] });
    expect(ids(ana.lastDiff?.add)).toEqual(['r2-aaaa', 'r3-aaaa']);
    expect(ana.submitted).toBe(true);
    expect(ana.pendingSubmit).toBe(false);
    const answer = serverAnswer(h, ana.clientId, 'q-rs-1');
    expect(ids(answer?.strokes)).toEqual(['r2-aaaa', 'r3-aaaa']);
    expect(answer?.submittedAt).toEqual(expect.any(Number)); // la entrega perdida se reenvió

    const view = await teacherView(h, 'Ana');
    expect(ids(view.answer?.strokes)).toEqual(['r2-aaaa', 'r3-aaaa']);
    expect(view.answer?.submittedAt).toEqual(expect.any(Number));
  }, 30_000);
});

describe('Dibujo sin conexión: la pregunta cambia mientras el alumno no tiene red', () => {
  const h = new Harness();
  let teacher: TeacherSocket;
  beforeAll(async () => {
    await h.start(3);
    teacher = (await h.teacher()).socket;
  }, 30_000);
  afterAll(() => h.stop());

  it('si el profesor la cerró, se descarta lo local y no se reenvía nada', async () => {
    const ana = new SimStudent(h, 'client-ana-closed-6', 'Ana');
    await ana.attach();
    await openQuestion(teacher, ana, { id: 'q-cl-1', type: 'blank' });
    ana.draw(stroke('c1-aaaa'));
    await ana.barrier();

    await ana.drop();
    const closed = next(teacher, 'question:close');
    teacher.emit('question:close', { id: 'q-cl-1' });
    await closed;
    ana.draw(stroke('c2-aaaa'));
    await ana.submit();
    expect(ana.pendingSubmit).toBe(true);

    const sentBefore = ana.sent.length;
    await ana.reconnect();
    expect(ana.discarded).toBe(true);
    expect(ana.local).toEqual([]);
    expect(ana.pendingSubmit).toBe(false);
    expect(ana.sent.length).toBe(sentBefore); // ni trazos ni entrega
    const answer = serverAnswer(h, ana.clientId, 'q-cl-1');
    expect(ids(answer?.strokes)).toEqual(['c1-aaaa']);
    expect(answer?.submittedAt).toBeUndefined();
  }, 30_000);

  it('si el profesor lanzó otra pregunta, lo de la anterior se descarta y la nueva empieza limpia', async () => {
    const ana = new SimStudent(h, 'client-bea-closed-7', 'Bea');
    await ana.attach();
    await openQuestion(teacher, ana, { id: 'q-cl-2', type: 'blank' });
    ana.draw(stroke('c3-aaaa'));
    await ana.barrier();

    await ana.drop();
    teacher.emit('question:open', { id: 'q-cl-3', type: 'blank' });
    await next(teacher, 'question:open');
    ana.draw(stroke('c4-aaaa'));
    const sentBefore = ana.sent.length;

    await ana.reconnect();
    expect(ana.questionId).toBe('q-cl-3');
    expect(ana.local).toEqual([]);
    expect(ana.sent.length).toBe(sentBefore);
    expect(ids(serverAnswer(h, ana.clientId, 'q-cl-2')?.strokes)).toEqual(['c3-aaaa']);
    expect(serverAnswer(h, ana.clientId, 'q-cl-3')?.strokes ?? []).toEqual([]);
  }, 30_000);
});
