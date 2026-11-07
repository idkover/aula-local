// PIN del profesor (Fase 4).
// La propia laptop (loopback o su propia IP LAN) nunca necesita PIN; cualquier otro dispositivo sí, para
// las páginas /teacher*, las APIs del profesor y el namespace /teacher.
//
// - El PIN (4–8 dígitos) se guarda con scrypt en data/config.json junto con un secreto para firmar tokens.
// - Un dispositivo remoto que acierta el PIN recibe la cookie `aula_t` (HMAC-SHA256, HttpOnly, 30 días).
//   El secreto vive en disco: la cookie sobrevive a reinicios del servidor. Cambiar el PIN sube `pinEpoch`
//   y con eso caducan todas las cookies emitidas.
// - Los intentos fallidos se limitan por IP (5 fallos → 30 s, el bloqueo se duplica hasta 5 min).
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import type { ApiError, PinErrorCode, PinStatus } from '../shared/types.js';
import { readJson, writeJsonAtomic } from './files.js';

export type PeerAddress = { remoteAddress?: string | undefined; localAddress?: string | undefined };

export type AuthOptions = {
  /** Decide si una conexión viene de la propia laptop. Inyectable para las pruebas. */
  isLocal?: (peer: PeerAddress) => boolean;
  /** Reloj en milisegundos. Inyectable para probar caducidad de tokens y bloqueos. */
  now?: () => number;
};

export type Auth = {
  /** Guarda de páginas del profesor: sin autorización redirige a /teacher/pin?next=. */
  page: RequestHandler;
  /** Guarda de APIs del profesor: 401 PIN_REQUIRED / 403 PIN_NOT_SET. */
  api: RequestHandler;
  /** Guarda del namespace /teacher (Socket.IO): rechaza con Error('PIN_REQUIRED' | 'PIN_NOT_SET'). */
  socket: (request: IncomingMessage, next: (err?: Error) => void) => void;
  /** Rutas /api/pin/status, /api/pin/login y /api/pin/set. */
  router: Router;
  /** ¿La petición viene de la propia laptop? (la laptop nunca necesita PIN para el profesor). */
  isLocalRequest: (req: Request) => boolean;
};

/** La laptop habla con su propio servidor: loopback, o su propia IP LAN (remoto == local). */
export function isLocalPeer({ remoteAddress, localAddress }: PeerAddress): boolean {
  if (!remoteAddress) return false;
  const remote = remoteAddress.replace(/^::ffff:/, '');
  if (remote === '::1' || remote.startsWith('127.')) return true;
  return localAddress !== undefined && remote === localAddress.replace(/^::ffff:/, '');
}

// ---------- PIN: hash ----------

export const PIN_RE = /^\d{4,8}$/;
const SCRYPT_KEYLEN = 32;
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export type StoredPin = { salt: string; hash: string };

export async function hashPin(pin: string): Promise<StoredPin> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pin, salt, SCRYPT_KEYLEN);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export async function verifyPin(pin: string, stored: StoredPin): Promise<boolean> {
  const expected = Buffer.from(stored.hash, 'hex');
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const actual = await scryptAsync(pin, Buffer.from(stored.salt, 'hex'), SCRYPT_KEYLEN);
  return timingSafeEqual(actual, expected);
}

// ---------- Token de dispositivo autorizado ----------

export const COOKIE_NAME = 'aula_t';
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function tokenSignature(secret: string, body: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(body).digest();
}

/** Token `epoch.expira.firma`; la firma cubre época y caducidad. */
export function signToken(secret: string, epoch: number, expiresAt: number): string {
  const body = `${epoch}.${expiresAt}`;
  return `${body}.${tokenSignature(secret, body).toString('base64url')}`;
}

/** Válido si la firma coincide, no ha caducado y su época es la vigente del PIN. */
export function verifyToken(secret: string, token: string | undefined, epoch: number, now: number): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [tokenEpoch, expiresAt, signature] = parts as [string, string, string];
  if (!/^\d{1,15}$/.test(tokenEpoch) || !/^\d{1,16}$/.test(expiresAt)) return false;
  const given = Buffer.from(signature, 'base64url');
  const expected = tokenSignature(secret, `${tokenEpoch}.${expiresAt}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  return Number(tokenEpoch) === epoch && Number(expiresAt) > now;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (cookies.has(name)) continue; // gana la primera, como hacen los navegadores con la ruta más específica
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      cookies.set(name, value);
    }
  }
  return cookies;
}

// ---------- Límite de intentos fallidos ----------

export const MAX_FAILS = 5;
export const BLOCK_BASE_MS = 30_000;
export const BLOCK_MAX_MS = 5 * 60_000;
/** Sin actividad por este tiempo, el historial de fallos de una IP se olvida. */
const FORGET_AFTER_MS = 60 * 60_000;

type Attempts = { fails: number; level: number; blockedUntil: number; last: number };

export class AttemptLimiter {
  private readonly entries = new Map<string, Attempts>();

  constructor(private readonly now: () => number) {}

  /** Milisegundos que faltan para que `key` pueda volver a intentar (0 si no está bloqueada). */
  retryAfterMs(key: string): number {
    const entry = this.entries.get(key);
    return entry ? Math.max(0, entry.blockedUntil - this.now()) : 0;
  }

  /** Registra un fallo; devuelve el bloqueo resultante en ms (0 si todavía puede intentar). */
  fail(key: string): number {
    const now = this.now();
    this.prune(now);
    let entry = this.entries.get(key);
    if (!entry || now - entry.last > FORGET_AFTER_MS) {
      entry = { fails: 0, level: 0, blockedUntil: 0, last: now };
      this.entries.set(key, entry);
    }
    entry.last = now;
    if (entry.blockedUntil > now) return entry.blockedUntil - now;
    entry.fails += 1;
    if (entry.fails < MAX_FAILS) return 0;
    const block = Math.min(BLOCK_BASE_MS * 2 ** entry.level, BLOCK_MAX_MS);
    entry.level += 1;
    entry.fails = 0;
    entry.blockedUntil = now + block;
    return block;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    if (this.entries.size < 500) return;
    for (const [key, entry] of this.entries) {
      if (now - entry.last > FORGET_AFTER_MS) this.entries.delete(key);
    }
  }
}

function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;
}

// ---------- Configuración en disco ----------

type Config = { version: 1; tokenSecret: string; pinEpoch: number; pin?: StoredPin };

function isHex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-f]+$/i.test(value);
}

async function loadConfig(file: string): Promise<Config> {
  const raw = await readJson<Partial<Config>>(file);
  const config: Config = {
    version: 1,
    tokenSecret: isHex(raw?.tokenSecret, 32) ? raw.tokenSecret : randomBytes(32).toString('hex'),
    pinEpoch: typeof raw?.pinEpoch === 'number' && Number.isSafeInteger(raw.pinEpoch) && raw.pinEpoch >= 0 ? raw.pinEpoch : 0,
  };
  const pin = raw?.pin;
  if (pin && isHex(pin.salt, 16) && isHex(pin.hash, SCRYPT_KEYLEN)) config.pin = { salt: pin.salt, hash: pin.hash };
  if (!raw || raw.tokenSecret !== config.tokenSecret) await writeJsonAtomic(file, config);
  return config;
}

// ---------- Express / Socket.IO ----------

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const NOT_SET_MESSAGE = 'Configura el PIN en la laptop.';
const REQUIRED_MESSAGE = 'Ingresa el PIN del profesor.';

function sendError(res: Response, status: number, error: string, code?: string, extra?: Record<string, unknown>): void {
  const body: ApiError = code ? { error, code } : { error };
  res.status(status).json({ ...body, ...extra });
}

/** `next` solo puede ser una ruta del profesor del mismo origen (evita redirecciones abiertas). */
export function safeNext(next: unknown): string | undefined {
  if (typeof next !== 'string') return undefined;
  if (!/^\/teacher(?:[/?#]|$)/.test(next) || /[\\\u0000-\u001f]/.test(next)) return undefined;
  return next;
}

export async function createAuth(dataDir: string, options: AuthOptions = {}): Promise<Auth> {
  const isLocal = options.isLocal ?? isLocalPeer;
  const now = options.now ?? Date.now;
  const configFile = path.join(dataDir, 'config.json');
  let config = await loadConfig(configFile);
  const limiter = new AttemptLimiter(now);

  /** Serializa los cambios de PIN para que dos peticiones simultáneas no pisen la época. */
  let changing: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = changing.then(work, work);
    changing = run.catch(() => undefined);
    return run;
  };

  const peerOf = (socket: { remoteAddress?: string | undefined; localAddress?: string | undefined }): PeerAddress => ({
    remoteAddress: socket.remoteAddress,
    localAddress: socket.localAddress,
  });

  const hasValidCookie = (cookieHeader: string | undefined): boolean =>
    verifyToken(config.tokenSecret, parseCookies(cookieHeader).get(COOKIE_NAME), config.pinEpoch, now());

  /** Misma decisión para páginas, APIs y sockets. */
  const verdict = (peer: PeerAddress, cookieHeader: string | undefined): 'ok' | PinErrorCode => {
    if (isLocal(peer)) return 'ok';
    if (!config.pin) return 'PIN_NOT_SET';
    return hasValidCookie(cookieHeader) ? 'ok' : 'PIN_REQUIRED';
  };

  const verdictOf = (req: Request) => verdict(peerOf(req.socket), req.headers.cookie);

  const setDeviceCookie = (res: Response): void => {
    res.cookie(COOKIE_NAME, signToken(config.tokenSecret, config.pinEpoch, now() + TOKEN_TTL_MS), {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: TOKEN_TTL_MS,
    });
  };

  /** Mitiga CSRF y DNS rebinding: una petición que cambia datos y trae Origin debe venir de esta misma página. */
  const sameOrigin: RequestHandler = (req, res, next) => {
    const origin = req.headers.origin;
    if (!MUTATING.has(req.method) || origin === undefined) return void next();
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      originHost = undefined;
    }
    if (originHost === undefined || originHost !== (req.headers.host ?? '').toLowerCase()) {
      sendError(res, 403, 'Origen no permitido.', 'ORIGIN_MISMATCH');
      return;
    }
    next();
  };

  const page: RequestHandler = (req, res, next) => {
    if (verdictOf(req) === 'ok') return void next();
    const target = safeNext(req.originalUrl);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, target ? `/teacher/pin?next=${encodeURIComponent(target)}` : '/teacher/pin');
  };

  const guardApi: RequestHandler = (req, res, next) => {
    const result = verdictOf(req);
    if (result === 'ok') return void next();
    res.setHeader('Cache-Control', 'no-store');
    if (result === 'PIN_NOT_SET') sendError(res, 403, NOT_SET_MESSAGE, 'PIN_NOT_SET');
    else sendError(res, 401, REQUIRED_MESSAGE, 'PIN_REQUIRED');
  };

  const api: RequestHandler = (req, res, next) => sameOrigin(req, res, (err?: unknown) => (err ? next(err) : guardApi(req, res, next)));

  const socket: Auth['socket'] = (request, next) => {
    const result = verdict(peerOf(request.socket), request.headers.cookie);
    next(result === 'ok' ? undefined : new Error(result));
  };

  // ----- /api/pin/* -----

  const router = Router();
  router.use('/api/pin', sameOrigin);
  const json = express.json({ limit: '1kb' });

  const ipOf = (req: Request): string => (req.socket.remoteAddress ?? 'desconocida').replace(/^::ffff:/, '');
  const pinOf = (req: Request, field: string): string | undefined => {
    const value: unknown = (req.body as Record<string, unknown> | undefined)?.[field];
    return typeof value === 'string' ? value.trim() : undefined;
  };

  /** Responde 429 si la IP está bloqueada. Devuelve true cuando ya respondió. */
  const rejectIfBlocked = (req: Request, res: Response): boolean => {
    const wait = limiter.retryAfterMs(ipOf(req));
    if (wait === 0) return false;
    res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
    sendError(res, 429, `Demasiados intentos. Vuelve a intentarlo en ${formatWait(wait)}.`, 'PIN_LOCKED', {
      retryAfterSec: Math.ceil(wait / 1000),
    });
    return true;
  };

  /** Comprueba un PIN ajeno contra el guardado; cuenta los fallos. Devuelve true si es correcto. */
  const checkRemotePin = async (req: Request, res: Response, pin: string | undefined): Promise<boolean> => {
    if (!config.pin) {
      sendError(res, 403, NOT_SET_MESSAGE, 'PIN_NOT_SET');
      return false;
    }
    if (rejectIfBlocked(req, res)) return false;
    if (pin !== undefined && PIN_RE.test(pin) && (await verifyPin(pin, config.pin))) {
      limiter.reset(ipOf(req));
      return true;
    }
    const wait = limiter.fail(ipOf(req));
    const message = wait > 0 ? `PIN incorrecto. Demasiados intentos: espera ${formatWait(wait)}.` : 'PIN incorrecto.';
    sendError(res, 401, message, 'PIN_WRONG', wait > 0 ? { retryAfterSec: Math.ceil(wait / 1000) } : undefined);
    return false;
  };

  router.get('/api/pin/status', (req, res: Response<PinStatus>) => {
    const local = isLocal(peerOf(req.socket));
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      configured: config.pin !== undefined,
      local,
      authorized: local || (config.pin !== undefined && hasValidCookie(req.headers.cookie)),
    });
  });

  router.post('/api/pin/login', json, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (isLocal(peerOf(req.socket))) {
      res.json({ ok: true }); // La laptop no necesita PIN.
      return;
    }
    if (!(await checkRemotePin(req, res, pinOf(req, 'pin')))) return;
    setDeviceCookie(res);
    res.json({ ok: true });
  });

  router.post('/api/pin/set', json, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const local = isLocal(peerOf(req.socket));
    const pin = pinOf(req, 'pin');
    if (pin === undefined || !PIN_RE.test(pin)) {
      sendError(res, 400, 'El PIN debe tener de 4 a 8 dígitos.', 'PIN_INVALID');
      return;
    }
    // Desde otro dispositivo solo se puede cambiar un PIN que ya existe, y con el PIN actual.
    if (!local && !(await checkRemotePin(req, res, pinOf(req, 'current')))) return;
    const stored = await hashPin(pin);
    await exclusive(async () => {
      const next: Config = { ...config, pinEpoch: config.pinEpoch + 1, pin: stored };
      await writeJsonAtomic(configFile, next);
      config = next;
    });
    if (!local) setDeviceCookie(res); // Quien lo cambió sigue autorizado con la época nueva.
    res.json({ ok: true });
  });

  const isLocalRequest = (req: Request): boolean => isLocal(peerOf(req.socket));

  return { page, api, socket, router, isLocalRequest };
}
