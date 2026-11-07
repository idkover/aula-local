// ZIP de respuestas: nombres seguros, CSV y exportación completa leída con fflate.
import { PassThrough, Writable } from 'node:stream';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  csvCell,
  csvRow,
  dedupeNames,
  exportFileName,
  formatLocalTime,
  safeFileName,
  writeSessionZip,
} from '../server/export.js';
import type { ClassInfo, SessionInfo, Stroke } from '../shared/types.js';
import { makePdf, pngSize } from './helpers.js';
import { Harness, next, nextWhere, type StudentSocket, type TeacherSocket } from './harness.js';

describe('safeFileName', () => {
  it('quita los caracteres prohibidos en Windows y los de control', () => {
    expect(safeFileName('a<b>c:d"e/f\\g|h?i*j')).toBe('abcdefghij');
    expect(safeFileName('Ana\u0000\u0007\n\tLópez')).toBe('Ana López');
  });

  it('conserva acentos, eñes y emojis, y normaliza a NFC', () => {
    expect(safeFileName('María Núñez')).toBe('María Núñez');
    const nfd = 'José'; // "José" descompuesto
    expect(safeFileName(nfd)).toBe('José');
    expect(safeFileName(nfd).length).toBe(4);
    expect(safeFileName('Ana 🙂')).toBe('Ana 🙂');
  });

  it('colapsa espacios y quita puntos y espacios finales', () => {
    expect(safeFileName('  Ana    López  ')).toBe('Ana López');
    expect(safeFileName('Ana...')).toBe('Ana');
    expect(safeFileName('Ana . . ')).toBe('Ana');
  });

  it('antepone _ a los nombres reservados de Windows, también con extensión', () => {
    for (const name of ['CON', 'prn', 'Aux', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9', 'con.txt', 'NUL.tar.gz']) {
      expect(safeFileName(name)).toBe(`_${name}`);
    }
    expect(safeFileName('COM0')).toBe('COM0');
    expect(safeFileName('Console')).toBe('Console');
    expect(safeFileName('CON:')).toBe('_CON');
  });

  it('limita el largo sin partir caracteres y vuelve a limpiar el final', () => {
    const long = safeFileName('x'.repeat(300));
    expect(long).toHaveLength(80);
    const emojis = safeFileName('😀'.repeat(200));
    expect(Array.from(emojis)).toHaveLength(80);
    expect(safeFileName(`${'a'.repeat(79)}. b`)).toBe('a'.repeat(79));
  });

  it('un nombre vacío o que se queda sin nada pasa a "Alumno"', () => {
    for (const name of ['', '   ', '...', '<>:"/\\|?*', '\u0000']) expect(safeFileName(name)).toBe('Alumno');
  });
});

describe('dedupeNames', () => {
  it('añade (2), (3)… sin distinguir mayúsculas y en orden de llegada', () => {
    expect(dedupeNames(['Ana López', 'ana lópez', 'Beto', 'ANA LÓPEZ'])).toEqual([
      'Ana López',
      'ana lópez (2)',
      'Beto',
      'ANA LÓPEZ (3)',
    ]);
  });

  it('no choca con un nombre que ya parecía una repetición', () => {
    expect(dedupeNames(['Ana', 'Ana (2)', 'Ana'])).toEqual(['Ana', 'Ana (2)', 'Ana (3)']);
  });
});

describe('CSV', () => {
  it('cita solo lo necesario (RFC 4180)', () => {
    expect(csvCell('hola')).toBe('hola');
    expect(csvCell('dos; partes')).toBe('"dos; partes"');
    expect(csvCell('dos; partes', ',')).toBe('dos; partes');
    expect(csvCell('a,b', ',')).toBe('"a,b"');
    expect(csvCell('dijo "hola"')).toBe('"dijo ""hola"""');
    expect(csvCell('línea 1\nlínea 2')).toBe('"línea 1\nlínea 2"');
    expect(csvCell('x\r\ny')).toBe('"x\r\ny"');
    expect(csvCell('')).toBe('');
  });

  it('evita la inyección de fórmulas', () => {
    for (const bad of ['=1+1', '+SUMA(A1)', '-2', '@usuario', '\tx', '\rx']) {
      const cell = csvCell(bad);
      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
    }
    expect(csvCell('=HYPERLINK("x";"y")')).toBe(`"'=HYPERLINK(""x"";""y"")"`);
    expect(csvCell('a=b')).toBe('a=b');
  });

  it('arma filas con el separador pedido', () => {
    expect(csvRow(['a', 'b;c', ''], ';')).toBe('a;"b;c";');
    expect(csvRow(['a', 'b;c', 'd,e'], ',')).toBe('a,b;c,"d,e"');
  });

  it('da la hora local como YYYY-MM-DD HH:MM:SS', () => {
    expect(formatLocalTime(new Date(2026, 9, 30, 8, 5, 9).getTime())).toBe('2026-10-30 08:05:09');
  });
});

describe('exportFileName', () => {
  it('usa título y fecha local', () => {
    expect(exportFileName('Álgebra 1', new Date(2026, 9, 30, 13, 40).getTime())).toBe('Álgebra 1 - 2026-10-30 13-40.zip');
    expect(exportFileName('', new Date(2026, 0, 2, 3, 4).getTime())).toBe('Clase - 2026-01-02 03-04.zip');
  });
});

describe('writeSessionZip (sin servidor)', () => {
  const src = {
    classTitle: 'Prueba',
    record: {
      id: 's1',
      classId: 'c1',
      startedAt: 0,
      students: [],
      questions: [{ id: 'q1', type: 'blank' as const, openedAt: 0, closed: true }],
    },
    roster: [{ id: 'a', name: 'Ana', connected: true }],
    answers: () => ({
      a: { strokes: [{ id: 's', color: '#000000', size: 20, points: [[0.1, 0.1, 0.5], [0.9, 0.9, 0.5]] as [number, number, number][] }] },
    }),
    slidePath: () => 'no-existe.png', // sin diapositiva: lienzo de respaldo
  };

  it('escribe un ZIP completo en un Writable cualquiera', async () => {
    const chunks: Buffer[] = [];
    const out = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });
    await writeSessionZip(out, src);
    const files = unzipSync(new Uint8Array(Buffer.concat(chunks)));
    expect(Object.keys(files).sort()).toEqual(['P1 - Ana.png', 'respuestas.csv']);
  });

  it('si el cliente corta la descarga, termina sin lanzar error', async () => {
    const out = new PassThrough();
    out.resume();
    const big = { ...src, record: { ...src.record, questions: Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, type: 'blank' as const, openedAt: 0, closed: true })) } };
    const run = writeSessionZip(out, big);
    setTimeout(() => out.destroy(), 20);
    await expect(run).resolves.toBeUndefined();
  });
});

// ---------- Integración ----------

const h = new Harness();
let klass: ClassInfo;
let session: SessionInfo;
const drawing = (id: string, x: number, y = 0.5): Stroke => ({
  id,
  color: '#ff0000',
  size: 60,
  points: [[x, y, 0.5], [x + 0.1, y, 0.5], [x + 0.2, y + 0.02, 0.5]],
});

beforeAll(async () => {
  await h.boot();
}, 30_000);

afterAll(() => h.stop());

async function pixels(png: Uint8Array) {
  const img = await loadImage(Buffer.from(png));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const at = (x: number, y: number) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data);
  return { width: img.width, height: img.height, at };
}

describe('Exportación de una clase', () => {
  const answerText = '=1+1; "cuatro"\nsegunda línea';

  it('prepara la clase: dos Ana, Beto, una pregunta sobre la diapositiva, una en blanco y una de texto', async () => {
    klass = await h.api<ClassInfo>('POST', `/api/classes?title=${encodeURIComponent('Álgebra 1')}`, makePdf(2), 201);
    session = await h.api<SessionInfo>('POST', `/api/classes/${klass.id}/sessions`, undefined, 201);

    const teacher = h.open<TeacherSocket>('/teacher', { sessionId: session.sessionId });
    await next(teacher, 'state:sync');
    const join = async (clientId: string, name: string): Promise<StudentSocket> => (await h.joinStudent(clientId, name, session.code)).socket;
    const ana1 = await join('client-ana1-00001', 'Ana');
    const ana2 = await join('client-ana2-00002', 'Ana');
    const beto = await join('client-beto-00003', 'Beto');

    const open = async (payload: { id: string; type: 'overSlide' | 'blank' | 'text'; slideIndex?: number; prompt?: string }) => {
      const seen = next(beto, 'question:open');
      teacher.emit('question:open', payload);
      await seen;
    };
    const draw = async (socket: StudentSocket, questionId: string, stroke: Stroke) => {
      const seen = nextWhere<{ stroke: Stroke }>(teacher, 'stroke:add', (p) => p.stroke.id === stroke.id);
      socket.emit('stroke:add', { questionId, stroke });
      await seen;
    };
    const submit = (socket: StudentSocket, questionId: string, text?: string) =>
      new Promise((resolve) => socket.emit('answer:submit', { questionId, ...(text !== undefined ? { text } : {}) }, resolve));

    // P1: sobre la diapositiva 1. Ana#1 dibuja y entrega; Ana#2 solo dibuja; Beto no hace nada.
    await open({ id: 'q-over', type: 'overSlide', slideIndex: 1, prompt: 'Marca la incógnita' });
    await draw(ana1, 'q-over', drawing('stroke-ana1', 0.3, 0.85));
    await submit(ana1, 'q-over');
    await draw(ana2, 'q-over', drawing('stroke-ana2', 0.3, 0.85));

    // P2: en blanco. Beto dibuja; Ana#1 entrega sin trazos.
    await open({ id: 'q-blank', type: 'blank' });
    await draw(beto, 'q-blank', drawing('stroke-beto', 0.2));
    await submit(ana1, 'q-blank');

    // P3: texto. Solo Beto responde.
    await open({ id: 'q-text', type: 'text', prompt: '¿Cuánto vale x?' });
    await submit(beto, 'q-text', answerText);
  }, 30_000);

  it('el ZIP trae los PNG con nombres únicos y el CSV con las respuestas', async () => {
    const t0 = performance.now();
    const res = await fetch(`${h.base}/api/classes/${klass.id}/sessions/${session.sessionId}/export.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(decodeURIComponent(res.headers.get('content-disposition') ?? '')).toContain('Álgebra 1 - ');
    const zip = new Uint8Array(await res.arrayBuffer());
    const elapsed = Math.round(performance.now() - t0);
    console.info(`ZIP de prueba: ${zip.length} bytes en ${elapsed} ms`);
    const files = unzipSync(zip);

    const names = Object.keys(files).sort();
    expect(names).toEqual(['P1 - Ana (2).png', 'P1 - Ana.png', 'P2 - Ana.png', 'P2 - Beto.png', 'respuestas.csv']);
    // La respuesta de texto y los enunciados no están en ningún nombre de archivo.
    expect(names.join('|')).not.toMatch(/=1\+1|cuatro|incógnita/);

    const csvBytes = files['respuestas.csv'] as Uint8Array;
    expect(Array.from(csvBytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csv = strFromU8(csvBytes.slice(3));
    expect(csv.endsWith('\r\n')).toBe(true);
    // Todos los saltos de línea fuera de las comillas son CRLF; el de la respuesta va entre comillas.
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Pregunta;Tipo;Enunciado;Alumno;Entregó;Hora de entrega;Respuesta de texto');
    expect(lines.at(-1)).toBe('');

    const time = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;
    const rows = lines.slice(1, -1);
    // 3 preguntas × 3 alumnos, aunque no respondan (la respuesta de texto tiene un salto de línea interno).
    expect(csv.split('\r\n').length).toBeGreaterThanOrEqual(11);
    const text = (needle: string) => rows.filter((r) => r.startsWith(needle));
    const over = text('1;Pizarrón sobre la diapositiva;Marca la incógnita;');
    expect(over).toHaveLength(3);
    expect(over[0]).toMatch(/^1;Pizarrón sobre la diapositiva;Marca la incógnita;Ana;sí;\d{4}/);
    expect(over[0]).toMatch(time);
    expect(over[1]).toBe('1;Pizarrón sobre la diapositiva;Marca la incógnita;Ana (2);no;;');
    expect(over[2]).toBe('1;Pizarrón sobre la diapositiva;Marca la incógnita;Beto;no;;');
    expect(text('2;Pizarrón en blanco;;')).toHaveLength(3);
    expect(csv).toContain('2;Pizarrón en blanco;;Beto;no;;'); // dibujó pero no entregó
    expect(csv).toContain('2;Pizarrón en blanco;;Ana;sí;');
    // Texto: comillas dobladas, fórmula neutralizada y salto de línea dentro de comillas.
    expect(csv).toContain(`3;Respuesta de texto;¿Cuánto vale x?;Beto;sí;`);
    expect(csv).toContain(`"'=1+1; ""cuatro""\nsegunda línea"`);
    expect(csv).toContain('3;Respuesta de texto;¿Cuánto vale x?;Ana;no;;');
    // El texto no se coló en ningún PNG: ninguna entrada PNG lo contiene como nombre ni como bytes legibles.
    for (const name of names.filter((n) => n.endsWith('.png'))) {
      expect(Buffer.from(files[name] as Uint8Array).includes('cuatro')).toBe(false);
    }
  }, 30_000);

  it('?sep=comma cambia el separador del CSV', async () => {
    const res = await fetch(`${h.base}/api/classes/${klass.id}/sessions/${session.sessionId}/export.zip?sep=comma`);
    const csv = strFromU8((unzipSync(new Uint8Array(await res.arrayBuffer()))['respuestas.csv'] as Uint8Array).slice(3));
    expect(csv.split('\r\n')[0]).toBe('Pregunta,Tipo,Enunciado,Alumno,Entregó,Hora de entrega,Respuesta de texto');
  });

  it('los PNG respetan la diapositiva: sobre ella mide igual y los trazos se ven; en blanco empieza blanco', async () => {
    const slide = Buffer.from(await (await fetch(`${h.base}/slides/${klass.id}/1.png`)).arrayBuffer());
    const size = pngSize(slide);
    const res = await fetch(`${h.base}/api/classes/${klass.id}/sessions/${session.sessionId}/export.zip`);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));

    const over = await pixels(files['P1 - Ana.png'] as Uint8Array);
    expect({ width: over.width, height: over.height }).toEqual(size);
    // Sobre la diapositiva 1 (blanca con un "2" en el centro): el trazo rojo pasa por (0.4, 0.85).
    const red = over.at(0.4 * over.width, 0.85 * over.height);
    expect(red.slice(0, 3)).toEqual([255, 0, 0]);
    expect(over.at(2, 2).slice(0, 3)).toEqual([255, 255, 255]);
    // Los trazos se pintan encima de la diapositiva: el "2" original sigue donde no hay trazo.
    let dark = 0;
    for (let x = 0.36 * over.width; x < 0.5 * over.width; x += 2) {
      for (let y = 0.35 * over.height; y < 0.6 * over.height; y += 2) if ((over.at(x, y)[0] ?? 255) < 100) dark++;
    }
    expect(dark).toBeGreaterThan(0);

    // El segundo Ana (solo dibujó, sin entregar) también tiene su PNG, con su propio trazo.
    const ana2 = await pixels(files['P1 - Ana (2).png'] as Uint8Array);
    expect(ana2.at(0.4 * ana2.width, 0.85 * ana2.height).slice(0, 3)).toEqual([255, 0, 0]);

    const blank = await pixels(files['P2 - Beto.png'] as Uint8Array);
    expect({ width: blank.width, height: blank.height }).toEqual(pngSize(slide)); // mismo tamaño que las diapositivas
    expect(blank.at(0, 0)).toEqual([255, 255, 255, 255]);
    expect(blank.at(0.3 * blank.width, 0.5 * blank.height).slice(0, 3)).toEqual([255, 0, 0]);

    // Entregó sin dibujar: lienzo en blanco completo.
    const empty = await pixels(files['P2 - Ana.png'] as Uint8Array);
    expect(empty.at(0.3 * empty.width, 0.5 * empty.height)).toEqual([255, 255, 255, 255]);
  }, 30_000);

  it('una sesión inexistente responde 404', async () => {
    const res = await fetch(`${h.base}/api/classes/${klass.id}/sessions/no-existe/export.zip`);
    expect(res.status).toBe(404);
  });
});
