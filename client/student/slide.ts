// Diapositiva a pantalla completa. Todas las imágenes se precargan una vez; cambiar de diapositiva
// solo cambia el `src` de una imagen ya en caché.
import { slideUrl } from '../../shared/slides.js';

const PRELOAD_CONCURRENCY = 3;

export class SlideView {
  private sessionId = '';
  private slideCount = 0;
  private current = 0;
  private readonly preloaded = new Map<number, HTMLImageElement>();
  private queue: number[] = [];
  private inFlight = 0;

  constructor(
    private readonly img: HTMLImageElement,
    private readonly status: HTMLElement,
    private readonly counter: HTMLElement,
  ) {
    img.addEventListener('load', () => (this.status.hidden = true));
    img.addEventListener('error', () => {
      this.status.textContent = 'No se pudo cargar la diapositiva. Reintentando…';
      this.status.hidden = false;
      window.setTimeout(() => this.show(this.current, true), 2000);
    });
  }

  /** Prepara la presentación de una sesión; si es la misma que ya está cargada no vuelve a descargar nada. */
  load(sessionId: string, slideCount: number, startIndex: number): void {
    if (sessionId === this.sessionId && slideCount === this.slideCount) return;
    this.sessionId = sessionId;
    this.slideCount = slideCount;
    this.preloaded.clear();
    // Primero las más cercanas a la actual, hacia adelante.
    this.queue = Array.from({ length: slideCount }, (_, i) => i).sort(
      (a, b) => distance(a, startIndex) - distance(b, startIndex),
    );
    this.pump();
  }

  show(index: number, force = false): void {
    if (!this.sessionId || index < 0 || index >= this.slideCount) return;
    this.current = index;
    this.counter.textContent = `${index + 1} / ${this.slideCount}`;
    const url = slideUrl(this.sessionId, index);
    if (!force && this.img.getAttribute('src') === url) return;
    const cached = this.preloaded.get(index);
    this.status.textContent = 'Cargando diapositiva…';
    this.status.hidden = Boolean(cached?.complete && cached.naturalWidth > 0);
    this.img.src = force ? `${url}?r=${Date.now()}` : url;
  }

  private pump(): void {
    while (this.inFlight < PRELOAD_CONCURRENCY && this.queue.length) {
      const index = this.queue.shift() as number;
      const sessionId = this.sessionId;
      const image = new Image();
      image.decoding = 'async';
      this.inFlight++;
      const done = () => {
        this.inFlight--;
        if (sessionId === this.sessionId) this.pump();
      };
      image.onload = done;
      image.onerror = done;
      image.src = slideUrl(sessionId, index);
      this.preloaded.set(index, image);
    }
  }
}

function distance(i: number, from: number): number {
  // Las siguientes pesan un poco menos que las anteriores: el profesor suele avanzar.
  return i >= from ? i - from : (from - i) * 1.5;
}
