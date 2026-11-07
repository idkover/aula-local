// Reglas y geometría de trazos compartidas: el servidor valida con ellas y el pizarrón dibuja y borra con ellas.
import type { Stroke, StrokePoint } from './types.js';

/** Paleta del pizarrón (6 colores con buen contraste sobre blanco y sobre diapositivas). */
export const BOARD_COLORS = ['#111111', '#e11d48', '#2563eb', '#16a34a', '#f59e0b', '#9333ea'] as const;

/** Grosores disponibles, en milésimas del ancho del pizarrón (ver `Stroke.size`). */
export const BOARD_SIZES = [4, 8, 16] as const;

export const MAX_POINTS_PER_STROKE = 2000;
export const MAX_STROKES_PER_ANSWER = 3000;
export const MAX_TEXT_LENGTH = 500;
export const MIN_SIZE = 1;
export const MAX_SIZE = 60;

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Normaliza un punto en píxeles del lienzo a 0–1 con 3 decimales. */
export function normalizePoint(x: number, y: number, pressure: number, width: number, height: number): StrokePoint {
  return [round3(clamp01(x / width)), round3(clamp01(y / height)), round3(clamp01(pressure))];
}

/** Valida un trazo recibido por la red. Devuelve una copia limpia o undefined si no es válido. */
export function parseStroke(value: unknown): Stroke | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, color, size, points } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !/^[\w-]{4,64}$/.test(id)) return undefined;
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return undefined;
  if (typeof size !== 'number' || !(size >= MIN_SIZE && size <= MAX_SIZE)) return undefined;
  if (!Array.isArray(points) || points.length < 1 || points.length > MAX_POINTS_PER_STROKE) return undefined;
  const clean: StrokePoint[] = [];
  for (const p of points as unknown[]) {
    if (!Array.isArray(p) || p.length !== 3) return undefined;
    const [x, y, pressure] = p as unknown[];
    if (!isUnit(x) || !isUnit(y) || !isUnit(pressure)) return undefined;
    clean.push([round3(x), round3(y), round3(pressure)]);
  }
  return { id, color: color.toLowerCase(), size, points: clean };
}

/**
 * Distancia de un punto normalizado (x, y) al trazo, medida en fracciones del ALTO del pizarrón
 * (x se escala por `aspect` = ancho / alto para que la distancia no se deforme). Sirve para el
 * borrador de trazo completo.
 */
export function distanceToStroke(stroke: Stroke, x: number, y: number, aspect: number): number {
  const pts = stroke.points;
  const first = pts[0];
  if (!first) return Infinity;
  let best = Math.hypot((x - first[0]) * aspect, y - first[1]);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as StrokePoint;
    const b = pts[i] as StrokePoint;
    best = Math.min(best, segmentDistance(x * aspect, y, a[0] * aspect, a[1], b[0] * aspect, b[1]));
  }
  return best;
}

/** Radio de un trazo en las mismas unidades que `distanceToStroke`. */
export function strokeRadius(stroke: Stroke, aspect: number): number {
  return ((stroke.size / 1000) * aspect) / 2;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp01(((px - ax) * dx + (py - ay) * dy) / len2);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function isUnit(n: unknown): n is number {
  return typeof n === 'number' && n >= 0 && n <= 1;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
