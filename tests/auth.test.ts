// PIN del profesor: unidades (local/remoto, hash, token, límite de intentos) e integración con el servidor real.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AttemptLimiter,
  BLOCK_BASE_MS,
  BLOCK_MAX_MS,
  hashPin,
  isLocalPeer,
  MAX_FAILS,
  parseCookies,
  safeNext,
  signToken,
  TOKEN_TTL_MS,
  verifyPin,
  verifyToken,
} from '../server/auth.js';
import { createAulaServer, type AulaServer } from '../server/index.js';
import type { PinStatus, SessionInfo } from '../shared/types.js';
import { makePdf } from './helpers.js';

// ---------- Unidades ----------

describe('isLocalPeer', () => {
  it('reconoce loopback IPv4, IPv6 y IPv4 mapeada', () => {
    expect(isLocalPeer({ remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' })).toBe(true);
    expect(isLocalPeer({ remoteAddress: '127.5.6.7' })).toBe(true);
    expect(isLocalPeer({ remoteAddress: '::1' })).toBe(true);
    expect(isLocalPeer({ remoteAddress: '::ffff:127.0.0.1' })).toBe(true);
  });

  it('un equipo de la red es remoto', () => {
    expect(isLocalPeer({ remoteAddress: '192.168.1.50', localAddress: '192.168.1.10' })).toBe(false);
    expect(isLocalPeer({ remoteAddress: '::ffff:192.168.1.50', localAddress: '::ffff:192.168.1.10' })).toBe(false);
    expect(isLocalPeer({ remoteAddress: '192.168.1.50' })).toBe(false);
    expect(isLocalPeer({})).toBe(false);
  });

  it('la laptop entrando por su propia IP de red también es local', () => {
    expect(isLocalPeer({ remoteAddress: '192.168.1.10', localAddress: '192.168.1.10' })).toBe(true);
    expect(isLocalPeer({ remoteAddress: '::ffff:192.168.1.10', localAddress: '192.168.1.10' })).toBe(true);
    expect(isLocalPeer({ remoteAddress: '192.168.1.10', localAddress: '::ffff:192.168.1.10' })).toBe(true);
  });
});

describe('hash del PIN', () => {
  it('verifica el PIN correcto y rechaza otros; no guarda el PIN en claro', async () => {
    const stored = await hashPin('4821');
    expect(JSON.stringify(stored)).not.toContain('4821');
    expect(await verifyPin('4821', stored)).toBe(true);
    expect(await verifyPin('4822', stored)).toBe(false);
    expect(await verifyPin('', stored)).toBe(false);
  });

  it('usa sal distinta cada vez', async () => {
    const a = await hashPin('1234');
    const b = await hashPin('1234');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('un hash dañado no valida', async () => {
    expect(await verifyPin('1234', { salt: 'zz', hash: 'abc' })).toBe(false);
  });
});

describe('token de dispositivo', () => {
  const secret = 'ab'.repeat(32);
  const now = 1_000_000;

  it('firma y verifica', () => {
    const token = signToken(secret, 3, now + TOKEN_TTL_MS);
    expect(verifyToken(secret, token, 3, now)).toBe(true);
  });

  it('rechaza otro secreto, manipulación y basura', () => {
    const token = signToken(secret, 3, now + 5000);
    expect(verifyToken('cd'.repeat(32), token, 3, now)).toBe(false);
    const [epoch, expires, sig] = token.split('.') as [string, string, string];
    expect(verifyToken(secret, `${epoch}.${Number(expires) + 1}.${sig}`, 3, now)).toBe(false); // alarga la caducidad
    expect(verifyToken(secret, `4.${expires}.${sig}`, 4, now)).toBe(false); // cambia la época
    expect(verifyToken(secret, `${epoch}.${expires}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`, 3, now)).toBe(false);
    expect(verifyToken(secret, `${epoch}.${expires}`, 3, now)).toBe(false);
    for (const junk of [undefined, '', 'x', 'a.b.c', '1.2.3.4', '..']) expect(verifyToken(secret, junk, 3, now)).toBe(false);
  });

  it('caduca', () => {
    const token = signToken(secret, 0, now + 1000);
    expect(verifyToken(secret, token, 0, now + 999)).toBe(true);
    expect(verifyToken(secret, token, 0, now + 1000)).toBe(false);
    expect(verifyToken(secret, token, 0, now + 5000)).toBe(false);
  });

  it('subir la época invalida los tokens anteriores', () => {
    const token = signToken(secret, 1, now + 5000);
    expect(verifyToken(secret, token, 1, now)).toBe(true);
    expect(verifyToken(secret, token, 2, now)).toBe(false);
  });
});

describe('cookies y next', () => {
  it('lee el encabezado Cookie', () => {
    const cookies = parseCookies('a=1; aula_t=x.y.z; b=%C3%A1; ; =vacio; c="q"');
    expect(cookies.get('a')).toBe('1');
    expect(cookies.get('aula_t')).toBe('x.y.z');
    expect(cookies.get('b')).toBe('á');
    expect(cookies.get('c')).toBe('q');
    expect(parseCookies(undefined).size).toBe(0);
  });

  it('safeNext acepta solo rutas /teacher del mismo origen', () => {
    expect(safeNext('/teacher')).toBe('/teacher');
    expect(safeNext('/teacher/clases?preparar=abc')).toBe('/teacher/clases?preparar=abc');
    for (const bad of ['//evil.example/teacher', 'https://evil.example', '/teacherx', '/other', '/teacher\\..\\x', '/teacher/\n', undefined, 3]) {
      expect(safeNext(bad)).toBeUndefined();
    }
  });
});

describe('límite de intentos', () => {
  it('bloquea 30 s tras 5 fallos, duplica hasta 5 min y un acierto lo reinicia', () => {
    let t = 10_000;
    const limiter = new AttemptLimiter(() => t);
    const ip = '192.168.1.50';

    for (let i = 1; i < MAX_FAILS; i++) expect(limiter.fail(ip)).toBe(0);
    expect(limiter.retryAfterMs(ip)).toBe(0);
    expect(limiter.fail(ip)).toBe(BLOCK_BASE_MS); // el quinto fallo bloquea
    expect(limiter.retryAfterMs(ip)).toBe(BLOCK_BASE_MS);
    expect(limiter.retryAfterMs('192.168.1.51')).toBe(0); // por IP

    t += 10_000;
    expect(limiter.retryAfterMs(ip)).toBe(BLOCK_BASE_MS - 10_000);
    t += BLOCK_BASE_MS - 10_000;
    expect(limiter.retryAfterMs(ip)).toBe(0);

    // Segunda tanda: el bloqueo se duplica.
    for (let i = 1; i < MAX_FAILS; i++) limiter.fail(ip);
    expect(limiter.fail(ip)).toBe(BLOCK_BASE_MS * 2);
    t += BLOCK_BASE_MS * 2;
    for (let i = 1; i < MAX_FAILS; i++) limiter.fail(ip);
    expect(limiter.fail(ip)).toBe(BLOCK_BASE_MS * 4);

    // Tope de 5 minutos.
    let last = 0;
    for (let round = 0; round < 6; round++) {
      t += BLOCK_MAX_MS;
      for (let i = 0; i < MAX_FAILS; i++) last = limiter.fail(ip);
    }
    expect(last).toBe(BLOCK_MAX_MS);

    t += BLOCK_MAX_MS;
    limiter.reset(ip);
    for (let i = 1; i < MAX_FAILS; i++) limiter.fail(ip);
    expect(limiter.fail(ip)).toBe(BLOCK_BASE_MS); // vuelve al bloqueo inicial
  });

  it('durante un bloqueo los intentos no suman ni lo alargan', () => {
    let t = 0;
    const limiter = new AttemptLimiter(() => t);
    for (let i = 0; i < MAX_FAILS; i++) limiter.fail('x');
    t += 1000;
    expect(limiter.fail('x')).toBe(BLOCK_BASE_MS - 1000);
    expect(limiter.retryAfterMs('x')).toBe(BLOCK_BASE_MS - 1000);
  });

  it('olvida las IP tranquilas tras una hora', () => {
    let t = 0;
    const limiter = new AttemptLimiter(() => t);
    for (let i = 0; i < MAX_FAILS; i++) limiter.fail('x'); // nivel 1
    t += 2 * 60 * 60_000;
    for (let i = 1; i < MAX_FAILS; i++) limiter.fail('x');
    expect(limiter.fail('x')).toBe(BLOCK_BASE_MS); // no 60 s
  });
});

// ---------- Integración ----------

const PIN = '4821';
const NEW_PIN = '90210';

describe('PIN del profesor (servidor real)', () => {
  let tmp = '';
  let dataDir = '';
  let clientDir = '';
  let server: AulaServer;
  let base = '';
  let local = true;
  let sessionId = '';
  const sockets: Socket[] = [];

  async function boot(): Promise<void> {
    server = await createAulaServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      clientDir,
      isLocal: () => local,
      updateCheck: { enabled: false },
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function stopServer(): Promise<void> {
    for (const s of sockets.splice(0)) s.disconnect();
    await server.close();
  }

  type Reply<T = unknown> = { status: number; body: T; headers: Headers };

  async function call<T = unknown>(
    method: string,
    url: string,
    opts: { json?: unknown; cookie?: string; origin?: string; pdf?: Buffer } = {},
  ): Promise<Reply<T>> {
    const headers: Record<string, string> = {};
    const init: RequestInit = { method, headers, redirect: 'manual' };
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    if (opts.origin) headers['Origin'] = opts.origin;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.json);
    }
    if (opts.pdf) {
      headers['Content-Type'] = 'application/pdf';
      init.body = new Uint8Array(opts.pdf);
    }
    const res = await fetch(`${base}${url}`, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      /* HTML o texto plano */
    }
    return { status: res.status, body: body as T, headers: res.headers };
  }

  const login = (pin: string, extra: { origin?: string } = {}) => call('POST', '/api/pin/login', { json: { pin }, ...extra });

  /** "aula_t=..." listo para el encabezado Cookie, a partir de un Set-Cookie. */
  function cookieOf(reply: Reply): string {
    const raw = reply.headers.getSetCookie().find((c) => c.startsWith('aula_t='));
    if (!raw) throw new Error('Sin cookie aula_t');
    return raw.split(';')[0] as string;
  }

  /** Abre el namespace /teacher con la cookie dada; resuelve con 'ok' o con el mensaje de connect_error. */
  function teacherSocket(cookie?: string): Promise<string> {
    return new Promise((resolve) => {
      const socket = io(`${base}/teacher`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        auth: { sessionId },
        ...(cookie ? { extraHeaders: { cookie } } : {}),
      });
      sockets.push(socket);
      socket.on('connect', () => resolve('ok'));
      socket.on('connect_error', (err) => resolve(err.message));
    });
  }

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'aula-auth-'));
    dataDir = path.join(tmp, 'data');
    clientDir = path.join(tmp, 'client');
    for (const [dir, file] of [
      ['student', 'index.html'],
      ['teacher', 'index.html'],
      ['teacher', 'pin.html'],
      ['teacher', 'library.html'],
      ['teacher', 'projector.html'],
      ['teacher', 'summary.html'],
    ] as const) {
      await mkdir(path.join(clientDir, dir), { recursive: true });
      await writeFile(path.join(clientDir, dir, file), `<!doctype html><title>${dir}/${file}</title>`);
    }
    local = true;
    await boot();
    // Una sesión en curso (creada desde la laptop) para probar el socket del profesor.
    const created = await call<SessionInfo>('POST', '/api/sessions', { pdf: makePdf(2) });
    expect(created.status).toBe(201);
    sessionId = created.body.sessionId;
  });

  afterAll(async () => {
    await stopServer();
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('desde otro dispositivo y sin PIN configurado: 403 PIN_NOT_SET en todo lo del profesor', async () => {
    local = false;
    expect((await call<PinStatus>('GET', '/api/pin/status')).body).toEqual({ configured: false, local: false, authorized: false });

    const api = await call<{ error: string; code: string }>('GET', '/api/classes');
    expect(api.status).toBe(403);
    expect(api.body).toEqual({ error: 'Configura el PIN en la laptop.', code: 'PIN_NOT_SET' });
    expect((await call('GET', `/api/sessions/${sessionId}`)).status).toBe(403);

    const page = await call('GET', '/teacher/clases?preparar=abc');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/teacher/pin?next=%2Fteacher%2Fclases%3Fpreparar%3Dabc');

    expect(await teacherSocket()).toBe('PIN_NOT_SET');

    // No se puede crear ni validar un PIN que no existe.
    const set = await call<{ code: string }>('POST', '/api/pin/set', { json: { pin: PIN } });
    expect(set.status).toBe(403);
    expect(set.body.code).toBe('PIN_NOT_SET');
    expect((await login(PIN)).status).toBe(403);
  });

  it('las páginas públicas siguen abiertas', async () => {
    local = false;
    expect((await call('GET', '/')).status).toBe(200);
    expect((await call('GET', '/teacher/pin')).status).toBe(200);
  });

  it('la laptop crea el PIN (4 a 8 dígitos) y nunca lo necesita', async () => {
    local = true;
    for (const bad of ['123', '123456789', 'abcd', '12 34', '']) {
      const res = await call<{ code: string }>('POST', '/api/pin/set', { json: { pin: bad } });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PIN_INVALID');
    }
    expect((await call('POST', '/api/pin/set', { json: { pin: 12 } })).status).toBe(400);

    expect((await call('POST', '/api/pin/set', { json: { pin: PIN } })).status).toBe(200);
    expect((await call<PinStatus>('GET', '/api/pin/status')).body).toEqual({ configured: true, local: true, authorized: true });

    // Con PIN configurado, la laptop sigue entrando sin nada.
    expect((await call('GET', '/api/classes')).status).toBe(200);
    expect((await call('GET', '/teacher/clases')).status).toBe(200);
    expect((await call('GET', '/teacher')).status).toBe(200);
    expect(await teacherSocket()).toBe('ok');
    expect((await login('0000')).status).toBe(200); // login desde la laptop es un no-op
  });

  it('el PIN queda en config.json con hash, sin PIN en claro', async () => {
    const raw = await readFile(path.join(dataDir, 'config.json'), 'utf8');
    const config = JSON.parse(raw) as { version: number; tokenSecret: string; pinEpoch: number; pin: { salt: string; hash: string } };
    expect(config.version).toBe(1);
    expect(config.tokenSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(config.pinEpoch).toBe(1);
    expect(config.pin.salt).toMatch(/^[0-9a-f]+$/);
    expect(config.pin.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(raw).not.toContain(PIN);
  });

  it('desde otro dispositivo con PIN configurado: 401 PIN_REQUIRED, redirección y socket rechazado', async () => {
    local = false;
    expect((await call<PinStatus>('GET', '/api/pin/status')).body).toEqual({ configured: true, local: false, authorized: false });

    const api = await call<{ code: string }>('GET', '/api/classes');
    expect(api.status).toBe(401);
    expect(api.body.code).toBe('PIN_REQUIRED');
    expect((await call('GET', '/api/classes/abc/sessions')).status).toBe(401);
    expect((await call('POST', '/api/classes/abc/sessions')).status).toBe(401);

    for (const route of ['/teacher', '/teacher/proyector', '/teacher/clases', '/teacher/resumen?c=a&s=b']) {
      const page = await call('GET', route);
      expect(page.status).toBe(302);
      expect(page.headers.get('location')).toBe(`/teacher/pin?next=${encodeURIComponent(route)}`);
    }

    expect(await teacherSocket()).toBe('PIN_REQUIRED');
    // Una cookie inventada o manipulada no sirve.
    expect(await teacherSocket('aula_t=1.99999999999999.AAAA')).toBe('PIN_REQUIRED');
    expect((await call('GET', '/api/classes', { cookie: 'aula_t=basura' })).status).toBe(401);
  });

  it('un origen distinto al Host se rechaza en peticiones que cambian datos', async () => {
    local = false;
    const evil = await call<{ code: string }>('POST', '/api/pin/login', { json: { pin: PIN }, origin: 'http://evil.example' });
    expect(evil.status).toBe(403);
    expect(evil.body.code).toBe('ORIGIN_MISMATCH');
    expect((await login(PIN, { origin: 'null' })).status).toBe(403);
    expect((await login(PIN, { origin: `http://127.0.0.1:${server.port + 1}` })).status).toBe(403);
    expect((await call('POST', '/api/pin/set', { json: { pin: '5555', current: PIN }, origin: 'http://evil.example' })).status).toBe(403);
    // También en las APIs protegidas, aunque la laptop no necesite PIN.
    local = true;
    expect((await call('DELETE', '/api/classes/abc', { origin: 'http://evil.example' })).status).toBe(403);
    expect((await call('GET', '/api/classes', { origin: 'http://evil.example' })).status).toBe(200); // lecturas no
    expect((await call('DELETE', '/api/classes/abc', { origin: `http://127.0.0.1:${server.port}` })).status).toBe(404);
    expect((await call('DELETE', '/api/classes/abc')).status).toBe(404); // sin Origin (curl, pruebas)
  });

  let cookie = '';

  it('PIN correcto → cookie firmada y todo el profesor queda abierto', async () => {
    local = false;
    // Algunos fallos antes del acierto no bloquean y el acierto reinicia la cuenta.
    for (let i = 0; i < MAX_FAILS - 1; i++) {
      const wrong = await login('1111');
      expect(wrong.status).toBe(401);
      expect((wrong.body as { code: string }).code).toBe('PIN_WRONG');
    }
    const ok = await login(PIN, { origin: base });
    expect(ok.status).toBe(200);
    const header = ok.headers.getSetCookie().find((c) => c.startsWith('aula_t=')) ?? '';
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Path=/');
    expect(header).toContain(`Max-Age=${TOKEN_TTL_MS / 1000}`);
    cookie = cookieOf(ok);

    expect((await call<PinStatus>('GET', '/api/pin/status', { cookie })).body).toEqual({ configured: true, local: false, authorized: true });
    expect((await call('GET', '/api/classes', { cookie })).status).toBe(200);
    expect((await call('POST', '/api/sessions', { cookie, origin: base, pdf: makePdf(1) })).status).toBe(201);
    for (const route of ['/teacher', '/teacher/proyector', '/teacher/clases', '/teacher/resumen']) {
      expect((await call('GET', route, { cookie })).status).toBe(200);
    }
    expect(await teacherSocket(cookie)).toBe('ok');
    // Y la parte de los alumnos nunca pidió nada.
    expect((await call('GET', '/')).status).toBe(200);
  });

  it('la cookie sobrevive a un reinicio del servidor', async () => {
    await stopServer();
    await boot();
    local = false;
    expect((await call('GET', '/api/classes')).status).toBe(401);
    expect((await call('GET', '/api/classes', { cookie })).status).toBe(200);
    expect((await call('GET', '/teacher/clases', { cookie })).status).toBe(200);
    expect(await teacherSocket(cookie)).toBe('ok'); // la sesión en curso también se retomó
  });

  it('cambiar el PIN desde otro dispositivo exige el actual e invalida las cookies viejas', async () => {
    local = false;
    // Sin PIN actual o con uno equivocado: no.
    expect((await call('POST', '/api/pin/set', { json: { pin: NEW_PIN }, cookie })).status).toBe(401);
    expect((await call('POST', '/api/pin/set', { json: { pin: NEW_PIN, current: '0000' }, cookie })).status).toBe(401);
    expect((await call('GET', '/api/classes', { cookie })).status).toBe(200); // nada cambió
    // Con el actual: sí, y quien lo cambia sigue autorizado con una cookie nueva.
    const changed = await call('POST', '/api/pin/set', { json: { pin: NEW_PIN, current: PIN }, cookie, origin: base });
    expect(changed.status).toBe(200);
    const fresh = cookieOf(changed);

    expect((await call('GET', '/api/classes', { cookie })).status).toBe(401);
    expect(await teacherSocket(cookie)).toBe('PIN_REQUIRED');
    expect((await call('GET', '/api/classes', { cookie: fresh })).status).toBe(200);
    expect(await teacherSocket(fresh)).toBe('ok');
    expect((await login(PIN)).status).toBe(401);
    expect((await login(NEW_PIN)).status).toBe(200);
    cookie = fresh;
  });

  it('la laptop también puede cambiar el PIN sin el actual, y eso invalida a los demás', async () => {
    local = true;
    expect((await call('POST', '/api/pin/set', { json: { pin: PIN } })).status).toBe(200);
    local = false;
    expect((await call('GET', '/api/classes', { cookie })).status).toBe(401);
    expect((await login(NEW_PIN)).status).toBe(401);
    cookie = cookieOf(await login(PIN));
    expect((await call('GET', '/api/classes', { cookie })).status).toBe(200);
  });

  it('5 PIN equivocados bloquean esa IP (429 con tiempo de espera), incluso con el PIN correcto', async () => {
    // Un reinicio deja el contador de intentos en cero.
    await stopServer();
    await boot();
    local = false;
    for (let i = 0; i < MAX_FAILS; i++) {
      const wrong = await login('0000');
      expect(wrong.status).toBe(401);
      if (i === MAX_FAILS - 1) expect((wrong.body as { retryAfterSec: number }).retryAfterSec).toBe(BLOCK_BASE_MS / 1000);
    }
    for (const pin of ['0000', PIN]) {
      const blocked = await login(pin);
      expect(blocked.status).toBe(429);
      expect((blocked.body as { code: string }).code).toBe('PIN_LOCKED');
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(Number(blocked.headers.get('retry-after'))).toBeLessThanOrEqual(BLOCK_BASE_MS / 1000);
    }
    // Cambiar el PIN con uno actual equivocado cuenta en el mismo límite.
    expect((await call('POST', '/api/pin/set', { json: { pin: NEW_PIN, current: PIN } })).status).toBe(429);
    // La laptop no se ve afectada por el bloqueo.
    local = true;
    expect((await call('GET', '/api/classes')).status).toBe(200);
  });
});
