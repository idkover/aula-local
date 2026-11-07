import { beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../server/session.js';
import type { Session, Stroke } from '../shared/types.js';

const ANA = 'client-aaaa-1';
const BETO = 'client-bbbb-2';

const stroke = (id: string, x = 0.5): Stroke => ({
  id,
  color: '#111111',
  size: 6,
  points: [
    [x, 0.5, 0.5],
    [x + 0.1, 0.6, 0.5],
  ],
});

let store: SessionStore;
let s: Session;

beforeEach(() => {
  store = new SessionStore();
  s = store.create(3);
  store.join({ code: s.code, name: 'Ana', clientId: ANA }, 'sa');
  store.join({ code: s.code, name: 'Beto', clientId: BETO }, 'sb');
});

describe('Preguntas', () => {
  it('abre una pregunta sobre la diapositiva actual y la expone en state:sync', () => {
    store.gotoSlide(s.id, 2);
    const outcome = store.openQuestion(s.id, { id: 'q-0001', type: 'overSlide', timeLimitSec: 60 }, 1000);
    expect(outcome?.question).toEqual({
      id: 'q-0001',
      type: 'overSlide',
      slideIndex: 2,
      openedAt: 1000,
      timeLimitSec: 60,
      closed: false,
    });
    expect(store.stateFor(s, s.students.get(ANA), 1500).question?.id).toBe('q-0001');
  });

  it('valida tipo, id, diapositiva y límite de tiempo', () => {
    for (const bad of [
      null,
      { id: 'q-0001', type: 'dibujo' },
      { id: 'x', type: 'blank' },
      { id: 'q-0001', type: 'blank', slideIndex: 3 },
      { id: 'q-0001', type: 'blank', timeLimitSec: 0 },
      { id: 'q-0001', type: 'blank', timeLimitSec: 1.5 },
      { id: 'q-0001', type: 'blank', timeLimitSec: 99999 },
    ]) {
      expect(store.openQuestion(s.id, bad)).toBeUndefined();
    }
  });

  it('abrir otra pregunta cierra la anterior; cerrar exige el id correcto', () => {
    store.openQuestion(s.id, { id: 'q-0001', type: 'blank' });
    const second = store.openQuestion(s.id, { id: 'q-0002', type: 'text' });
    expect(second?.closedPrevious?.id).toBe('q-0001');
    expect(store.closeQuestion(s.id, 'q-0001')).toBeUndefined();
    expect(store.closeQuestion(s.id, 'q-0002')?.closed).toBe(true);
    expect(store.closeQuestion(s.id, 'q-0002')).toBeUndefined();
    expect(store.stateFor(s).question).toBeUndefined();
  });
});

describe('Pizarrón', () => {
  beforeEach(() => {
    store.openQuestion(s.id, { id: 'q-0001', type: 'blank' });
  });

  const answer = () => s.students.get(ANA)?.answers['q-0001'];
  const ids = () => answer()?.strokes.map((x) => x.id);

  it('agrega, deshace, borra por id y limpia trazos', () => {
    for (const id of ['s-0001', 's-0002', 's-0003']) {
      expect(store.addStroke(s.id, ANA, { questionId: 'q-0001', stroke: stroke(id) })).toBeDefined();
    }
    expect(store.addStroke(s.id, ANA, { questionId: 'q-0001', stroke: stroke('s-0001') })).toBeUndefined(); // duplicado
    expect(store.removeStroke(s.id, ANA, { questionId: 'q-0001', strokeId: 's-0002' })).toBe(true);
    expect(ids()).toEqual(['s-0001', 's-0003']);
    expect(store.undoStroke(s.id, ANA, { questionId: 'q-0001' })).toBe(true);
    expect(ids()).toEqual(['s-0001']);
    expect(store.clearBoard(s.id, ANA, { questionId: 'q-0001' })).toBe(true);
    expect(ids()).toEqual([]);
    expect(store.undoStroke(s.id, ANA, { questionId: 'q-0001' })).toBe(false);
  });

  it('rechaza trazos inválidos, de otra pregunta o con la pregunta cerrada', () => {
    const bad = [
      { questionId: 'q-0001', stroke: { ...stroke('s-0001'), color: 'red' } },
      { questionId: 'q-0001', stroke: { ...stroke('s-0001'), points: [[1.5, 0, 0]] } },
      { questionId: 'q-0001', stroke: { ...stroke('s-0001'), points: [] } },
      { questionId: 'q-0001', stroke: { ...stroke('s-0001'), size: 500 } },
      { questionId: 'q-9999', stroke: stroke('s-0001') },
      null,
    ];
    for (const payload of bad) expect(store.addStroke(s.id, ANA, payload)).toBeUndefined();
    expect(store.addStroke(s.id, 'desconocido', { questionId: 'q-0001', stroke: stroke('s-0001') })).toBeUndefined();
    store.closeQuestion(s.id, 'q-0001');
    expect(store.addStroke(s.id, ANA, { questionId: 'q-0001', stroke: stroke('s-0001') })).toBeUndefined();
  });

  it('las respuestas de cada alumno están separadas y se recuperan en state:sync', () => {
    store.addStroke(s.id, ANA, { questionId: 'q-0001', stroke: stroke('s-0001') });
    store.addStroke(s.id, BETO, { questionId: 'q-0001', stroke: stroke('s-0002') });
    expect(store.stateFor(s, s.students.get(ANA)).myAnswer?.strokes.map((x) => x.id)).toEqual(['s-0001']);
    expect(store.stateFor(s, s.students.get(BETO)).myAnswer?.strokes.map((x) => x.id)).toEqual(['s-0002']);
  });

  it('entregar cuenta en el contador y se puede reenviar', () => {
    expect(store.submitAnswer(s.id, ANA, { questionId: 'q-0001' }, 10)).toEqual({ ok: true });
    expect(store.status(s)).toEqual({ connected: 2, submitted: 1 });
    store.addStroke(s.id, ANA, { questionId: 'q-0001', stroke: stroke('s-0001') });
    expect(store.status(s).submitted).toBe(1); // sigue entregado mientras edita
    expect(store.submitAnswer(s.id, ANA, { questionId: 'q-0001' }, 20)).toEqual({ ok: true });
    expect(answer()?.submittedAt).toBe(20);
    store.closeQuestion(s.id, 'q-0001');
    expect(store.submitAnswer(s.id, ANA, { questionId: 'q-0001' })).toMatchObject({ ok: false });
  });
});

describe('Respuesta de texto', () => {
  beforeEach(() => {
    store.openQuestion(s.id, { id: 'q-text', type: 'text' });
  });

  it('exige texto, lo recorta y no acepta trazos', () => {
    expect(store.submitAnswer(s.id, ANA, { questionId: 'q-text', text: '   ' })).toMatchObject({ ok: false });
    expect(store.submitAnswer(s.id, ANA, { questionId: 'q-text', text: `  ${'a'.repeat(600)} ` })).toEqual({ ok: true });
    expect(s.students.get(ANA)?.answers['q-text']?.text).toHaveLength(500);
    expect(store.addStroke(s.id, ANA, { questionId: 'q-text', stroke: stroke('s-0001') })).toBeUndefined();
  });
});
