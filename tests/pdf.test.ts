import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertPdfToPngs, hasPdftoppm, SLIDE_WIDTH_PX } from '../server/pdf.js';
import { makePdf, pngSize } from './helpers.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'aula-pdf-'));
const popplerInstalled = await hasPdftoppm();
afterAll(() => rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe('convertPdfToPngs', () => {
  it('convierte cada página a un PNG de 1600 px de ancho con pdfjs-dist', async () => {
    const pdf = path.join(tmp, 'deck.pdf');
    await writeFile(pdf, makePdf(3));
    const out = path.join(tmp, 'slides');

    const result = await convertPdfToPngs(pdf, out, { engine: 'pdfjs' });

    expect(result).toEqual({ pageCount: 3, engine: 'pdfjs' });
    expect((await readdir(out)).sort()).toEqual(['0.png', '1.png', '2.png']);
    const size = pngSize(await readFile(path.join(out, '0.png')));
    expect(size.width).toBe(SLIDE_WIDTH_PX);
    expect(size.height).toBe(Math.round((SLIDE_WIDTH_PX * 612) / 792));
  }, 30_000);

  it.runIf(popplerInstalled)('también funciona con pdftoppm (Poppler) si está instalado', async () => {
    const pdf = path.join(tmp, 'deck2.pdf');
    await writeFile(pdf, makePdf(2));
    const out = path.join(tmp, 'slides2');
    const result = await convertPdfToPngs(pdf, out, { engine: 'pdftoppm' });
    expect(result.pageCount).toBe(2);
    expect(pngSize(await readFile(path.join(out, '1.png'))).width).toBe(SLIDE_WIDTH_PX);
  }, 30_000);

  it('falla con un archivo que no es PDF', async () => {
    const bad = path.join(tmp, 'bad.pdf');
    await writeFile(bad, 'esto no es un pdf');
    await expect(convertPdfToPngs(bad, path.join(tmp, 'bad'), { engine: 'pdfjs' })).rejects.toThrow();
  });
});
