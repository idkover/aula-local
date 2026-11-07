// Trazado de un trazo con perfect-freehand, sin DOM: lo usan el navegador (Path2D del canvas) y el
// servidor (Path2D de @napi-rs/canvas, para los PNG del ZIP), así un trazo se ve igual en todos lados.
import { getStroke } from 'perfect-freehand';
import type { StrokePoint } from './types.js';

// Determinista: la presión viaja en cada punto (0.5 constante con dedo o mouse), así que el mismo
// trazo se ve igual en el celular del alumno, en la vista del profesor y en la exportación.
export const FREEHAND = { thinning: 0.6, smoothing: 0.5, streamline: 0.35, simulatePressure: false } as const;

/** Lo mínimo de un Path2D que necesita `traceOutline` (navegador o @napi-rs/canvas). */
export type PathSink = {
  moveTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  closePath(): void;
};

/** Contorno (polígono) de un trazo en píxeles de un lienzo de `width` × `height`. */
export function strokeOutline(
  points: readonly StrokePoint[],
  size: number,
  width: number,
  height: number,
  complete = true,
): number[][] {
  const px = points.map(([x, y, p]) => [x * width, y * height, p]);
  return getStroke(px, { ...FREEHAND, size: (size / 1000) * width, last: complete });
}

/** Contorno → trayecto suavizado con curvas cuadráticas por puntos medios. */
export function traceOutline<T extends PathSink>(path: T, outline: readonly number[][]): T {
  const n = outline.length;
  if (n < 2) return path;
  const [x0, y0] = outline[0] as [number, number];
  path.moveTo(x0, y0);
  for (let i = 0; i < n; i++) {
    const [ax, ay] = outline[i] as [number, number];
    const [bx, by] = outline[(i + 1) % n] as [number, number];
    path.quadraticCurveTo(ax, ay, (ax + bx) / 2, (ay + by) / 2);
  }
  path.closePath();
  return path;
}
