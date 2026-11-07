// Render de trazos en el navegador. El trazado vive en shared/freehand.ts para que el servidor
// (exportación a PNG) dibuje exactamente igual.
import { strokeOutline, traceOutline } from '../../shared/freehand.js';
import type { Stroke, StrokePoint } from '../../shared/types.js';

export function strokePath(points: StrokePoint[], size: number, width: number, height: number, complete = true): Path2D {
  return traceOutline(new Path2D(), strokeOutline(points, size, width, height, complete));
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, width: number, height: number, complete = true): void {
  ctx.fillStyle = stroke.color;
  ctx.fill(strokePath(stroke.points, stroke.size, width, height, complete));
}

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: readonly Stroke[], width: number, height: number): void {
  for (const stroke of strokes) drawStroke(ctx, stroke, width, height);
}
