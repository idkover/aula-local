// App de la bandeja: carpeta de datos por variable de entorno, apagado con token, aviso de versión, página de conexión.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAulaServer, type AulaServer, type AulaServerOptions } from '../server/index.js';
import { compareVersions, createUpdateChecker, readAppVersion } from '../server/update.js';
import type { ApiError, AppInfo, ClassListItem, ConnectInfo } from '../shared/types.js';
import { makePdf } from './helpers.js';
import { Harness } from './harness.js';

const TOKEN = 'token-de-prueba-0123456789';
const HOUR_MS = 60 * 60 * 1000;

/** Respuesta JSON, como la que da el servidor de versiones. */
function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let tmp = '';
const open: AulaServer[] = [];

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'aula-app-'));
  await mkdir(path.join(tmp, 'client'), { recursive: true });
});

afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Servidor de prueba con carpeta de datos propia, sin comprobación de versión y sin salir a la red. */
async function bootWith(extra: Partial<AulaServerOptions> = {}): Promise<AulaServer> {
  const server = await createAulaServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: path.join(tmp, 'data'),
    clientDir: path.join(tmp, 'client'),
    updateCheck: { enabled: false },
    ...extra,
  });
  open.push(server);
  return server;
}

// ---------- Carpeta de datos ----------

describe('carpeta de datos', () => {
  it('AULA_DATA_DIR se usa cuando no se pasa dataDir, y dataDir gana si se pasa', async () => {
    const envDir = path.join(tmp, 'env-data');
    const previous = process.env.AULA_DATA_DIR;
    process.env.AULA_DATA_DIR = envDir;
    let server: AulaServer;
    try {
      server = await createAulaServer({
        port: 0,
        host: '127.0.0.1',
        clientDir: path.join(tmp, 'client'),
        updateCheck: { enabled: false },
      });
    } finally {
      if (previous === undefined) delete process.env.AULA_DATA_DIR;
      else process.env.AULA_DATA_DIR = previous;
    }
    open.push(server);

    const base = `http://127.0.0.1:${server.port}`;
    const created = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: new Uint8Array(makePdf(2)),
    });
    expect(created.status).toBe(201);
    expect(existsSync(path.join(envDir, 'config.json'))).toBe(true);
    expect(existsSync(path.join(envDir, 'classes'))).toBe(true);
    const classes = (await (await fetch(`${base}/api/classes`)).json()) as ClassListItem[];
    expect(classes).toHaveLength(1);
    await server.close();
    open.splice(open.indexOf(server), 1);

    // Con dataDir explícito, la variable de entorno no se usa.
    process.env.AULA_DATA_DIR = envDir;
    const explicitDir = path.join(tmp, 'explicit-data');
    try {
      await bootWith({ dataDir: explicitDir });
    } finally {
      if (previous === undefined) delete process.env.AULA_DATA_DIR;
      else process.env.AULA_DATA_DIR = previous;
    }
    expect(existsSync(path.join(explicitDir, 'config.json'))).toBe(true);
  });
});

// ---------- Apagado con token ----------

describe('POST /api/app/shutdown', () => {
  it('sin token configurado la ruta no existe: 404', async () => {
    const server = await bootWith();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/app/shutdown`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('token equivocado: 403 y no se apaga nada', async () => {
    const onShutdownRequest = vi.fn();
    const server = await bootWith({ shutdownToken: TOKEN, onShutdownRequest });
    const wrong = await fetch(`http://127.0.0.1:${server.port}/api/app/shutdown`, {
      method: 'POST',
      headers: { 'X-Aula-Token': 'otro-token-que-no-es' },
    });
    expect(wrong.status).toBe(403);
    const missing = await fetch(`http://127.0.0.1:${server.port}/api/app/shutdown`, { method: 'POST' });
    expect(missing.status).toBe(403);
    expect(onShutdownRequest).not.toHaveBeenCalled();
  });

  it('con el token bueno pero desde otro equipo: 403', async () => {
    const onShutdownRequest = vi.fn();
    const server = await bootWith({ shutdownToken: TOKEN, onShutdownRequest, isLocal: () => false });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/app/shutdown`, {
      method: 'POST',
      headers: { 'X-Aula-Token': TOKEN },
    });
    expect(res.status).toBe(403);
    expect(onShutdownRequest).not.toHaveBeenCalled();
  });

  it('token bueno desde la laptop: 202 { ok: true } y el apagado se llama una sola vez', async () => {
    const onShutdownRequest = vi.fn();
    const server = await bootWith({ shutdownToken: TOKEN, onShutdownRequest });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/app/shutdown`, {
      method: 'POST',
      headers: { 'X-Aula-Token': TOKEN },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(onShutdownRequest).toHaveBeenCalledTimes(1);
  });
});

// ---------- Versión y aviso de actualización (unidades) ----------

describe('compareVersions', () => {
  it('compara x.y.z de forma numérica y lo que no es número cuenta como 0', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('2.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0);
    expect(compareVersions('x', '0.0.1')).toBe(-1);
  });

  it('la versión instalada es la de package.json', () => {
    expect(readAppVersion()).toBe('1.0.0');
  });
});

describe('createUpdateChecker', () => {
  const UPDATES_URL = 'https://updates.test';
  const newer = { version: '1.1.0', url: 'https://example.com/aula-local-1.1.0.exe', notes: 'Mejoras en el pizarrón' };

  it('una versión mayor queda como aviso, con su enlace y notas', async () => {
    const checker = createUpdateChecker({ baseUrl: UPDATES_URL, currentVersion: '1.0.0', fetch: async () => jsonReply(newer) });
    await checker.check();
    expect(checker.latest()).toEqual(newer);
    expect(checker.lastCheckedAt()).toBeTypeOf('number');
  });

  it('la misma versión o una anterior no es aviso', async () => {
    for (const version of ['1.0.0', '0.9.0']) {
      const checker = createUpdateChecker({
        baseUrl: UPDATES_URL,
        currentVersion: '1.0.0',
        fetch: async () => jsonReply({ version, url: newer.url }),
      });
      await checker.check();
      expect(checker.latest()).toBeUndefined();
    }
  });

  it('un error de red no lanza y conserva el aviso anterior', async () => {
    let fail = false;
    const checker = createUpdateChecker({
      baseUrl: UPDATES_URL,
      currentVersion: '1.0.0',
      fetch: async () => {
        if (fail) throw new Error('sin red');
        return jsonReply(newer);
      },
    });
    await checker.check();
    fail = true;
    await expect(checker.check()).resolves.toBeUndefined();
    expect(checker.latest()).toEqual(newer);
  });

  it('un error de red sin aviso previo: no hay aviso y no lanza', async () => {
    const checker = createUpdateChecker({
      baseUrl: UPDATES_URL,
      currentVersion: '1.0.0',
      fetch: async () => {
        throw new Error('sin red');
      },
    });
    await expect(checker.check()).resolves.toBeUndefined();
    expect(checker.latest()).toBeUndefined();
  });

  it('una respuesta con estado de error o con forma inesperada se ignora', async () => {
    const checker = createUpdateChecker({
      baseUrl: UPDATES_URL,
      currentVersion: '1.0.0',
      fetch: async () => new Response('<html>caído</html>', { status: 502 }),
    });
    await checker.check();
    expect(checker.latest()).toBeUndefined();

    const malformed = createUpdateChecker({
      baseUrl: UPDATES_URL,
      currentVersion: '1.0.0',
      fetch: async () => jsonReply({ version: 2, url: newer.url }),
    });
    await malformed.check();
    expect(malformed.latest()).toBeUndefined();
  });

  it('un enlace que no es https se ignora', async () => {
    const checker = createUpdateChecker({
      baseUrl: UPDATES_URL,
      currentVersion: '1.0.0',
      fetch: async () => jsonReply({ version: '2.0.0', url: 'http://example.com/aula.exe' }),
    });
    await checker.check();
    expect(checker.latest()).toBeUndefined();
  });

  it('pide GET a /api/version del servidor de versiones, sin cuerpo', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const checker = createUpdateChecker({
      baseUrl: `${UPDATES_URL}/`,
      currentVersion: '1.0.0',
      fetch: async (input, init) => {
        seen.push({ url: String(input), ...(init ? { init } : {}) });
        return jsonReply({ version: '1.0.0', url: newer.url });
      },
    });
    await checker.check();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${UPDATES_URL}/api/version`);
    expect(seen[0]?.init?.method).toBe('GET');
    expect(seen[0]?.init?.body).toBeUndefined();
  });

  it('start() consulta a los 5 s y luego cada intervalo; stop() lo detiene', async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.fn(async () => jsonReply({ version: '1.0.0', url: newer.url }));
      const checker = createUpdateChecker({ baseUrl: UPDATES_URL, currentVersion: '1.0.0', fetch: fetchSpy, intervalMs: HOUR_MS });
      checker.start();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchSpy).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(HOUR_MS);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      checker.stop();
      await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------- /api/app/info y /api/app/connect ----------

describe('/api/app/info y /api/app/connect', () => {
  const h = new Harness();
  /** Respuesta del servidor de versiones falso para la comprobación de versión; cada prueba la cambia. */
  let versionReply: () => Response = () => jsonReply({ version: '1.0.0', url: 'https://example.com/aula.exe' });

  beforeAll(async () => {
    await h.boot({ updateCheck: { fetch: async () => versionReply() } });
  }, 30_000);
  afterAll(() => h.stop());

  it('info sin aviso: versión 1.0.0 y ningún campo update', async () => {
    const info = await h.api<AppInfo>('GET', '/api/app/info');
    expect(info).toEqual({ version: '1.0.0' });
    expect(info.update).toBeUndefined();
  });

  it('info con una versión nueva del servidor de versiones: incluye el aviso', async () => {
    versionReply = () =>
      jsonReply({ version: '1.2.0', url: 'https://example.com/aula-local-1.2.0.exe', notes: 'Pizarrón más rápido' });
    await h.server.updates.check();
    const info = await h.api<AppInfo>('GET', '/api/app/info');
    expect(info).toEqual({
      version: '1.0.0',
      update: { version: '1.2.0', url: 'https://example.com/aula-local-1.2.0.exe', notes: 'Pizarrón más rápido' },
    });
  });

  it('connect: urls con la dirección de los alumnos (sin código) y su QR en SVG', async () => {
    const info = await h.api<ConnectInfo>('GET', '/api/app/connect');
    expect(info.urls.length).toBeGreaterThan(0);
    for (const url of info.urls) {
      expect(url).toMatch(/^http:\/\/[^/]+:\d+\/$/);
      expect(url.endsWith(`:${h.server.port}/`)).toBe(true);
    }
    expect(info.qrSvg.startsWith('<svg')).toBe(true);
  });
});

describe('sin límites de plan', () => {
  it('se pueden crear 4 clases seguidas sin tope y la ruta de licencia ya no existe', async () => {
    const server = await bootWith();
    const base = `http://127.0.0.1:${server.port}`;
    for (let i = 1; i <= 4; i++) {
      const res = await fetch(`${base}/api/classes?title=Clase%20${i}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: new Uint8Array(makePdf(1)),
      });
      expect(res.status).toBe(201);
    }
    const classes = (await (await fetch(`${base}/api/classes`)).json()) as ClassListItem[];
    expect(classes).toHaveLength(4);
    expect((await fetch(`${base}/api/license`)).status).toBe(404);
  });
});

describe('protección de las páginas y APIs nuevas', () => {
  it('desde otro equipo sin PIN: las páginas redirigen al PIN y la API responde 403 PIN_NOT_SET', async () => {
    const server = await bootWith({ isLocal: () => false });
    const base = `http://127.0.0.1:${server.port}`;
    for (const route of ['/teacher/conectar', '/teacher/guia-red']) {
      const res = await fetch(`${base}${route}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
    }
    const api = await fetch(`${base}/api/app/connect`);
    expect(api.status).toBe(403);
    expect(((await api.json()) as ApiError).code).toBe('PIN_NOT_SET');
    expect((await fetch(`${base}/api/app/info`)).status).toBe(403);
  });
});
