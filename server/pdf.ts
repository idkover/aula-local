// PDF → un PNG por página (~1600 px de ancho), generado una sola vez por sesión.
// Usa `pdftoppm` (Poppler) si está instalado; si no, pdfjs-dist + @napi-rs/canvas.
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export const SLIDE_WIDTH_PX = 1600;

export type PdfEngine = 'pdftoppm' | 'pdfjs';

export type ConvertOptions = { engine?: PdfEngine; width?: number };

/** Convierte `pdfPath` en `outDir/0.png`, `outDir/1.png`, … y devuelve el número de páginas. */
export async function convertPdfToPngs(
  pdfPath: string,
  outDir: string,
  options: ConvertOptions = {},
): Promise<{ pageCount: number; engine: PdfEngine }> {
  const width = options.width ?? SLIDE_WIDTH_PX;
  const engine = options.engine ?? ((await hasPdftoppm()) ? 'pdftoppm' : 'pdfjs');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const pageCount =
    engine === 'pdftoppm'
      ? await convertWithPdftoppm(pdfPath, outDir, width)
      : await convertWithPdfjs(pdfPath, outDir, width);
  if (pageCount < 1) throw new Error('El PDF no tiene páginas.');
  return { pageCount, engine };
}

let pdftoppmAvailable: Promise<boolean> | undefined;

export function hasPdftoppm(): Promise<boolean> {
  pdftoppmAvailable ??= new Promise((resolve) => {
    const child = spawn('pdftoppm', ['-v'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 || code === 99));
  });
  return pdftoppmAvailable;
}

async function convertWithPdftoppm(pdfPath: string, outDir: string, width: number): Promise<number> {
  await run('pdftoppm', ['-png', '-scale-to-x', String(width), '-scale-to-y', '-1', pdfPath, path.join(outDir, 'p')]);
  // pdftoppm nombra p-1.png o p-01.png según el número de páginas; normalizamos a 0.png, 1.png…
  const pages = (await readdir(outDir))
    .map((file) => ({ file, n: Number(/^p-(\d+)\.png$/.exec(file)?.[1]) }))
    .filter((p) => Number.isInteger(p.n))
    .sort((a, b) => a.n - b.n);
  for (const [i, page] of pages.entries()) {
    await rename(path.join(outDir, page.file), path.join(outDir, `${i}.png`));
  }
  return pages.length;
}

async function convertWithPdfjs(pdfPath: string, outDir: string, width: number): Promise<number> {
  const require = createRequire(import.meta.url);
  const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');

  // Recursos locales de pdfjs (fuentes estándar, cmaps, wasm): nada se pide a internet.
  const dirUrl = (sub: string) => path.join(pdfjsRoot, sub).replaceAll('\\', '/') + '/';
  const loadingTask = getDocument({
    data: new Uint8Array(await readFile(pdfPath)),
    standardFontDataUrl: dirUrl('standard_fonts'),
    cMapUrl: dirUrl('cmaps'),
    cMapPacked: true,
    wasmUrl: dirUrl('wasm'),
    iccUrl: dirUrl('iccs'),
    verbosity: 0,
  });

  try {
    const doc = await loadingTask.promise;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });
      const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Los tipos de pdfjs esperan un canvas del DOM; @napi-rs/canvas es compatible en Node.
      const params = { canvas, canvasContext: ctx, viewport } as unknown as Parameters<typeof page.render>[0];
      await page.render(params).promise;
      await writeFile(path.join(outDir, `${n - 1}.png`), await canvas.encode('png'));
      page.cleanup();
    }
    return doc.numPages;
  } finally {
    await loadingTask.destroy();
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} terminó con código ${code}: ${stderr.trim()}`)),
    );
  });
}
