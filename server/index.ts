// Express + Socket.IO, detección de IP local y QR en consola.
import { existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { Server, type Namespace } from 'socket.io';
import type {
  Answer,
  AnswerSubmittedPayload,
  ApiError,
  AppInfo,
  ClassInfo,
  ClassListItem,
  ConnectInfo,
  Question,
  QuestionAnswers,
  QuestionClosePayload,
  QuestionOpenPayload,
  ServerToStudentEvents,
  ServerToTeacherEvents,
  Session,
  SessionInfo,
  SessionListItem,
  SessionSummary,
  SlideGotoPayload,
  StudentToServerEvents,
  TeacherAuth,
  TeacherToServerEvents,
} from '../shared/types.js';
import { createAuth, isLocalPeer, type PeerAddress } from './auth.js';
import { ClassStore, DECK_ID_RE } from './classes.js';
import { exportFileName, writeSessionZip } from './export.js';
import { LIVE_MAX_AGE_MS } from './live.js';
import { answersOf, HistoryStore, Recorder, statusOf, summarize, toRecord } from './history.js';
import { hasPdftoppm } from './pdf.js';
import { findProjectRoot } from './paths.js';
import { newSessionId, SessionStore } from './session.js';
import { APP_VERSION, createUpdateChecker, DEFAULT_UPDATES_URL, type UpdateChecker } from './update.js';

type StudentSocketData = { sessionId?: string; clientId?: string; studentId?: string };
type TeacherSocketData = { sessionId: string };
type StudentNamespace = Namespace<StudentToServerEvents, ServerToStudentEvents, Record<string, never>, StudentSocketData>;
type TeacherNamespace = Namespace<TeacherToServerEvents, ServerToTeacherEvents, Record<string, never>, TeacherSocketData>;

export type AulaServerOptions = {
  port?: number;
  host?: string;
  /**
   * Carpeta con `classes/<id>/` (clases e historial). Por defecto, la variable AULA_DATA_DIR o `<raíz>/data`.
   */
  dataDir?: string;
  /**
   * Token para `POST /api/app/shutdown` (lo pone el lanzador de la bandeja en AULA_SHUTDOWN_TOKEN).
   * Sin token, la ruta no existe.
   */
  shutdownToken?: string | undefined;
  /** Se llama tras responder 202 a un apagado válido. Por defecto no hace nada (main() cierra el proceso). */
  onShutdownRequest?: (() => void) | undefined;
  /**
   * Comprobación de versión nueva. `enabled: false` no arranca los temporizadores (las pruebas lo usan siempre);
   * `fetch` es el cliente HTTP hacia el servidor de versiones y `baseUrl` su dirección.
   */
  updateCheck?: { fetch?: typeof fetch | undefined; enabled?: boolean | undefined; baseUrl?: string | undefined };
  /** Carpeta con el frontend compilado por Vite. Por defecto `<raíz>/dist/client`. */
  clientDir?: string;
  /** Decide si una conexión viene de la propia laptop (no necesita PIN). Inyectable para las pruebas. */
  isLocal?: (peer: PeerAddress) => boolean;
};

export type AulaServer = {
  port: number;
  store: SessionStore;
  updates: UpdateChecker;
  httpServer: HttpServer;
  close: () => Promise<void>;
};

const MAX_PDF_BYTES = 200 * 1024 * 1024;

/** Compara dos textos secretos sin revelar en cuánto difieren. */
function sameSecret(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createAulaServer(options: AulaServerOptions = {}): Promise<AulaServer> {
  const root = findProjectRoot();
  const envDataDir = process.env.AULA_DATA_DIR;
  const dataDir = options.dataDir ?? (envDataDir && envDataDir.trim() !== '' ? envDataDir : path.join(root, 'data'));
  const clientDir = options.clientDir ?? path.join(root, 'dist', 'client');

  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { serveClient: false, pingInterval: 10_000, pingTimeout: 8_000 });
  // Socket.IO tipa los eventos por servidor, no por namespace; cada namespace tiene su propio contrato.
  const studentNs = io.of('/student') as unknown as StudentNamespace;
  const teacherNs = io.of('/teacher') as unknown as TeacherNamespace;

  let port = options.port ?? 3000;

  const classes = new ClassStore(dataDir);
  const history = new HistoryStore(dataDir);
  const recorder = new Recorder(dataDir);
  const auth = await createAuth(dataDir, { isLocal: options.isLocal ?? isLocalPeer });
  // Mismo servidor de versiones en pruebas y en producción: se configura en un solo lugar.
  const updatesUrl = options.updateCheck?.baseUrl ?? process.env.AULA_UPDATES_URL ?? DEFAULT_UPDATES_URL;
  const updates = createUpdateChecker({
    baseUrl: updatesUrl,
    currentVersion: APP_VERSION,
    fetch: options.updateCheck?.fetch,
  });
  const store = new SessionStore();
  /** Sesiones terminadas en este proceso → su clase: el profesor que vuelve a conectarse va al resumen. */
  const endedSessions = new Map<string, string>();

  const sessionInfo = async (session: Session): Promise<SessionInfo> => {
    const hosts = pickLanAddresses(os.networkInterfaces());
    const urls = (hosts.length ? hosts : ['localhost']).map((h) => `http://${h}:${port}/?code=${session.code}`);
    const joinUrl = urls[0] as string;
    return {
      sessionId: session.id,
      classId: session.classId,
      code: session.code,
      slideCount: session.slides.length,
      slideIndex: session.slideIndex,
      joinUrl,
      altJoinUrls: urls.slice(1),
      qrSvg: await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
    };
  };

  /** Una sola sesión en curso por clase: "Dar clase" otra vez retoma la que ya está abierta. */
  const startSession = async (info: ClassInfo): Promise<Session> => {
    const live = store.liveForClass(info.id);
    if (live) return live;
    const session = store.create(info.slideCount, newSessionId(), info.id);
    await recorder.flush(session); // Aparece en el historial desde el primer momento.
    return session;
  };

  // ---------- HTTP ----------

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    // Refuerza "offline primero": el navegador rechaza cualquier recurso que no venga de esta laptop.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
        "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    next();
  });

  app.use(auth.router);
  app.use(['/api/classes', '/api/sessions'], auth.api);

  // Apagado desde la bandeja: solo con el token del lanzador y desde la propia laptop. Sin token, la ruta no existe.
  if (options.shutdownToken) {
    const shutdownToken = options.shutdownToken;
    app.post('/api/app/shutdown', (req, res) => {
      if (!auth.isLocalRequest(req) || !sameSecret(req.get('X-Aula-Token'), shutdownToken)) {
        res.status(403).json({ error: 'No autorizado.', code: 'FORBIDDEN' });
        return;
      }
      res.status(202).json({ ok: true });
      (options.onShutdownRequest ?? (() => undefined))();
    });
  }

  const rawPdf = express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: MAX_PDF_BYTES });
  const json = express.json({ limit: '256kb' });

  /** Convierte el PDF del cuerpo en una clase nueva; responde el error y devuelve undefined si falla. */
  const createClassFromBody = async (req: Request, res: Response, title: string): Promise<ClassInfo | undefined> => {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.subarray(0, 5).toString('latin1') !== '%PDF-') {
      res.status(400).json({ error: 'Sube un archivo PDF.' });
      return undefined;
    }
    try {
      return await classes.create(body, title);
    } catch (err) {
      console.error('Error al convertir el PDF:', err);
      res.status(422).json({ error: 'No se pudo convertir el PDF. ¿Está dañado o protegido con contraseña?' });
      return undefined;
    }
  };

  // Clase rápida: sube el PDF y empieza a dar la clase en un paso (sin título ni preguntas preparadas).
  app.post('/api/sessions', rawPdf, async (req, res: Response<SessionInfo | ApiError>) => {
    const info = await createClassFromBody(req, res, '');
    if (info) res.status(201).json(await sessionInfo(await startSession(info)));
  });

  app.get('/api/sessions/:id', async (req, res: Response<SessionInfo | ApiError>) => {
    const session = store.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Sesión no encontrada.' });
      return;
    }
    res.json(await sessionInfo(session));
  });

  // ---------- Biblioteca de clases ----------

  const notFound = (res: Response) => res.status(404).json({ error: 'Clase no encontrada.' });

  app.get('/api/classes', async (_req, res: Response<ClassListItem[]>) => {
    const items = await Promise.all(
      (await classes.list()).map(async (info) => {
        const live = store.liveForClass(info.id);
        const sessions = await history.listSessions(info.id, live);
        const { questions, ...rest } = info;
        const item: ClassListItem = { ...rest, questionCount: questions.length, sessionCount: sessions.length };
        if (sessions[0]) item.lastSessionAt = sessions[0].startedAt;
        if (live) item.liveSessionId = live.id;
        return item;
      }),
    );
    res.json(items);
  });

  app.post('/api/classes', rawPdf, async (req, res: Response<ClassInfo | ApiError>) => {
    const info = await createClassFromBody(req, res, typeof req.query.title === 'string' ? req.query.title : '');
    if (info) res.status(201).json(info);
  });

  app.get('/api/classes/:cid', async (req, res: Response<ClassInfo | ApiError>) => {
    const info = await classes.get(req.params.cid);
    if (!info) return void notFound(res);
    res.json(info);
  });

  app.put('/api/classes/:cid', json, async (req, res: Response<ClassInfo | ApiError>) => {
    const outcome = await classes.update(req.params.cid, req.body);
    if (!outcome) return void notFound(res);
    if (!outcome.ok) return void res.status(400).json({ error: outcome.error });
    res.json(outcome.info);
  });

  app.delete('/api/classes/:cid', async (req, res: Response<ApiError>) => {
    if (store.liveForClass(req.params.cid)) {
      res.status(409).json({ error: 'Esta clase está en curso. Termínala antes de borrarla.' });
      return;
    }
    if (!(await classes.delete(req.params.cid))) return void notFound(res);
    res.sendStatus(204);
  });

  app.post('/api/classes/:cid/sessions', async (req, res: Response<SessionInfo | ApiError>) => {
    const info = await classes.get(req.params.cid);
    if (!info) return void notFound(res);
    res.status(201).json(await sessionInfo(await startSession(info)));
  });

  app.get('/api/classes/:cid/sessions', async (req, res: Response<SessionListItem[] | ApiError>) => {
    const info = await classes.get(req.params.cid);
    if (!info) return void notFound(res);
    res.json(await history.listSessions(info.id, store.liveForClass(info.id)));
  });

  /** Sesión de la clase en memoria (en curso) o, si no, la guardada en disco. */
  const findSession = async (classId: string, sessionId: string) => {
    const live = store.get(sessionId);
    if (live?.classId === classId) {
      return {
        record: toRecord(live),
        live,
        roster: store.roster(live),
        answers: (qid: string) => answersOf(live, qid),
      };
    }
    const record = await history.loadSession(classId, sessionId);
    if (!record) return undefined;
    return {
      record,
      live: undefined,
      roster: record.students.map(({ id, name }) => ({ id, name, connected: false })),
      answers: (qid: string) => history.loadAnswers(classId, sessionId, qid),
    };
  };

  app.get('/api/classes/:cid/sessions/:sid', async (req, res: Response<SessionSummary | ApiError>) => {
    const info = await classes.get(req.params.cid);
    const found = info && (await findSession(info.id, req.params.sid));
    if (!info || !found) return void res.status(404).json({ error: 'Sesión no encontrada.' });
    const status = statusOf(found.record, found.live);
    res.json(await summarize(info, found.record, status, found.roster, found.answers));
  });

  app.get('/api/classes/:cid/sessions/:sid/questions/:qid', async (req, res: Response<QuestionAnswers | ApiError>) => {
    const found = await findSession(req.params.cid, req.params.sid);
    const question = found?.record.questions.find((q) => q.id === req.params.qid);
    if (!found || !question) return void res.status(404).json({ error: 'Pregunta no encontrada.' });
    res.json({ question, roster: found.roster, answers: await found.answers(question.id) });
  });

  app.get('/api/classes/:cid/sessions/:sid/export.zip', async (req, res) => {
    const info = await classes.get(req.params.cid);
    const found = info && (await findSession(info.id, req.params.sid));
    if (!info || !found) return void res.status(404).json({ error: 'Sesión no encontrada.' });
    const name = exportFileName(info.title, found.record.startedAt);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="aula.zip"; filename*=UTF-8''${encodeURIComponent(name)}`);
    try {
      await writeSessionZip(
        res,
        {
          classTitle: info.title,
          record: found.record,
          roster: found.roster,
          answers: found.answers,
          slidePath: (i) => path.join(classes.slidesDir(info.id), `${i}.png`),
        },
        { csvSeparator: req.query.sep === 'comma' ? ',' : ';' },
      );
    } catch (err) {
      console.error('Error al exportar:', err);
      if (!res.headersSent) res.status(500).json({ error: 'No se pudo generar el ZIP.' });
      else res.destroy(err as Error);
    }
  });

  // ---------- App: versión, aviso de actualización y conexión de alumnos ----------

  app.get('/api/app/info', auth.api, (_req, res: Response<AppInfo>) => {
    const info: AppInfo = { version: APP_VERSION };
    const update = updates.latest();
    if (update) info.update = update;
    res.json(info);
  });

  /** Dirección que escriben los alumnos (la página de entrada, sin código de clase), una por interfaz de red. */
  const studentUrls = (): string[] => {
    const hosts = pickLanAddresses(os.networkInterfaces());
    return (hosts.length ? hosts : ['localhost']).map((h) => `http://${h}:${port}/`);
  };

  app.get('/api/app/connect', auth.api, async (_req, res: Response<ConnectInfo | ApiError>) => {
    const urls = studentUrls();
    const qrSvg = await QRCode.toString(urls[0] ?? `http://localhost:${port}/`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.json({ urls, qrSvg });
  });

  // Diapositivas: /slides/<id>/ acepta el id de una sesión en curso (clientes en vivo) o el de una clase
  // (biblioteca, editor y resumen). Ambos llevan a data/classes/<classId>/slides/.
  app.get('/slides/:id/:file', async (req, res) => {
    const { id, file } = req.params;
    const classId = store.get(id)?.classId ?? id;
    if (!DECK_ID_RE.test(classId) || !/^\d+\.png$/.test(file) || !(await classes.get(classId))) {
      res.sendStatus(404);
      return;
    }
    res.sendFile(path.join(classes.slidesDir(classId), file), { maxAge: '365d', immutable: true });
  });

  const sendPage = (page: string) => (_req: express.Request, res: Response) => {
    const file = path.join(clientDir, page);
    if (!existsSync(file)) {
      res.status(503).type('text').send('Falta compilar el frontend: ejecuta "npm run build".');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(file);
  };
  app.get('/', sendPage('student/index.html'));
  app.get('/teacher/pin', sendPage('teacher/pin.html')); // Pública: es donde se ingresa el PIN.
  app.get('/teacher', auth.page, sendPage('teacher/index.html'));
  // Ventana para la segunda pantalla (proyector extendido): solo diapositiva o respuesta en grande.
  app.get('/teacher/proyector', auth.page, sendPage('teacher/projector.html'));
  app.get('/teacher/clases', auth.page, sendPage('teacher/library.html'));
  app.get('/teacher/resumen', auth.page, sendPage('teacher/summary.html'));
  app.get('/teacher/conectar', auth.page, sendPage('teacher/conectar.html'));
  app.get('/teacher/guia-red', auth.page, sendPage('teacher/guia-red.html'));
  app.use('/assets', express.static(path.join(clientDir, 'assets'), { maxAge: '365d', immutable: true }));

  const onError: ErrorRequestHandler = (err: { status?: number; type?: string }, _req, res, _next) => {
    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: 'El archivo es demasiado grande (máximo 200 MB por PDF).' });
      return;
    }
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Datos inválidos.' });
      return;
    }
    console.error(err);
    res.status(err.status ?? 500).json({ error: 'Error interno del servidor.' });
  };
  app.use(onError);

  // ---------- Socket.IO: alumnos ----------

  const emitStatus = (session: Session) => teacherNs.to(session.id).emit('answer:status', store.status(session));
  const emitRoster = (session: Session) =>
    teacherNs.to(session.id).emit('roster:sync', { students: store.roster(session) });
  /** Las respuestas de una pregunta cambiaron: se guardan en disco en el siguiente lote. */
  const touchAnswers = (sessionId: string, questionId: unknown) => {
    const session = store.get(sessionId);
    if (session && typeof questionId === 'string') recorder.touch(session, questionId);
  };

  studentNs.on('connection', (socket) => {
    socket.on('student:join', (payload, ack) => {
      if (typeof ack !== 'function') return;
      const outcome = store.join(payload, socket.id);
      if (!outcome.ok) {
        ack(outcome);
        return;
      }
      const { session, student } = outcome;
      const prev = socket.data;
      if (prev.sessionId && prev.clientId && prev.sessionId !== session.id) {
        void socket.leave(prev.sessionId);
        const prevSession = store.get(prev.sessionId);
        if (store.disconnect(prev.sessionId, prev.clientId, socket.id) && prevSession) {
          emitStatus(prevSession);
          emitRoster(prevSession);
        }
      }
      socket.data = { sessionId: session.id, clientId: student.clientId, studentId: student.id };
      void socket.join(session.id);
      ack({ ok: true });
      socket.emit('state:sync', store.stateFor(session, student));
      emitStatus(session);
      emitRoster(session);
      recorder.touchSoon(session);
    });

    /** Ejecuta `fn` solo si el socket ya se unió a una sesión. */
    const asStudent = (fn: (sessionId: string, clientId: string, studentId: string) => void) => {
      const { sessionId, clientId, studentId } = socket.data;
      if (sessionId && clientId && studentId) fn(sessionId, clientId, studentId);
    };

    // Cada cambio se guarda y, si es válido, se reenvía a la cuadrícula del profesor con el id público.
    socket.on('stroke:add', (payload) =>
      asStudent((s, c, studentId) => {
        const stroke = store.addStroke(s, c, payload);
        if (!stroke) return;
        teacherNs.to(s).emit('stroke:add', { studentId, questionId: payload.questionId, stroke });
        touchAnswers(s, payload.questionId);
      }),
    );
    socket.on('stroke:undo', (payload) =>
      asStudent((s, c, studentId) => {
        if (!store.undoStroke(s, c, payload)) return;
        teacherNs.to(s).emit('stroke:undo', { studentId, questionId: payload.questionId });
        touchAnswers(s, payload.questionId);
      }),
    );
    socket.on('stroke:remove', (payload) =>
      asStudent((s, c, studentId) => {
        if (!store.removeStroke(s, c, payload)) return;
        teacherNs.to(s).emit('stroke:remove', { studentId, questionId: payload.questionId, strokeId: payload.strokeId });
        touchAnswers(s, payload.questionId);
      }),
    );
    socket.on('board:clear', (payload) =>
      asStudent((s, c, studentId) => {
        if (!store.clearBoard(s, c, payload)) return;
        teacherNs.to(s).emit('board:clear', { studentId, questionId: payload.questionId });
        touchAnswers(s, payload.questionId);
      }),
    );

    socket.on('answer:submit', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      const { sessionId, clientId } = socket.data;
      const session = sessionId ? store.get(sessionId) : undefined;
      if (!session || !clientId) {
        reply({ ok: false, error: 'No estás unido a una sesión.' });
        return;
      }
      const result = store.submitAnswer(session.id, clientId, payload);
      reply(result);
      if (!result.ok) return;
      const student = session.students.get(clientId);
      const question = session.question;
      const answer = question && student?.answers[question.id];
      if (student && question && answer?.submittedAt !== undefined) {
        const submitted: AnswerSubmittedPayload = { studentId: student.id, questionId: question.id, submittedAt: answer.submittedAt };
        if (answer.text !== undefined) submitted.text = answer.text;
        teacherNs.to(session.id).emit('answer:submitted', submitted);
        recorder.touch(session, question.id);
      }
      emitStatus(session);
    });

    socket.on('disconnect', () => {
      const { sessionId, clientId } = socket.data;
      if (!sessionId || !clientId) return;
      const session = store.get(sessionId);
      if (session && store.disconnect(sessionId, clientId, socket.id)) {
        emitStatus(session);
        emitRoster(session);
      }
    });
  });

  // ---------- Preguntas ----------

  const questionTimers = new Map<string, NodeJS.Timeout>();

  const broadcastClose = (session: Session, question: Question) => {
    clearTimeout(questionTimers.get(session.id));
    questionTimers.delete(session.id);
    studentNs.to(session.id).emit('question:close', { id: question.id });
    teacherNs.to(session.id).emit('question:close', { id: question.id });
    emitStatus(session);
    // Una pregunta cerrada ya no cambia: se guarda de inmediato.
    void recorder.flush(session, question.id);
  };

  /** Al vencer el tiempo el servidor cierra la pregunta, igual que si la cerrara el profesor. */
  const armQuestionTimer = (session: Session, question: Question, remainingMs: number) => {
    clearTimeout(questionTimers.get(session.id));
    questionTimers.set(
      session.id,
      setTimeout(() => {
        const closed = store.closeQuestion(session.id, question.id);
        if (closed) broadcastClose(session, closed);
      }, Math.max(0, remainingMs)),
    );
  };

  const broadcastOpen = (session: Session, question: Question) => {
    const payload: QuestionOpenPayload = { id: question.id, type: question.type };
    if (question.slideIndex !== undefined) payload.slideIndex = question.slideIndex;
    if (question.prompt !== undefined) payload.prompt = question.prompt;
    if (question.preparedId !== undefined) payload.preparedId = question.preparedId;
    recorder.touchSoon(session, question.id);
    if (question.timeLimitSec !== undefined) {
      payload.timeLimitSec = question.timeLimitSec;
      armQuestionTimer(session, question, question.timeLimitSec * 1000);
    }
    studentNs.to(session.id).emit('question:open', payload);
    teacherNs.to(session.id).emit('question:open', payload);
    emitStatus(session);
  };

  // ---------- Socket.IO: profesor ----------

  teacherNs.use((socket, next) => auth.socket(socket.request, next));
  teacherNs.use((socket, next) => {
    const { sessionId } = socket.handshake.auth as Partial<TeacherAuth>;
    if (typeof sessionId !== 'string' || !store.get(sessionId)) {
      const classId = typeof sessionId === 'string' ? endedSessions.get(sessionId) : undefined;
      // Clase terminada: el cliente recibe la clase en `data` para abrir su resumen.
      const err = new Error(classId ? 'SESSION_ENDED' : 'SESSION_NOT_FOUND') as Error & { data?: unknown };
      if (classId) err.data = { classId, sessionId };
      next(err);
      return;
    }
    socket.data = { sessionId };
    next();
  });

  teacherNs.on('connection', (socket) => {
    const { sessionId } = socket.data;
    const session = store.get(sessionId);
    if (!session) {
      socket.disconnect(true);
      return;
    }
    void socket.join(sessionId);
    // Foto completa para la vista del profesor (también al recargar o abrir la ventana de proyección).
    socket.emit('state:sync', store.stateFor(session));
    socket.emit('answer:status', store.status(session));
    socket.emit('roster:sync', { students: store.roster(session) });
    const answers = store.answersFor(session);
    if (answers) socket.emit('answers:sync', answers);
    if (session.spotlight) socket.emit('answer:spotlight', session.spotlight);

    socket.on('slide:goto', (payload: SlideGotoPayload | undefined) => {
      const index = payload?.index;
      if (index === undefined || !store.gotoSlide(sessionId, index)) return;
      studentNs.to(sessionId).emit('slide:goto', { index });
      teacherNs.to(sessionId).emit('slide:goto', { index });
      recorder.touchSoon(session);
    });

    socket.on('question:open', (payload) => {
      const hadSpotlight = Boolean(session.spotlight);
      const outcome = store.openQuestion(sessionId, payload);
      if (!outcome) return;
      if (outcome.closedPrevious) broadcastClose(session, outcome.closedPrevious);
      if (hadSpotlight) teacherNs.to(sessionId).emit('answer:spotlight', { studentId: null, showName: false });
      broadcastOpen(session, outcome.question);
    });

    socket.on('session:end', (ack) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      const outcome = store.endSession(sessionId);
      if (!outcome) {
        reply({ ok: false, error: 'La clase ya terminó.' });
        return;
      }
      if (outcome.closed) broadcastClose(session, outcome.closed);
      void recorder.flush(session).then(async () => {
        await recorder.live.remove(session.id); // Ya no hay nada que retomar.
        endedSessions.set(session.id, session.classId);
        studentNs.to(sessionId).emit('session:end');
        teacherNs.to(sessionId).emit('session:end', { classId: session.classId, sessionId });
        studentNs.in(sessionId).socketsLeave(sessionId);
        store.delete(sessionId);
        reply({ ok: true });
      });
    });

    socket.on('answer:spotlight', (payload) => {
      const spotlight = store.setSpotlight(sessionId, payload);
      if (spotlight === undefined) return;
      teacherNs.to(sessionId).emit('answer:spotlight', spotlight ?? { studentId: null, showName: false });
      recorder.touchSoon(session);
    });

    socket.on('question:close', (payload: QuestionClosePayload | undefined) => {
      const closed = store.closeQuestion(sessionId, payload?.id);
      if (closed) broadcastClose(session, closed);
    });
  });

  // ---------- Retomar clases tras un reinicio ----------

  const restoreLive = async (now = Date.now()) => {
    for (const snapshot of await recorder.live.list()) {
      const record = await history.loadSession(snapshot.classId, snapshot.sessionId);
      const info = await classes.get(snapshot.classId);
      // Muy vieja, ya terminada o de una clase borrada: queda en el historial como "interrumpida".
      if (!record || !info || record.endedAt !== undefined || now - snapshot.savedAt > LIVE_MAX_AGE_MS) {
        await recorder.live.remove(snapshot.sessionId);
        continue;
      }
      const answers: Record<string, Record<string, Answer>> = {};
      for (const q of record.questions) answers[q.id] = await history.loadAnswers(info.id, record.id, q.id);
      const session = store.restore(snapshot, record, info.slideCount, answers);
      const open = session.question && !session.question.closed ? session.question : undefined;
      if (open?.timeLimitSec !== undefined) {
        const remaining = open.openedAt + open.timeLimitSec * 1000 - now;
        if (remaining > 0) armQuestionTimer(session, open, remaining);
        else store.closeQuestion(session.id, open.id); // Venció mientras el servidor estaba apagado.
      }
      await recorder.flush(session, open?.id);
      console.log(`  Clase retomada: "${info.title || 'Clase sin título'}" (código ${session.code}).`);
    }
  };
  await restoreLive();

  // ---------- Arranque ----------

  if (options.updateCheck?.enabled !== false) updates.start();

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, options.host ?? '0.0.0.0', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  port = (httpServer.address() as AddressInfo).port;

  return {
    port,
    store,
    updates,
    httpServer,
    close: async () => {
      updates.stop();
      for (const timer of questionTimers.values()) clearTimeout(timer);
      // Se guarda todo: las clases en curso se retoman al volver a arrancar.
      await recorder.flushAll(store.all().filter((s) => s.endedAt === undefined));
      const closing = io.close(); // también cierra httpServer
      // Las conexiones keep-alive de los navegadores abiertos no deben retrasar el apagado.
      httpServer.closeAllConnections();
      await closing;
    },
  };
}

// ---------- Detección de IP ----------

const VIRTUAL_IFACE_RE = /virtualbox|vmware|vethernet|hyper-v|wsl|docker|vboxnet|utun|tailscale|zerotier|hamachi|loopback/i;

/**
 * IPv4 no internas ordenadas por preferencia: primero el hotspot de Windows (192.168.137.x),
 * luego redes privadas de un router, y al final adaptadores virtuales (VirtualBox, WSL, VPN…).
 */
export function pickLanAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  const candidates: { address: string; score: number }[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal || info.address.startsWith('169.254.')) continue;
      const a = info.address;
      let score = 2;
      if (a.startsWith('192.168.137.')) score = 0;
      else if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) score = 1;
      if (VIRTUAL_IFACE_RE.test(name) || a.startsWith('192.168.56.')) score += 10;
      candidates.push({ address: a, score });
    }
  }
  return [...new Set(candidates.sort((x, y) => x.score - y.score).map((c) => c.address))];
}

// ---------- Punto de entrada ----------

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  // Con token, la app la lanzó la bandeja: nadie ve la consola, así que se omiten el QR y la nota del firewall.
  const shutdownToken = process.env.AULA_SHUTDOWN_TOKEN || undefined;
  const server = await createAulaServer({
    port,
    shutdownToken,
    onShutdownRequest: () => shutdown(),
  });
  const hosts = pickLanAddresses(os.networkInterfaces());
  const studentUrl = `http://${hosts[0] ?? 'localhost'}:${server.port}/`;

  console.log('\n  aula-local listo\n');
  console.log(`  Profesor:  http://localhost:${server.port}/teacher`);
  console.log(`  Alumnos:   ${studentUrl}`);
  for (const h of hosts.slice(1)) console.log(`             http://${h}:${server.port}/   (otra interfaz)`);
  if (!hosts.length) console.log('  ⚠ No se detectó ninguna red local. Conecta la laptop al router o enciende el hotspot.');
  console.log(`  PDF → PNG: ${(await hasPdftoppm()) ? 'pdftoppm (Poppler)' : 'pdfjs-dist (Poppler no instalado)'}`);
  console.log('');
  if (!shutdownToken) {
    console.log(await QRCode.toString(studentUrl, { type: 'terminal', small: true }));
    console.log('  Si los celulares no cargan la página: permite "Node.js" en redes PRIVADAS en el firewall');
    console.log('  (Windows: Firewall de Windows Defender → Permitir una aplicación; macOS: Ajustes → Red → Firewall).\n');
  }

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
const isMain = process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self;
if (isMain) {
  main().catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`El puerto ${process.env.PORT ?? 3000} está ocupado. ¿Ya hay otro aula-local abierto? Usa PORT=3001 npm start.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
