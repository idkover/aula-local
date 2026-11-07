// Modelos de datos y protocolo de eventos Socket.IO compartidos por servidor y clientes.
// Fuente: SPEC.md, secciones "Protocolo de eventos" y "Estructura del repo y modelos de datos".
// ---------- Modelos ----------

/** Punto de un trazo: x e y normalizadas 0–1 respecto al lienzo, presión 0–1. Redondeados a 3 decimales. */
export type StrokePoint = [x: number, y: number, pressure: number];

/**
 * Trazo terminado. `size` es el grosor relativo al ancho del pizarrón, en milésimas
 * (size 6 = 0.6 % del ancho), para que se vea igual en cualquier pantalla.
 */
export type Stroke = { id: string; color: string; size: number; points: StrokePoint[] };

export type QuestionType = 'blank' | 'overSlide' | 'text';

export type Question = {
  id: string;
  type: QuestionType;
  slideIndex?: number;
  openedAt: number;
  timeLimitSec?: number;
  closed: boolean;
  /** Enunciado opcional escrito por el profesor (además de lo que diga la diapositiva). */
  prompt?: string;
  /** Pregunta preparada de la que salió, si se lanzó desde la clase preparada. */
  preparedId?: string;
};

export type Answer = { strokes: Stroke[]; text?: string; submittedAt?: number };

export type Student = {
  /**
   * Identificador público (lo ve el profesor). Distinto de `clientId`, que funciona como credencial
   * de reconexión del alumno y nunca sale del servidor.
   */
  id: string;
  clientId: string;
  name: string;
  socketId?: string;
  connected: boolean;
  answers: Record<string, Answer>;
};

export type Session = {
  id: string;
  /** Clase (presentación preparada) que se está dando; sus diapositivas viven en data/classes/<classId>/. */
  classId: string;
  code: string;
  pinHash: string;
  /** URL de cada diapositiva (PNG), en orden. */
  slides: string[];
  slideIndex: number;
  question?: Question;
  /** Todas las preguntas lanzadas en esta sesión, en orden (la última puede ser `question`). */
  questions: Question[];
  startedAt: number;
  endedAt?: number;
  /** Respuesta mostrada en grande en la vista del profesor y en la de proyección. */
  spotlight?: Spotlight;
  /** Alumnos por `clientId`, en orden de llegada. */
  students: Map<string, Student>;
};

export type Spotlight = { studentId: string; showName: boolean };

// ---------- Payloads ----------

export type StudentJoinPayload = { code: string; name: string; clientId: string };

/**
 * Respuesta por *ack* de Socket.IO a los eventos que el cliente necesita confirmar.
 */
export type AckResult = { ok: true } | { ok: false; error: string };

export type StudentJoinResult = AckResult;

/**
 * Estado completo tras unirse o reconectar. Extensiones al payload de SPEC.md:
 * - `sessionId`: para construir las URLs inmutables de las diapositivas (`slideUrl`).
 * - `serverNow`: reloj del servidor, para calcular el tiempo restante de la pregunta
 *   aunque el reloj del celular no coincida con el de la laptop.
 */
export type StateSyncPayload = {
  sessionId: string;
  classId: string;
  slideIndex: number;
  slideCount: number;
  serverNow: number;
  question?: Question;
  myAnswer?: Answer;
};

export type SlideGotoPayload = { index: number };

export type QuestionOpenPayload = {
  id: string;
  type: QuestionType;
  slideIndex?: number;
  timeLimitSec?: number;
  prompt?: string;
  preparedId?: string;
};

export type QuestionClosePayload = { id: string };

export type StrokeAddPayload = { questionId: string; stroke: Stroke };

export type QuestionRefPayload = { questionId: string };

/** Borrador de trazo completo: elimina un trazo por id (extensión a SPEC.md). */
export type StrokeRemovePayload = { questionId: string; strokeId: string };

export type AnswerSubmitPayload = { questionId: string; text?: string };

export type AnswerStatusPayload = { connected: number; submitted: number };

/** `studentId: null` quita la respuesta en grande (extensión a SPEC.md). */
export type AnswerSpotlightPayload = { studentId: string | null; showName: boolean };

/** Eventos de un alumno reenviados al profesor: llevan el id público del alumno. */
export type FromStudent<T> = T & { studentId: string };

export type StudentSummary = { id: string; name: string; connected: boolean };

/** Lista completa de alumnos, en orden de llegada. Se reenvía entera cuando alguien entra o sale. */
export type RosterSyncPayload = { students: StudentSummary[] };

/**
 * Foto completa de las respuestas a la pregunta actual o a la última cerrada (para revisarla),
 * por id público de alumno. Se envía al conectar el profesor.
 */
export type AnswersSyncPayload = { question: Question; answers: Record<string, Answer> };

export type AnswerSubmittedPayload = { studentId: string; questionId: string; text?: string; submittedAt: number };

/** Aviso de fin de clase a las ventanas del profesor: con esto abren el resumen. */
export type SessionEndPayload = { classId: string; sessionId: string };

// ---------- Namespace /student ----------

export interface StudentToServerEvents {
  'student:join': (payload: StudentJoinPayload, ack: (result: StudentJoinResult) => void) => void;
  'stroke:add': (payload: StrokeAddPayload) => void;
  'stroke:undo': (payload: QuestionRefPayload) => void;
  'stroke:remove': (payload: StrokeRemovePayload) => void;
  'board:clear': (payload: QuestionRefPayload) => void;
  'answer:submit': (payload: AnswerSubmitPayload, ack: (result: AckResult) => void) => void;
}

export interface ServerToStudentEvents {
  'state:sync': (payload: StateSyncPayload) => void;
  'slide:goto': (payload: SlideGotoPayload) => void;
  'question:open': (payload: QuestionOpenPayload) => void;
  'question:close': (payload: QuestionClosePayload) => void;
  'session:end': () => void;
}

// ---------- Namespace /teacher ----------

/** Datos del handshake (`auth`) con los que el profesor entra a la sala de su sesión. */
export type TeacherAuth = { sessionId: string };

export interface TeacherToServerEvents {
  'slide:goto': (payload: SlideGotoPayload) => void;
  'question:open': (payload: QuestionOpenPayload) => void;
  'question:close': (payload: QuestionClosePayload) => void;
  'answer:spotlight': (payload: AnswerSpotlightPayload) => void;
  /** Termina la clase: cierra la pregunta abierta, guarda todo en disco y despide a los alumnos. */
  'session:end': (ack: (result: AckResult) => void) => void;
}

export interface ServerToTeacherEvents {
  'state:sync': (payload: StateSyncPayload) => void;
  'slide:goto': (payload: SlideGotoPayload) => void;
  'answer:status': (payload: AnswerStatusPayload) => void;
  // El profesor también recibe apertura y cierre: el servidor cierra solo al vencer el tiempo.
  'question:open': (payload: QuestionOpenPayload) => void;
  'question:close': (payload: QuestionClosePayload) => void;
  // Cuadrícula en vivo: lista de alumnos, foto inicial y relevo de cada cambio.
  'roster:sync': (payload: RosterSyncPayload) => void;
  'answers:sync': (payload: AnswersSyncPayload) => void;
  'stroke:add': (payload: FromStudent<StrokeAddPayload>) => void;
  'stroke:undo': (payload: FromStudent<QuestionRefPayload>) => void;
  'stroke:remove': (payload: FromStudent<StrokeRemovePayload>) => void;
  'board:clear': (payload: FromStudent<QuestionRefPayload>) => void;
  'answer:submitted': (payload: AnswerSubmittedPayload) => void;
  // Todas las ventanas del profesor (laptop y proyección) muestran la misma respuesta en grande.
  'answer:spotlight': (payload: AnswerSpotlightPayload) => void;
  'session:end': (payload: SessionEndPayload) => void;
}

// ---------- API HTTP ----------

/** Respuesta de `POST /api/sessions` y `GET /api/sessions/:id`. */
export type SessionInfo = {
  sessionId: string;
  classId: string;
  code: string;
  slideCount: number;
  slideIndex: number;
  /** URL principal para unirse (IP local preferida). */
  joinUrl: string;
  /** Otras URLs posibles, por si la laptop tiene varias interfaces de red. */
  altJoinUrls: string[];
  /** QR de `joinUrl` en SVG. */
  qrSvg: string;
};

export type ApiError = { error: string; code?: string };

// ---------- Clases preparadas e historial ----------

/** Pregunta preparada de antemano para una diapositiva de la clase. */
export type PreparedQuestion = {
  id: string;
  slideIndex: number;
  type: QuestionType;
  timeLimitSec?: number;
  prompt?: string;
};

/** Clase guardada en data/classes/<id>/class.json. */
export type ClassInfo = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  slideCount: number;
  questions: PreparedQuestion[];
};

/** Cuerpo de `PUT /api/classes/:id`: el documento completo editable. */
export type ClassUpdate = { title: string; questions: PreparedQuestion[] };

export type ClassListItem = Omit<ClassInfo, 'questions'> & {
  questionCount: number;
  sessionCount: number;
  lastSessionAt?: number;
  /** Sesión en curso de esta clase, si la hay. */
  liveSessionId?: string;
};

/** `interrupted`: quedó en disco sin terminar (el servidor se apagó sin "Terminar clase"). */
export type SessionStatus = 'live' | 'ended' | 'interrupted';

export type SessionListItem = {
  id: string;
  startedAt: number;
  endedAt?: number;
  status: SessionStatus;
  studentCount: number;
  questionCount: number;
};

/** Sesión guardada en data/classes/<classId>/sessions/<id>/session.json (sin trazos ni clientId). */
export type SessionRecord = {
  id: string;
  classId: string;
  startedAt: number;
  endedAt?: number;
  students: { id: string; name: string }[];
  questions: Question[];
};

export type QuestionStats = { question: Question; submitted: number; answered: number };

/** `GET /api/classes/:cid/sessions/:sid`: todo lo necesario para el resumen de la clase. */
export type SessionSummary = {
  id: string;
  classId: string;
  classTitle: string;
  slideCount: number;
  startedAt: number;
  endedAt?: number;
  status: SessionStatus;
  students: StudentSummary[];
  questions: QuestionStats[];
};

/** `GET /api/classes/:cid/sessions/:sid/questions/:qid`: respuestas de una pregunta, por id público. */
export type QuestionAnswers = { question: Question; roster: StudentSummary[]; answers: Record<string, Answer> };

// ---------- PIN del profesor ----------

/** `GET /api/pin/status`. `local`: la petición viene de la propia laptop (nunca necesita PIN). */
export type PinStatus = { configured: boolean; local: boolean; authorized: boolean };

/** Códigos de error (en `ApiError.code` y en el `connect_error` del socket del profesor). */
export type PinErrorCode = 'PIN_REQUIRED' | 'PIN_NOT_SET';

// ---------- App: versión, actualizaciones y conexión de alumnos ----------

/** Versión nueva publicada por el servidor de versiones (solo si es mayor que la instalada y su enlace es https). */
export type UpdateInfo = { version: string; url: string; notes?: string };

/** `GET /api/app/info` (solo profesor): versión instalada y, si hay, la versión nueva. */
export type AppInfo = { version: string; update?: UpdateInfo };

/** `GET /api/app/connect` (solo profesor): dirección para que los alumnos entren y su QR en SVG. */
export type ConnectInfo = { urls: string[]; qrSvg: string };
