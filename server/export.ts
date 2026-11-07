// ZIP de respuestas de una sesión (Fase 4): un PNG por alumno y pregunta de pizarrón
// ("P1 - Ana López.png", el nombre solo en el nombre del archivo, nunca dibujado en la imagen) más
// `respuestas.csv` con una fila por alumno y pregunta (incluidas las respuestas de texto).
//
// Disposición elegida: todos los PNG en la raíz del ZIP, no en una carpeta por pregunta.
// - Cada archivo se explica solo aunque se arrastre fuera del ZIP ("P2 - Beto.png" sigue diciendo de
//   qué pregunta es), cosa que se perdería con "P2 - ¿Cuánto vale x?/Beto.png".
// - El número de pregunta con relleno (P01…) ordena los archivos por pregunta y luego por nombre.
// - El enunciado no va en ningún nombre (largo, con caracteres problemáticos): está en el CSV.
import { readFile } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import { ZipArchive } from 'archiver';
import { loadImage, createCanvas, Path2D, type Image } from '@napi-rs/canvas';
import { strokeOutline, traceOutline } from '../shared/freehand.js';
import type { Answer, Question, QuestionType, SessionRecord, StudentSummary } from '../shared/types.js';

export type ExportSource = {
  classTitle: string;
  record: SessionRecord;
  /** Alumnos en orden de llegada (id público y nombre). */
  roster: StudentSummary[];
  answers: (questionId: string) => Promise<Record<string, Answer>> | Record<string, Answer>;
  /** Ruta en disco del PNG de la diapositiva `index` de la clase. */
  slidePath: (index: number) => string;
};

export type ExportOptions = { csvSeparator?: ';' | ',' };

/** Nombre del archivo descargado, p. ej. "Álgebra 1 - 2026-10-30 13-40.zip". */
export function exportFileName(classTitle: string, startedAt: number): string {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
  return `${classTitle || 'Clase'} - ${stamp}.zip`;
}

// ---------- Nombres de archivo ----------

const MAX_NAME_CHARS = 80;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Nombre de alumno → nombre de archivo válido en Windows, macOS y Linux. Nunca devuelve vacío. */
export function safeFileName(name: string): string {
  let s = name
    .normalize('NFC')
    .replace(/\s+/g, ' ') // tabuladores y saltos de línea cuentan como espacio
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '')
    .replace(/ {2,}/g, ' ');
  const strip = (v: string) => v.replace(/[. ]+$/, '').replace(/^ +/, '');
  s = strip(s);
  // Límite por caracteres (no por unidades UTF-16, para no partir un emoji a la mitad).
  const chars = Array.from(s);
  if (chars.length > MAX_NAME_CHARS) s = strip(chars.slice(0, MAX_NAME_CHARS).join(''));
  if (!s) return 'Alumno';
  // Windows reserva "CON", "NUL"… también con extensión ("CON.txt").
  if (RESERVED_NAME.test(s.split('.')[0]?.trimEnd() ?? '')) s = `_${s}`;
  return s;
}

/**
 * Hace únicos los nombres sin distinguir mayúsculas (Windows y macOS no lo hacen): el segundo "Ana"
 * pasa a "Ana (2)", el tercero a "Ana (3)", en el orden recibido. `n` es el número de ocurrencia.
 */
function dedupe(names: readonly string[]): { name: string; n: number }[] {
  const taken = new Set<string>();
  return names.map((base) => {
    let n = 1;
    let name = base;
    while (taken.has(name.toLowerCase())) name = `${base} (${++n})`;
    taken.add(name.toLowerCase());
    return { name, n };
  });
}

export function dedupeNames(names: readonly string[]): string[] {
  return dedupe(names).map((d) => d.name);
}

// ---------- CSV ----------

export const CSV_BOM = '﻿';
const CSV_EOL = '\r\n';
export const CSV_HEADER = ['Pregunta', 'Tipo', 'Enunciado', 'Alumno', 'Entregó', 'Hora de entrega', 'Respuesta de texto'];

/**
 * Celda CSV (RFC 4180). Contra la inyección de fórmulas en Excel, lo que empiece con = + - @, tabulador
 * o retorno de carro lleva un apóstrofo delante.
 */
export function csvCell(value: string, separator: ';' | ',' = ';'): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return v.includes(separator) || /["\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** Fila CSV sin el fin de línea. */
export function csvRow(cells: readonly string[], separator: ';' | ',' = ';'): string {
  return cells.map((c) => csvCell(c, separator)).join(separator);
}

/** Hora local "YYYY-MM-DD HH:MM:SS". */
export function formatLocalTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const TYPE_LABELS: Record<QuestionType, string> = {
  overSlide: 'Pizarrón sobre la diapositiva',
  blank: 'Pizarrón en blanco',
  text: 'Respuesta de texto',
};

// ---------- PNG ----------

const FALLBACK_SIZE = { width: 1600, height: 900 };

const isBoard = (q: Question) => q.type !== 'text';
const hasWork = (a: Answer | undefined): a is Answer => !!a && (a.strokes.length > 0 || a.submittedAt !== undefined);

async function loadSlide(file: string): Promise<Image | null> {
  try {
    return await loadImage(await readFile(file));
  } catch {
    return null;
  }
}

async function renderPng(slide: Image | null, overSlide: boolean, strokes: Answer['strokes']): Promise<Buffer> {
  const width = slide?.width ?? FALLBACK_SIZE.width;
  const height = slide?.height ?? FALLBACK_SIZE.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  if (overSlide && slide) ctx.drawImage(slide, 0, 0, width, height);
  for (const stroke of strokes) {
    try {
      ctx.fillStyle = stroke.color;
      ctx.fill(traceOutline(new Path2D(), strokeOutline(stroke.points, stroke.size, width, height, true)));
    } catch {
      // Un trazo dañado no debe tirar toda la exportación.
    }
  }
  return canvas.encode('png');
}

// ---------- ZIP ----------

export async function writeSessionZip(out: Writable, src: ExportSource, opts: ExportOptions = {}): Promise<void> {
  const sep = opts.csvSeparator ?? ';';
  const questions = src.record.questions;
  const archive = new ZipArchive({ zlib: { level: 6 } });

  // `stop` se resuelve si el cliente abandona la descarga y se rechaza si el ZIP falla.
  let aborted = false;
  let stopResolve!: () => void;
  const stop = new Promise<'aborted'>((resolve, reject) => {
    stopResolve = () => resolve('aborted');
    archive.on('error', reject);
    out.once('error', reject);
  });
  stop.catch(() => undefined); // Evita "unhandled rejection" si el fallo llega entre awaits.
  const finish = new Promise<void>((resolve) => out.once('finish', resolve));
  out.once('close', () => {
    if (out.writableFinished) return;
    aborted = true;
    archive.abort();
    stopResolve();
  });
  archive.pipe(out);

  /** Espera a que archiver procese la entrada (así los PNG no se acumulan en memoria). */
  const add = async (data: Buffer, name: string, store: boolean): Promise<void> => {
    const entry = new Promise<void>((resolve) => archive.once('entry', () => resolve()));
    archive.append(data, { name, store });
    await Promise.race([entry, stop]);
  };

  // Alumnos: nombre de archivo único (igual en todas las preguntas) y nombre para el CSV.
  const unique = dedupe(src.roster.map((s) => safeFileName(s.name)));
  const csvName = src.roster.map((s, i) => {
    const n = unique[i]?.n ?? 1;
    return n > 1 ? `${s.name} (${n})` : s.name;
  });

  const padTo = questions.length >= 10 ? String(questions.length).length : 1;
  const csvLines = [csvRow(CSV_HEADER, sep)];
  const pngs: { name: string; question: Question; studentIndex: number }[] = [];
  const answersByQuestion = new Map<string, Record<string, Answer>>();

  for (const [qi, q] of questions.entries()) {
    const answers = await src.answers(q.id);
    answersByQuestion.set(q.id, answers);
    const num = qi + 1;
    for (const [si, student] of src.roster.entries()) {
      const a = answers[student.id];
      const submitted = a?.submittedAt !== undefined;
      csvLines.push(
        csvRow(
          [
            String(num),
            TYPE_LABELS[q.type],
            q.prompt?.trim() ?? '',
            csvName[si] ?? student.name,
            submitted ? 'sí' : 'no',
            a?.submittedAt !== undefined ? formatLocalTime(a.submittedAt) : '',
            a?.text ?? '',
          ],
          sep,
        ),
      );
      if (isBoard(q) && hasWork(a)) {
        pngs.push({ name: `P${String(num).padStart(padTo, '0')} - ${unique[si]?.name ?? 'Alumno'}.png`, question: q, studentIndex: si });
      }
    }
  }

  // El CSV va primero: es lo primero que se ve al abrir el ZIP.
  await add(Buffer.from(CSV_BOM + csvLines.join(CSV_EOL) + CSV_EOL, 'utf8'), 'respuestas.csv', false);

  // Un PNG a la vez; la diapositiva (decodificada) se conserva solo mientras se atiende su pregunta.
  let slideKey: number | undefined;
  let slide: Image | null = null;
  for (const item of pngs) {
    if (aborted) return;
    const q = item.question;
    const index = q.slideIndex ?? 0;
    if (slideKey !== index) {
      slide = await loadSlide(src.slidePath(index));
      slideKey = index;
    }
    const student = src.roster[item.studentIndex];
    const a = student && answersByQuestion.get(q.id)?.[student.id];
    if (!a) continue;
    const png = await renderPng(slide, q.type === 'overSlide', a.strokes);
    if (aborted) return;
    await add(png, item.name, true);
    if (aborted) return;
  }

  if (aborted) return;
  const finalized = archive.finalize();
  finalized.catch(() => undefined);
  await Promise.race([Promise.all([finalized, finish]), stop]);
}
