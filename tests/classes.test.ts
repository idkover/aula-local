import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClassStore } from '../server/classes.js';
import { parseQuestionSpec, PROMPT_MAX_LENGTH } from '../server/validate.js';
import { makePdf } from './helpers.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'aula-classes-'));
afterAll(() => rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe('parseQuestionSpec', () => {
  it('acepta tipo, diapositiva, tiempo y enunciado válidos, y limpia el enunciado', () => {
    expect(parseQuestionSpec({ type: 'text', slideIndex: 2, timeLimitSec: 60, prompt: '  ¿Cuánto es 2+2?  ' }, 3)).toEqual({
      type: 'text',
      slideIndex: 2,
      timeLimitSec: 60,
      prompt: '¿Cuánto es 2+2?',
    });
    expect(parseQuestionSpec({ type: 'blank', prompt: '   ' }, 3)).toEqual({ type: 'blank' });
    expect(parseQuestionSpec({ type: 'blank', prompt: 'x'.repeat(900) }, 3)?.prompt).toHaveLength(PROMPT_MAX_LENGTH);
  });

  it('rechaza datos fuera de rango', () => {
    for (const bad of [
      null,
      { type: 'dibujo' },
      { type: 'blank', slideIndex: 3 },
      { type: 'blank', slideIndex: -1 },
      { type: 'blank', timeLimitSec: 0 },
      { type: 'blank', timeLimitSec: 3601 },
      { type: 'blank', prompt: 42 },
    ]) {
      expect(parseQuestionSpec(bad, 3)).toBeUndefined();
    }
  });
});

describe('ClassStore', () => {
  const store = new ClassStore(tmp);

  it('crea una clase con sus diapositivas y la lista', async () => {
    const info = await store.create(makePdf(3), '  Fracciones   equivalentes ', 1000);
    expect(info).toMatchObject({ title: 'Fracciones equivalentes', slideCount: 3, questions: [], createdAt: 1000 });
    expect((await readdir(store.slidesDir(info.id))).sort()).toEqual(['0.png', '1.png', '2.png']);
    expect((await store.list()).map((c) => c.id)).toContain(info.id);
    // Otra instancia (como tras reiniciar el servidor) la lee del disco.
    expect(await new ClassStore(tmp).get(info.id)).toEqual(info);
  }, 30_000);

  it('ignora carpetas temporales o sin class.json y no deja nada si el PDF falla', async () => {
    await mkdir(path.join(tmp, 'classes', '.tmp-abcdefabcdef'), { recursive: true });
    await mkdir(path.join(tmp, 'classes', '0123456789ab'), { recursive: true });
    const before = (await store.list()).length;
    await expect(store.create(Buffer.from('%PDF-roto'), 'Rota')).rejects.toThrow();
    expect((await store.list()).length).toBe(before);
    expect((await readdir(path.join(tmp, 'classes'))).filter((n) => n.startsWith('.tmp-') && n !== '.tmp-abcdefabcdef')).toEqual([]);
  }, 30_000);

  it('guarda preguntas preparadas validadas y ordenadas por diapositiva', async () => {
    const info = await store.create(makePdf(3), 'Preguntas');
    const ok = await store.update(info.id, {
      title: 'Preguntas v2',
      questions: [
        { id: 'pq-0002', slideIndex: 2, type: 'text', prompt: 'Explica' },
        { id: 'pq-0001', slideIndex: 0, type: 'overSlide', timeLimitSec: 30 },
        { id: 'pq-0003', slideIndex: 0, type: 'blank' },
      ],
    });
    expect(ok?.ok && ok.info.questions.map((q) => q.id)).toEqual(['pq-0001', 'pq-0003', 'pq-0002']);
    expect(ok?.ok && ok.info.title).toBe('Preguntas v2');

    for (const questions of [
      [{ id: 'pq-0001', slideIndex: 3, type: 'blank' }], // diapositiva inexistente
      [{ id: 'pq-0001', type: 'blank' }], // sin diapositiva
      [
        { id: 'pq-0001', slideIndex: 0, type: 'blank' },
        { id: 'pq-0001', slideIndex: 1, type: 'blank' }, // id repetido
      ],
      'nada',
    ]) {
      expect(await store.update(info.id, { title: 'x', questions })).toMatchObject({ ok: false });
    }
    expect(await store.update('ffffffffffff', { title: 'x', questions: [] })).toBeUndefined();
  }, 30_000);

  it('borra la clase completa', async () => {
    const info = await store.create(makePdf(1), 'Borrar');
    expect(await store.delete(info.id)).toBe(true);
    expect(await store.get(info.id)).toBeUndefined();
    expect(await store.delete(info.id)).toBe(false);
  }, 30_000);
});
