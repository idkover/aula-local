// Cliente tipado de la API REST (biblioteca de clases, historial y sesiones).
import type {
  AppInfo,
  ClassInfo,
  ClassListItem,
  ClassUpdate,
  ConnectInfo,
  PinStatus,
  QuestionAnswers,
  SessionInfo,
  SessionListItem,
  SessionSummary,
} from '../../shared/types.js';

/** Error de la API con el mensaje del servidor (en español, listo para mostrar). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Código del servidor (p. ej. PIN_WRONG, PIN_LOCKED) cuando lo hay. */
    readonly code?: string,
    /** Segundos de espera cuando el servidor bloqueó los intentos (429). */
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

/** Lleva a la página del PIN, que devuelve al profesor a la ruta actual tras ingresarlo. */
export function goToPin(): void {
  location.href = `/teacher/pin?next=${encodeURIComponent(location.pathname + location.search)}`;
}

async function request<T>(method: string, url: string, body?: BodyInit, contentType?: string): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = body;
  if (contentType) init.headers = { 'Content-Type': contentType };
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'No hay conexión con el servidor.');
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined; // Respuesta que no es JSON (p. ej. un proxy): se informa solo el código.
  }
  if (!res.ok) {
    const body = data as { error?: string; code?: string; retryAfterSec?: number } | undefined;
    const code = body?.code;
    // Dispositivo sin autorización: se va a pedir el PIN y se regresa a esta misma página.
    if ((res.status === 401 && code === 'PIN_REQUIRED') || (res.status === 403 && code === 'PIN_NOT_SET')) {
      goToPin();
      await new Promise<never>(() => {}); // la página se está cerrando
    }
    throw new ApiError(res.status, body?.error ?? `Error ${res.status}`, code, body?.retryAfterSec);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  listClasses: () => request<ClassListItem[]>('GET', '/api/classes'),
  /** Sube el PDF y crea la clase; la conversión puede tardar unos segundos por página. */
  createClass: (pdf: Blob, title: string) =>
    request<ClassInfo>('POST', `/api/classes?title=${enc(title)}`, pdf, 'application/pdf'),
  getClass: (classId: string) => request<ClassInfo>('GET', `/api/classes/${enc(classId)}`),
  updateClass: (classId: string, update: ClassUpdate) =>
    request<ClassInfo>('PUT', `/api/classes/${enc(classId)}`, JSON.stringify(update), 'application/json'),
  deleteClass: (classId: string) => request<void>('DELETE', `/api/classes/${enc(classId)}`),
  /** Empieza (o retoma, si ya está en curso) la sesión en vivo de la clase. */
  startClass: (classId: string) => request<SessionInfo>('POST', `/api/classes/${enc(classId)}/sessions`),
  listSessions: (classId: string) => request<SessionListItem[]>('GET', `/api/classes/${enc(classId)}/sessions`),
  sessionSummary: (classId: string, sessionId: string) =>
    request<SessionSummary>('GET', `/api/classes/${enc(classId)}/sessions/${enc(sessionId)}`),
  questionAnswers: (classId: string, sessionId: string, questionId: string) =>
    request<QuestionAnswers>(
      'GET',
      `/api/classes/${enc(classId)}/sessions/${enc(sessionId)}/questions/${enc(questionId)}`,
    ),
  /** Clase rápida: sube el PDF y empieza la sesión de inmediato (sin título ni preguntas preparadas). */
  quickSession: (pdf: Blob) => request<SessionInfo>('POST', '/api/sessions', pdf, 'application/pdf'),
  sessionInfo: (sessionId: string) => request<SessionInfo>('GET', `/api/sessions/${enc(sessionId)}`),
  /** PIN del profesor: si está configurado, si esta conexión es la laptop y si ya está autorizada. */
  pinStatus: () => request<PinStatus>('GET', '/api/pin/status'),
  /** Desde otro dispositivo: valida el PIN y recibe la cookie de autorización. */
  pinLogin: (pin: string) => request<{ ok: true }>('POST', '/api/pin/login', JSON.stringify({ pin }), 'application/json'),
  /** Crea o cambia el PIN. Desde la laptop no hace falta `current`; desde otro dispositivo sí. */
  pinSet: (pin: string, current?: string) =>
    request<{ ok: true }>(
      'POST',
      '/api/pin/set',
      JSON.stringify(current === undefined ? { pin } : { pin, current }),
      'application/json',
    ),
  /** Versión instalada y, si hay, la versión nueva disponible. */
  appInfo: () => request<AppInfo>('GET', '/api/app/info'),
  /** Dirección que escriben los alumnos (sin código de clase) y su QR en SVG. */
  appConnect: () => request<ConnectInfo>('GET', '/api/app/connect'),
};

/** Fecha y hora legibles en español (p. ej. "30 oct 2026, 10:42"). */
export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Clave de localStorage con la sesión en vivo del profesor (la comparten todas sus páginas). */
export const TEACHER_SESSION_KEY = 'aula.teacher.sessionId';
