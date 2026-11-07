// Conexión Socket.IO con reconexión automática y aviso visible cuando se pierde el servidor.
import { io, type Socket } from 'socket.io-client';

export type ConnectionState = 'connecting' | 'online' | 'offline';

export function connect<Listen extends object, Emit extends object>(
  namespace: '/student' | '/teacher',
  auth?: Record<string, string>,
): Socket<Listen, Emit> {
  return io(namespace, {
    ...(auth ? { auth } : {}),
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    timeout: 8000,
  }) as unknown as Socket<Listen, Emit>;
}

/** Notifica cambios de conectividad (incluye reintentos de reconexión). */
export function watchConnection(socket: Socket, onChange: (state: ConnectionState) => void): void {
  onChange(socket.connected ? 'online' : 'connecting');
  socket.on('connect', () => onChange('online'));
  socket.on('disconnect', () => onChange('offline'));
  socket.on('connect_error', () => onChange('offline'));
  socket.io.on('reconnect_attempt', () => onChange('offline'));
}

/** Identificador estable del dispositivo. `crypto.randomUUID` no existe en HTTP sin TLS, por eso usamos getRandomValues. */
export function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** localStorage puede fallar (modo privado, almacenamiento bloqueado): nunca rompe la app. */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* sin persistencia en este navegador */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* sin persistencia en este navegador */
    }
  },
};

export function $<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Falta el elemento ${selector}`);
  return el;
}
