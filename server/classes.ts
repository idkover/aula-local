// Biblioteca de clases preparadas en data/classes/<id>/: class.json, original.pdf y slides/<n>.png.
// Una clase se arma en una carpeta temporal (.tmp-<id>) y se publica con un rename cuando la conversión
// termina, así la lista nunca muestra una clase a medias. El PDF de una clase no cambia: las diapositivas
// se sirven como inmutables, así que un PDF nuevo es una clase nueva.
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClassInfo, PreparedQuestion } from '../shared/types.js';
import { readJson, writeJsonAtomic } from './files.js';
import { convertPdfToPngs } from './pdf.js';
import { cleanTitle, ID_RE, parseQuestionSpec } from './validate.js';

/** Mismo formato que los ids de sesión: ambos pueden aparecer en /slides/<id>/. */
export const DECK_ID_RE = /^[a-f0-9]{12}$/;
export const MAX_PREPARED_QUESTIONS = 200;

export type UpdateOutcome = { ok: true; info: ClassInfo } | { ok: false; error: string };

export class ClassStore {
  private readonly root: string;
  private readonly cache = new Map<string, ClassInfo>();

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'classes');
  }

  dir(id: string): string {
    return path.join(this.root, id);
  }

  slidesDir(id: string): string {
    return path.join(this.dir(id), 'slides');
  }

  /** Convierte el PDF y guarda la clase. Si la conversión falla no queda nada en disco. */
  async create(pdf: Buffer, title: string, now = Date.now()): Promise<ClassInfo> {
    await mkdir(this.root, { recursive: true });
    const id = randomBytes(6).toString('hex');
    const tmp = path.join(this.root, `.tmp-${id}`);
    try {
      await mkdir(tmp, { recursive: true });
      const pdfPath = path.join(tmp, 'original.pdf');
      await writeFile(pdfPath, pdf);
      const { pageCount } = await convertPdfToPngs(pdfPath, path.join(tmp, 'slides'));
      const info: ClassInfo = { id, title: cleanTitle(title), createdAt: now, updatedAt: now, slideCount: pageCount, questions: [] };
      await writeJsonAtomic(path.join(tmp, 'class.json'), info);
      await rename(tmp, this.dir(id));
      this.cache.set(id, info);
      return info;
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw err;
    }
  }

  async get(id: string): Promise<ClassInfo | undefined> {
    if (!DECK_ID_RE.test(id)) return undefined;
    const cached = this.cache.get(id);
    if (cached) return cached;
    const info = await readJson<ClassInfo>(path.join(this.dir(id), 'class.json'));
    if (info) this.cache.set(id, info);
    return info;
  }

  /** Clases publicadas, la más recientemente editada primero (ignora las carpetas temporales). */
  async list(): Promise<ClassInfo[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const infos = await Promise.all(names.filter((n) => DECK_ID_RE.test(n)).map((n) => this.get(n)));
    return infos.filter((c): c is ClassInfo => Boolean(c)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Reemplaza título y preguntas preparadas (documento completo), validando cada pregunta. */
  async update(id: string, raw: unknown, now = Date.now()): Promise<UpdateOutcome | undefined> {
    const info = await this.get(id);
    if (!info) return undefined;
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Datos inválidos.' };
    const { title, questions } = raw as Record<string, unknown>;
    const parsed = parsePreparedQuestions(questions, info.slideCount);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    const updated: ClassInfo = { ...info, title: cleanTitle(title), questions: parsed, updatedAt: now };
    await writeJsonAtomic(path.join(this.dir(id), 'class.json'), updated);
    this.cache.set(id, updated);
    return { ok: true, info: updated };
  }

  /** Borra la clase con su PDF, diapositivas e historial. */
  async delete(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    this.cache.delete(id);
    await rm(this.dir(id), { recursive: true, force: true });
    return true;
  }
}

/** Valida la lista de preguntas preparadas; devuelve el mensaje de error si alguna es inválida. */
function parsePreparedQuestions(raw: unknown, slideCount: number): PreparedQuestion[] | string {
  if (!Array.isArray(raw)) return 'Faltan las preguntas.';
  if (raw.length > MAX_PREPARED_QUESTIONS) return `Máximo ${MAX_PREPARED_QUESTIONS} preguntas por clase.`;
  const seen = new Set<string>();
  const out: PreparedQuestion[] = [];
  for (const item of raw as unknown[]) {
    const id = (item as { id?: unknown } | null)?.id;
    const spec = parseQuestionSpec(item, slideCount);
    if (!spec || spec.slideIndex === undefined || typeof id !== 'string' || !ID_RE.test(id) || seen.has(id)) {
      return 'Hay una pregunta preparada inválida.';
    }
    seen.add(id);
    const question: PreparedQuestion = { id, slideIndex: spec.slideIndex, type: spec.type };
    if (spec.timeLimitSec !== undefined) question.timeLimitSec = spec.timeLimitSec;
    if (spec.prompt !== undefined) question.prompt = spec.prompt;
    out.push(question);
  }
  // Orden por diapositiva; dentro de una diapositiva se conserva el orden del profesor.
  return out.map((q, i) => ({ q, i })).sort((a, b) => a.q.slideIndex - b.q.slideIndex || a.i - b.i).map(({ q }) => q);
}
