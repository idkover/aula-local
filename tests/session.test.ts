import { describe, expect, it } from 'vitest';
import { SessionStore } from '../server/session.js';

const join = (code: string, name = 'Ana', clientId = 'client-aaaa-1') => ({ code, name, clientId });

describe('SessionStore', () => {
  it('crea sesiones con código de 4 dígitos único y URLs de diapositivas', () => {
    const store = new SessionStore();
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = store.create(3);
      expect(s.code).toMatch(/^\d{4}$/);
      codes.add(s.code);
    }
    expect(codes.size).toBe(200);
    const s = store.create(2, 'abcdef123456');
    expect(s.slides).toEqual(['/slides/abcdef123456/0.png', '/slides/abcdef123456/1.png']);
    expect(s.slideIndex).toBe(0);
  });

  it('rechaza una presentación sin páginas', () => {
    expect(() => new SessionStore().create(0)).toThrow();
  });

  it('registra un alumno nuevo y lo recupera por clientId al reconectar', () => {
    const store = new SessionStore();
    const s = store.create(5);
    const first = store.join(join(s.code), 'sock-1');
    expect(first.ok && first.isNew).toBe(true);

    store.disconnect(s.id, 'client-aaaa-1', 'sock-1');
    expect(s.students.get('client-aaaa-1')?.connected).toBe(false);

    const again = store.join(join(s.code, ' Ana  María '), 'sock-2');
    expect(again.ok && !again.isNew).toBe(true);
    expect(s.students.size).toBe(1);
    const student = s.students.get('client-aaaa-1');
    expect(student).toMatchObject({ name: 'Ana María', socketId: 'sock-2', connected: true });
  });

  it('ignora la desconexión de un socket viejo si el alumno ya reconectó con otro', () => {
    const store = new SessionStore();
    const s = store.create(1);
    store.join(join(s.code), 'old');
    store.join(join(s.code), 'new');
    expect(store.disconnect(s.id, 'client-aaaa-1', 'old')).toBe(false);
    expect(s.students.get('client-aaaa-1')?.connected).toBe(true);
  });

  it('valida los datos de ingreso', () => {
    const store = new SessionStore();
    const s = store.create(1);
    expect(store.join(join('9999' === s.code ? '9998' : '9999'), 'x')).toMatchObject({ ok: false });
    expect(store.join(join(s.code, '   '), 'x')).toMatchObject({ ok: false });
    expect(store.join(join('12a4'), 'x')).toMatchObject({ ok: false });
    expect(store.join(join(s.code, 'Ana', 'bad id!'), 'x')).toMatchObject({ ok: false });
    expect(store.join(null, 'x')).toMatchObject({ ok: false });
    expect(store.join({ code: 1234 }, 'x')).toMatchObject({ ok: false });
    const long = store.join(join(s.code, 'x'.repeat(100)), 'x');
    expect(long.ok && long.student.name.length).toBe(40);
  });

  it('cambia de diapositiva solo con índices válidos', () => {
    const store = new SessionStore();
    const s = store.create(3);
    expect(store.gotoSlide(s.id, 2)).toBe(true);
    expect(s.slideIndex).toBe(2);
    for (const bad of [3, -1, 1.5, '1', null, undefined]) {
      expect(store.gotoSlide(s.id, bad)).toBe(false);
    }
    expect(store.gotoSlide('nope', 0)).toBe(false);
    expect(s.slideIndex).toBe(2);
  });

  it('arma state:sync y el contador de conectados', () => {
    const store = new SessionStore();
    const s = store.create(4);
    store.gotoSlide(s.id, 3);
    store.join(join(s.code, 'Ana', 'client-aaaa-1'), 's1');
    store.join(join(s.code, 'Beto', 'client-bbbb-2'), 's2');
    store.disconnect(s.id, 'client-bbbb-2', 's2');
    expect(store.stateFor(s, undefined, 123)).toEqual({ sessionId: s.id, classId: s.id, slideIndex: 3, slideCount: 4, serverNow: 123 });
    expect(store.status(s)).toEqual({ connected: 1, submitted: 0 });
  });
});
