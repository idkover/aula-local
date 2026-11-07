// Lectura y escritura de JSON en disco. Las escrituras son atómicas (archivo temporal + rename) y
// se serializan por ruta, así un corte de luz o dos guardados seguidos nunca dejan un JSON a medias.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const queues = new Map<string, Promise<void>>();

export function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => writeNow(file, data));
  queues.set(file, next);
  void next.finally(() => {
    if (queues.get(file) === next) queues.delete(file);
  }).catch(() => undefined);
  return next;
}

async function writeNow(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  try {
    await rename(tmp, file);
  } catch (err) {
    // Windows a veces bloquea el destino un instante (antivirus, otro lector): un reintento basta.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM' && (err as NodeJS.ErrnoException).code !== 'EBUSY') {
      await rm(tmp, { force: true });
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rename(tmp, file).catch(async (retryErr: unknown) => {
      await rm(tmp, { force: true });
      throw retryErr;
    });
  }
}

/** Lee un JSON; devuelve undefined si no existe o está dañado. */
export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
