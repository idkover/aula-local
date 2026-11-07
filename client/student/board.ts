// Pizarrón del alumno: Canvas 2D + Pointer Events + perfect-freehand.
// Dos lienzos: `base` con los trazos terminados (se redibuja solo cuando cambian) y `live` con el
// trazo en curso (se redibuja por cuadro). Los trazos se envían completos al soltar el dedo.
import { distanceToStroke, MAX_POINTS_PER_STROKE, normalizePoint, strokeRadius } from '../../shared/strokes.js';
import type { Stroke } from '../../shared/types.js';
import { randomId } from '../common/socket.js';
import { drawStroke, drawStrokes } from '../common/strokes.js';

export type Tool = 'pen' | 'eraser';

/**
 * Cómo se avisa cada cambio local. Deshacer un trazo es siempre `remove(id)`: `stroke:undo` saca el
 * último trazo del servidor, y eso es peligroso al reenviar o reconciliar después de una caída.
 */
export type BoardSink = {
  add: (stroke: Stroke) => void;
  remove: (strokeId: string) => void;
  clear: () => void;
};

type Op = { kind: 'add'; stroke: Stroke } | { kind: 'remove'; strokes: Stroke[] } | { kind: 'clear'; strokes: Stroke[] };

const MIN_POINT_DISTANCE_PX = 1.5;
const ERASER_TOLERANCE_PX = 12;
const FINGER_PRESSURE = 0.5;

export class Board {
  tool: Tool = 'pen';
  color = '#111111';
  size = 8;
  /** Se llama cuando cambian el contenido o el historial (para refrescar botones). */
  onChange: () => void = () => undefined;

  private strokes: Stroke[] = [];
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  private enabled = false;
  private aspect = 4 / 3;
  private width = 0;
  private height = 0;
  private dpr = 1;

  private activePointer: number | null = null;
  private penSeen = false;
  private current: Stroke | null = null;
  private erased: Stroke[] = [];
  private frameRequested = false;

  private readonly baseCtx: CanvasRenderingContext2D;
  private readonly liveCtx: CanvasRenderingContext2D;

  constructor(
    private readonly area: HTMLElement,
    private readonly frame: HTMLElement,
    private readonly base: HTMLCanvasElement,
    private readonly live: HTMLCanvasElement,
    private readonly sink: BoardSink,
  ) {
    this.baseCtx = base.getContext('2d') as CanvasRenderingContext2D;
    this.liveCtx = live.getContext('2d') as CanvasRenderingContext2D;
    new ResizeObserver(() => this.layout()).observe(area);

    live.addEventListener('pointerdown', (e) => this.onDown(e));
    live.addEventListener('pointermove', (e) => this.onMove(e));
    live.addEventListener('pointerup', (e) => this.onUp(e));
    live.addEventListener('pointercancel', (e) => this.onUp(e));
    live.addEventListener('contextmenu', (e) => e.preventDefault());
    // iOS antiguo ignora `touch-action`: evitamos scroll y zoom mientras se dibuja.
    live.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    live.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  /** Carga el pizarrón de una pregunta. `aspect` = ancho / alto de la diapositiva, igual en todos los dispositivos. */
  load(strokes: readonly Stroke[], aspect: number): void {
    this.cancelGesture();
    this.strokes = [...strokes];
    this.undoStack = [];
    this.redoStack = [];
    this.aspect = aspect > 0 ? aspect : 4 / 3;
    this.layout();
    this.onChange();
  }

  /** Copia de los trazos actuales, en orden: el tablero local que se reconcilia con el servidor. */
  snapshot(): Stroke[] {
    return [...this.strokes];
  }

  get isEmpty(): boolean {
    return this.strokes.length === 0;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancelGesture();
  }

  undo(): void {
    const op = this.undoStack.pop();
    if (!op) return;
    this.revert(op);
    this.redoStack.push(op);
    this.redraw();
    this.onChange();
  }

  redo(): void {
    const op = this.redoStack.pop();
    if (!op) return;
    this.apply(op);
    this.undoStack.push(op);
    this.redraw();
    this.onChange();
  }

  clear(): void {
    if (!this.strokes.length) return;
    this.commit({ kind: 'clear', strokes: [...this.strokes] });
    this.redraw();
  }

  // ---------- Historial ----------

  private commit(op: Op): void {
    this.apply(op);
    this.undoStack.push(op);
    this.redoStack = [];
    this.onChange();
  }

  private apply(op: Op): void {
    switch (op.kind) {
      case 'add':
        this.strokes.push(op.stroke);
        this.sink.add(op.stroke);
        break;
      case 'remove':
        for (const s of op.strokes) this.removeLocal(s.id);
        break;
      case 'clear':
        this.strokes = [];
        this.sink.clear();
        break;
    }
  }

  private revert(op: Op): void {
    switch (op.kind) {
      case 'add':
        this.removeLocal(op.stroke.id);
        break;
      case 'remove':
      case 'clear':
        // Los trazos vuelven al final (el servidor también los agrega al final).
        for (const s of op.strokes) {
          this.strokes.push(s);
          this.sink.add(s);
        }
        break;
    }
  }

  private removeLocal(strokeId: string): void {
    const index = this.strokes.findIndex((s) => s.id === strokeId);
    if (index < 0) return;
    this.strokes.splice(index, 1);
    this.sink.remove(strokeId);
  }

  // ---------- Entrada ----------

  private onDown(e: PointerEvent): void {
    if (!this.enabled || this.activePointer !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'pen') this.penSeen = true;
    // Rechazo de palma: si ya se usó un stylus, se ignoran los toques con la mano.
    if (e.pointerType === 'touch' && this.penSeen) return;
    e.preventDefault();
    this.live.setPointerCapture(e.pointerId);
    this.activePointer = e.pointerId;

    if (this.tool === 'pen') {
      this.current = { id: randomId(8), color: this.color, size: this.size, points: [this.point(e)] };
      this.requestFrame();
    } else {
      this.erased = [];
      this.eraseAt(e);
    }
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerId !== this.activePointer) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) {
      if (this.tool === 'pen') this.addPoint(ev);
      else this.eraseAt(ev);
    }
    if (this.tool === 'pen') this.requestFrame();
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    if (this.current) {
      const stroke = this.current;
      this.current = null;
      this.clearLive();
      this.commit({ kind: 'add', stroke });
      drawStroke(this.baseCtx, stroke, this.width, this.height);
    } else if (this.erased.length) {
      // Los trazos ya se quitaron durante el gesto; aquí solo se registra para poder deshacer.
      this.undoStack.push({ kind: 'remove', strokes: this.erased });
      this.redoStack = [];
      this.erased = [];
      this.onChange();
    }
  }

  private addPoint(e: PointerEvent): void {
    const stroke = this.current;
    if (!stroke || stroke.points.length >= MAX_POINTS_PER_STROKE) return;
    const last = stroke.points.at(-1);
    const p = this.point(e);
    if (last && Math.hypot((p[0] - last[0]) * this.width, (p[1] - last[1]) * this.height) < MIN_POINT_DISTANCE_PX) return;
    stroke.points.push(p);
  }

  private eraseAt(e: PointerEvent): void {
    const [x, y] = this.point(e);
    const tolerance = ERASER_TOLERANCE_PX / this.height;
    let hit = false;
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const stroke = this.strokes[i] as Stroke;
      if (distanceToStroke(stroke, x, y, this.aspect) <= strokeRadius(stroke, this.aspect) + tolerance) {
        this.erased.push(stroke);
        this.removeLocal(stroke.id);
        hit = true;
      }
    }
    if (hit) {
      this.redraw();
      this.onChange();
    }
  }

  private point(e: PointerEvent) {
    const rect = this.live.getBoundingClientRect();
    const pressure = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : FINGER_PRESSURE;
    return normalizePoint(e.clientX - rect.left, e.clientY - rect.top, pressure, rect.width, rect.height);
  }

  private cancelGesture(): void {
    if (this.activePointer !== null && this.live.hasPointerCapture(this.activePointer)) {
      this.live.releasePointerCapture(this.activePointer);
    }
    this.activePointer = null;
    this.current = null;
    if (this.erased.length) {
      this.undoStack.push({ kind: 'remove', strokes: this.erased });
      this.erased = [];
    }
    this.clearLive();
  }

  // ---------- Dibujo ----------

  private requestFrame(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.clearLive();
      if (this.current) drawStroke(this.liveCtx, this.current, this.width, this.height, false);
    });
  }

  private clearLive(): void {
    this.liveCtx.clearRect(0, 0, this.width, this.height);
  }

  private redraw(): void {
    this.baseCtx.clearRect(0, 0, this.width, this.height);
    drawStrokes(this.baseCtx, this.strokes, this.width, this.height);
  }

  /** Ajusta el pizarrón al espacio disponible conservando la proporción de la diapositiva. */
  private layout(): void {
    // clientWidth/Height incluyen el padding del área; el pizarrón debe caber en el contenido.
    const style = getComputedStyle(this.area);
    const aw = this.area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const ah = this.area.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (aw <= 0 || ah <= 0) return;
    let w = aw;
    let h = aw / this.aspect;
    if (h > ah) {
      h = ah;
      w = ah * this.aspect;
    }
    this.width = Math.floor(w);
    this.height = Math.floor(h);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.frame.style.width = `${this.width}px`;
    this.frame.style.height = `${this.height}px`;
    for (const [canvas, ctx] of [
      [this.base, this.baseCtx],
      [this.live, this.liveCtx],
    ] as const) {
      canvas.width = Math.round(this.width * this.dpr);
      canvas.height = Math.round(this.height * this.dpr);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    this.redraw();
    if (this.current) this.requestFrame();
  }
}
