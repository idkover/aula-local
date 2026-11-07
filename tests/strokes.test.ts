import { describe, expect, it } from 'vitest';
import { distanceToStroke, normalizePoint, parseStroke, strokeRadius } from '../shared/strokes.js';
import type { Stroke } from '../shared/types.js';

describe('normalizePoint', () => {
  it('normaliza a 0–1 con 3 decimales y recorta fuera del lienzo', () => {
    expect(normalizePoint(123.456, 50, 0.73456, 400, 300)).toEqual([0.309, 0.167, 0.735]);
    expect(normalizePoint(-5, 400, 2, 400, 300)).toEqual([0, 1, 1]);
  });
});

describe('parseStroke', () => {
  it('acepta un trazo válido y normaliza color y decimales', () => {
    expect(parseStroke({ id: 'abcd1234', color: '#E11D48', size: 6, points: [[0.12345, 0.5, 0.5]] })).toEqual({
      id: 'abcd1234',
      color: '#e11d48',
      size: 6,
      points: [[0.123, 0.5, 0.5]],
    });
  });

  it('descarta campos extra y rechaza datos mal formados', () => {
    const extra = parseStroke({ id: 'abcd1234', color: '#000000', size: 3, points: [[0, 0, 0]], hack: 1 });
    expect(extra).not.toHaveProperty('hack');
    expect(parseStroke({ id: 'a', color: '#000000', size: 3, points: [[0, 0, 0]] })).toBeUndefined();
    expect(parseStroke({ id: 'abcd1234', color: '#000000', size: 3, points: [[0, 0]] })).toBeUndefined();
    expect(parseStroke({ id: 'abcd1234', color: '#000000', size: 3, points: Array(2001).fill([0, 0, 0]) })).toBeUndefined();
  });
});

describe('borrador de trazo completo', () => {
  const line: Stroke = {
    id: 'line0001',
    color: '#000000',
    size: 10,
    points: [
      [0.1, 0.5, 0.5],
      [0.9, 0.5, 0.5],
    ],
  };

  it('mide la distancia al segmento sin deformarse por la proporción', () => {
    expect(distanceToStroke(line, 0.5, 0.5, 4 / 3)).toBeCloseTo(0);
    expect(distanceToStroke(line, 0.5, 0.6, 4 / 3)).toBeCloseTo(0.1);
    // Más allá del extremo derecho: la distancia horizontal se escala por la proporción.
    expect(distanceToStroke(line, 1, 0.5, 2)).toBeCloseTo(0.2);
  });

  it('funciona con trazos de un solo punto (un toque)', () => {
    const dot: Stroke = { ...line, points: [[0.5, 0.5, 0.5]] };
    expect(distanceToStroke(dot, 0.5, 0.55, 1)).toBeCloseTo(0.05);
  });

  it('expresa el radio en las mismas unidades', () => {
    expect(strokeRadius(line, 2)).toBeCloseTo(0.01);
  });
});
