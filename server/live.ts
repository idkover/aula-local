// Estado privado de una clase en curso, para retomarla si el servidor se reinicia: data/live/<sessionId>.json.
// Guarda lo que el historial (data/classes/) deliberadamente no tiene: el código de la sesión, la diapositiva
// actual y el `clientId` de cada alumno (su credencial de reconexión). Vive fuera de classes/ para que el
// historial se pueda copiar sin credenciales, y se borra al terminar la clase.
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Session, Spotlight } from '../shared/types.js';
import { DECK_ID_RE } from './classes.js';
import { readJson, writeJsonAtomic } from './files.js';

/** Una clase sin guardar hace más de esto no se retoma: queda como "interrumpida" en el historial. */
export const LIVE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export type LiveSnapshot = {
  version: 1;
  sessionId: string;
  classId: string;
  savedAt: number;
  code: string;
  slideIndex: number;
  spotlight?: Spotlight;
  /** clientId → id público del alumno. */
  clients: Record<string, string>;
};

export function toLiveSnapshot(session: Session, now = Date.now()): LiveSnapshot {
  const clients: Record<string, string> = {};
  for (const student of session.students.values()) clients[student.clientId] = student.id;
  const snapshot: LiveSnapshot = {
    version: 1,
    sessionId: session.id,
    classId: session.classId,
    savedAt: now,
    code: session.code,
    slideIndex: session.slideIndex,
    clients,
  };
  if (session.spotlight) snapshot.spotlight = session.spotlight;
  return snapshot;
}

export class LiveStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'live');
  }

  save(session: Session, now = Date.now()): Promise<void> {
    return writeJsonAtomic(this.file(session.id), toLiveSnapshot(session, now));
  }

  async list(): Promise<LiveSnapshot[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const ids = names.map((n) => /^([a-f0-9]{12})\.json$/.exec(n)?.[1]).filter((id): id is string => Boolean(id));
    const snapshots = await Promise.all(ids.map((id) => readJson<LiveSnapshot>(this.file(id))));
    return snapshots.filter((s): s is LiveSnapshot => s?.version === 1 && DECK_ID_RE.test(s.classId));
  }

  remove(sessionId: string): Promise<void> {
    return rm(this.file(sessionId), { force: true });
  }

  private file(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.json`);
  }
}
