// Integración: servidor real + clientes socket.io-client (un profesor y tres alumnos).
import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AulaServer } from '../server/index.js';
import type { SessionInfo, StateSyncPayload } from '../shared/types.js';
import { Harness, next, type TeacherSocket } from './harness.js';

const h = new Harness();
let server: AulaServer;
let base: string;
let info: SessionInfo;

beforeAll(async () => {
  await h.start(4);
  ({ server, base, info } = h);
}, 30_000);

afterAll(() => h.stop());

const open = <T extends Socket>(namespace: string, auth?: Record<string, string>) => h.open<T>(namespace, auth);
const joinStudent = (clientId: string, name: string, code?: string) => h.joinStudent(clientId, name, code);

describe('HTTP', () => {
  it('crea la sesión desde un PDF y devuelve código, URL y QR', () => {
    expect(info.code).toMatch(/^\d{4}$/);
    expect(info.slideCount).toBe(4);
    expect(info.slideIndex).toBe(0);
    expect(info.joinUrl).toMatch(new RegExp(`^http://.+:${server.port}/\\?code=${info.code}$`));
    expect(info.qrSvg).toContain('<svg');
  });

  it('rechaza archivos que no son PDF', async () => {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: 'hola',
    });
    expect(res.status).toBe(400);
  });

  it('sirve las diapositivas como PNG cacheables y nada fuera de la sesión', async () => {
    const ok = await fetch(`${base}/slides/${info.sessionId}/3.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(ok.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${base}/slides/${info.sessionId}/9.png`)).status).toBe(404);
    expect((await fetch(`${base}/slides/${info.sessionId}/..%2Foriginal.pdf`)).status).toBe(404);
    expect((await fetch(`${base}/slides/000000000000/0.png`)).status).toBe(404);
    expect((await fetch(`${base}/api/sessions/nope`)).status).toBe(404);
  });

  it('sirve las páginas de alumno y profesor con CSP que bloquea recursos externos', async () => {
    const student = await fetch(`${base}/`);
    expect(await student.text()).toContain('student');
    expect(student.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await (await fetch(`${base}/teacher`)).text()).toContain('teacher');
  });
});

describe('Sincronía de diapositivas', () => {
  it('rechaza al profesor con una sesión inexistente', async () => {
    const teacher = open<TeacherSocket>('/teacher', { sessionId: 'nope' });
    const err = await next<Error>(teacher, 'connect_error');
    expect(err.message).toBe('SESSION_NOT_FOUND');
    teacher.disconnect();
  });

  it('rechaza a un alumno con código equivocado', async () => {
    const wrong = info.code === '0000' ? '0001' : '0000';
    const { socket, result } = await joinStudent('client-wrong-0', 'Nadie', wrong);
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    socket.disconnect();
  });

  it('tres alumnos siguen las diapositivas y uno que recarga vuelve a la actual', async () => {
    const teacher = open<TeacherSocket>('/teacher', { sessionId: info.sessionId });
    const teacherSync = await next<StateSyncPayload>(teacher, 'state:sync');
    expect(teacherSync).toMatchObject({ sessionId: info.sessionId, slideIndex: 0, slideCount: 4 });

    const students = [];
    for (const [i, name] of ['Ana', 'Beto', 'Caro'].entries()) {
      const status = next<{ connected: number }>(teacher, 'answer:status');
      const joined = await joinStudent(`client-test-${i}`, name);
      expect(joined.result).toEqual({ ok: true });
      expect(await joined.synced).toMatchObject({ sessionId: info.sessionId, slideIndex: 0, slideCount: 4 });
      expect((await status).connected).toBe(i + 1);
      students.push(joined.socket);
    }

    // El profesor avanza: todos cambian al instante (objetivo < 300 ms).
    const start = performance.now();
    const received = students.map((s) => next<{ index: number }>(s, 'slide:goto'));
    const echo = next<{ index: number }>(teacher, 'slide:goto');
    teacher.emit('slide:goto', { index: 2 });
    expect(await Promise.all(received)).toEqual([{ index: 2 }, { index: 2 }, { index: 2 }]);
    expect(await echo).toEqual({ index: 2 });
    expect(performance.now() - start).toBeLessThan(300);

    // Índices inválidos no se difunden.
    const noEvent = next(students[0] as Socket, 'slide:goto', 300);
    teacher.emit('slide:goto', { index: 99 });
    await expect(noEvent).rejects.toThrow();
    expect(server.store.get(info.sessionId)?.slideIndex).toBe(2);

    // Beto recarga la página: socket nuevo, mismo clientId → vuelve a la diapositiva 3.
    const down = next<{ connected: number }>(teacher, 'answer:status');
    students[1]?.disconnect();
    expect((await down).connected).toBe(2);

    const up = next<{ connected: number }>(teacher, 'answer:status');
    const again = await joinStudent('client-test-1', 'Beto');
    expect(again.result).toEqual({ ok: true });
    expect(await again.synced).toMatchObject({ sessionId: info.sessionId, slideIndex: 2, slideCount: 4 });
    expect((await up).connected).toBe(3);
    expect(server.store.get(info.sessionId)?.students.size).toBe(3);

    // Un profesor que recarga también recibe el estado actual.
    const teacher2 = open<TeacherSocket>('/teacher', { sessionId: info.sessionId });
    expect(await next<StateSyncPayload>(teacher2, 'state:sync')).toMatchObject({ slideIndex: 2 });
  });
});
