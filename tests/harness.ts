// Servidor real en un puerto libre + clientes socket.io-client, para pruebas de integración.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { createAulaServer, type AulaServer } from '../server/index.js';
import type {
  ServerToStudentEvents,
  ServerToTeacherEvents,
  SessionInfo,
  StateSyncPayload,
  StudentJoinResult,
  StudentToServerEvents,
  TeacherToServerEvents,
} from '../shared/types.js';
import { makePdf } from './helpers.js';

/**
 * Opciones del servidor de prueba:
 * - `updateCheck`: comprobación de versión. Por defecto apagada; `fetch` es el cliente HTTP del servidor de versiones
 *   (por defecto no responde nunca: ninguna prueba sale a la red).
 */
export type HarnessOptions = {
  updateCheck?: { fetch?: typeof fetch; enabled?: boolean };
};

/** Servidor de versiones caído: cualquier llamada falla, como si no hubiera red. */
const noNetwork: typeof fetch = async () => {
  throw new Error('Prueba sin red: el servidor de versiones no está disponible.');
};

export type StudentSocket = Socket<ServerToStudentEvents, StudentToServerEvents>;
export type TeacherSocket = Socket<ServerToTeacherEvents, TeacherToServerEvents>;

export class Harness {
  server!: AulaServer;
  base = '';
  info!: SessionInfo;
  private tmp = '';
  private updateCheck: { fetch?: typeof fetch; enabled?: boolean } = { enabled: false };
  private readonly sockets: Socket[] = [];

  /** Arranca el servidor con páginas de prueba y crea una sesión subiendo un PDF de `pages` páginas. */
  async start(pages = 4, options: HarnessOptions = {}): Promise<void> {
    await this.boot(options);
    this.info = await this.api<SessionInfo>('POST', '/api/sessions', makePdf(pages), 201);
  }

  /** Arranca solo el servidor (sin sesión), con una carpeta de datos nueva. */
  async boot(options: HarnessOptions = {}): Promise<void> {
    this.tmp = await mkdtemp(path.join(os.tmpdir(), 'aula-test-'));
    const clientDir = path.join(this.tmp, 'client');
    for (const page of ['student', 'teacher']) {
      await mkdir(path.join(clientDir, page), { recursive: true });
      await writeFile(path.join(clientDir, page, 'index.html'), `<!doctype html><title>${page}</title>`);
    }
    this.updateCheck = { enabled: false, ...options.updateCheck };
    await this.listen();
  }

  /** Carpeta de datos del servidor (data/ de esta prueba). */
  get dataDir(): string {
    return path.join(this.tmp, 'data');
  }

  /**
   * Apaga el servidor (guardando todo) y levanta otro con la misma carpeta de datos.
   * `whileDown` corre con el servidor apagado (p. ej. para simular que pasó el tiempo).
   */
  async restart(whileDown?: () => Promise<void>): Promise<void> {
    this.disconnectAll();
    await this.server.close();
    await whileDown?.();
    await this.listen();
  }

  async stop(): Promise<void> {
    this.disconnectAll();
    await this.server.close();
    await rm(this.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  /** Llama a la API REST y verifica el código de estado. `body` Buffer = PDF; objeto = JSON. */
  async api<T>(method: string, url: string, body?: unknown, expectStatus = 200): Promise<T> {
    const init: RequestInit = { method };
    if (Buffer.isBuffer(body)) {
      init.headers = { 'Content-Type': 'application/pdf' };
      init.body = new Uint8Array(body);
    } else if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${this.base}${url}`, init);
    const text = await res.text();
    if (res.status !== expectStatus) throw new Error(`${method} ${url}: ${res.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async listen(): Promise<void> {
    this.server = await createAulaServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: this.dataDir,
      clientDir: path.join(this.tmp, 'client'),
      // Nunca se sale a la red: el servidor de versiones de prueba no existe y su cliente HTTP es falso.
      updateCheck: { ...this.updateCheck, baseUrl: 'https://updates.test', fetch: this.updateCheck.fetch ?? noNetwork },
    });
    this.base = `http://127.0.0.1:${this.server.port}`;
  }

  private disconnectAll(): void {
    for (const s of this.sockets) s.disconnect();
    this.sockets.length = 0;
  }

  open<T extends Socket>(namespace: string, auth?: Record<string, string>): T {
    const socket = io(`${this.base}${namespace}`, { transports: ['websocket'], forceNew: true, ...(auth ? { auth } : {}) });
    this.sockets.push(socket);
    return socket as unknown as T;
  }

  async teacher(): Promise<{ socket: TeacherSocket; synced: StateSyncPayload }> {
    const socket = this.open<TeacherSocket>('/teacher', { sessionId: this.info.sessionId });
    return { socket, synced: await next<StateSyncPayload>(socket, 'state:sync') };
  }

  async joinStudent(clientId: string, name: string, code = this.info.code) {
    const socket = this.open<StudentSocket>('/student');
    const synced = next<StateSyncPayload>(socket, 'state:sync');
    const result = await new Promise<StudentJoinResult>((resolve) =>
      socket.emit('student:join', { code, name, clientId }, resolve),
    );
    return { socket, result, synced };
  }
}

/** Espera el siguiente `event` del socket; falla si no llega en `timeoutMs`. */
export function next<T>(socket: Socket, event: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin evento ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Como `next`, pero ignora los eventos que no cumplen `match` (p. ej. contadores atrasados). */
export function nextWhere<T>(socket: Socket, event: string, match: (payload: T) => boolean, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Sin evento ${event} que cumpla la condición`));
    }, timeoutMs);
    const listener = (payload: T) => {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}
