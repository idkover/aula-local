// Versión de la app y aviso de versión nueva. Una vez al día (y 5 s después de arrancar) pregunta al servidor
// de versiones por la última versión. Solo sale la petición GET, sin cuerpo ni datos de la laptop.
// Cualquier fallo se ignora: se conserva el aviso anterior y la app sigue funcionando sin internet.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { UpdateInfo } from '../shared/types.js';
import { findProjectRoot } from './paths.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 5_000;
const CHECK_TIMEOUT_MS = 5_000;

/** Servidor que publica la versión más reciente (`GET /api/version`). */
export const DEFAULT_UPDATES_URL = 'https://aula-licencias.aula-licencias.workers.dev';

/** Versión de package.json en la raíz del proyecto; "0.0.0" si no se puede leer. */
export function readAppVersion(root: string = findProjectRoot()): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Versión instalada, leída una sola vez al arrancar. */
export const APP_VERSION = readAppVersion();

/** Un número `x.y.z` por parte; lo que no sea número cuenta como 0. Devuelve -1, 0 o 1. */
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function versionParts(version: string): number[] {
  return version
    .split('.')
    .slice(0, 3)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
}

export type UpdateChecker = {
  /** Empieza las comprobaciones: la primera a los 5 s y luego cada `intervalMs`. Los temporizadores no mantienen vivo el proceso. */
  start(): void;
  stop(): void;
  /** Versión nueva conocida, si la hay. */
  latest(): UpdateInfo | undefined;
  /** Hora (ms) de la última consulta que llegó bien al servidor de versiones. */
  lastCheckedAt(): number | undefined;
  /** Consulta ahora. No lanza nunca. */
  check(): Promise<void>;
};

export type UpdateCheckerOptions = {
  /** Servidor de versiones: se consulta `${baseUrl}/api/version`. */
  baseUrl: string;
  currentVersion: string;
  /** Cliente HTTP. Por defecto, el fetch global. Inyectable para las pruebas. */
  fetch?: typeof fetch | undefined;
  /** Reloj en milisegundos (para `lastCheckedAt`). */
  now?: (() => number) | undefined;
  intervalMs?: number | undefined;
};

type VersionReply = { version: string; url: string; notes?: string };

function isVersionReply(body: unknown): body is VersionReply {
  if (typeof body !== 'object' || body === null) return false;
  const { version, url, notes } = body as Record<string, unknown>;
  return typeof version === 'string' && typeof url === 'string' && (notes === undefined || typeof notes === 'string');
}

export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const clock = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? DAY_MS;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  let latest: UpdateInfo | undefined;
  let checkedAt: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  /** La respuesta del servidor de versiones, o undefined si hubo error, no fue 2xx o no tiene la forma esperada. */
  const fetchVersion = async (): Promise<VersionReply | undefined> => {
    try {
      const res = await doFetch(`${baseUrl}/api/version`, { method: 'GET', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      if (!res.ok) return undefined;
      const body: unknown = await res.json();
      return isVersionReply(body) ? body : undefined;
    } catch {
      return undefined;
    }
  };

  const check = async (): Promise<void> => {
    const reply = await fetchVersion();
    if (!reply) return; // Error: se conserva el aviso anterior.
    checkedAt = clock();
    const { version, url, notes } = reply;
    const newer = compareVersions(version, options.currentVersion) > 0;
    if (!newer || !url.startsWith('https://')) {
      latest = undefined;
      return;
    }
    latest = notes === undefined ? { version, url } : { version, url, notes };
  };

  const schedule = (ms: number): void => {
    timer = setTimeout(() => void tick(), ms);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    if (!running) return;
    await check();
    if (running) schedule(intervalMs);
  };

  return {
    start() {
      if (running) return;
      running = true;
      schedule(FIRST_CHECK_MS);
    },
    stop() {
      running = false;
      clearTimeout(timer);
      timer = undefined;
    },
    latest: () => latest,
    lastCheckedAt: () => checkedAt,
    check,
  };
}
