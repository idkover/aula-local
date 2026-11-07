// Validación de preguntas, compartida por las preguntas en vivo (SessionStore) y las preparadas (ClassStore).
import type { QuestionType } from '../shared/types.js';

export const TIME_LIMIT_MAX_SEC = 3600;
export const PROMPT_MAX_LENGTH = 500;
export const TITLE_MAX_LENGTH = 120;
export const ID_RE = /^[\w-]{4,64}$/;

const QUESTION_TYPES: readonly QuestionType[] = ['blank', 'overSlide', 'text'];

export type QuestionSpec = { type: QuestionType; slideIndex?: number; timeLimitSec?: number; prompt?: string };

/**
 * Valida tipo, diapositiva, límite de tiempo y enunciado de una pregunta. El enunciado se recorta
 * y vacío equivale a no tenerlo. Devuelve undefined si algún campo es inválido.
 */
export function parseQuestionSpec(raw: unknown, slideCount: number): QuestionSpec | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { type, slideIndex, timeLimitSec, prompt } = raw as Record<string, unknown>;
  if (!QUESTION_TYPES.includes(type as QuestionType)) return undefined;
  if (slideIndex !== undefined && !(isInt(slideIndex) && slideIndex >= 0 && slideIndex < slideCount)) return undefined;
  if (timeLimitSec !== undefined && !(isInt(timeLimitSec) && timeLimitSec >= 1 && timeLimitSec <= TIME_LIMIT_MAX_SEC)) {
    return undefined;
  }
  if (prompt !== undefined && typeof prompt !== 'string') return undefined;

  const spec: QuestionSpec = { type: type as QuestionType };
  if (slideIndex !== undefined) spec.slideIndex = slideIndex;
  if (timeLimitSec !== undefined) spec.timeLimitSec = timeLimitSec;
  const cleanPrompt = prompt?.trim().slice(0, PROMPT_MAX_LENGTH);
  if (cleanPrompt) spec.prompt = cleanPrompt;
  return spec;
}

/** Título de clase: una línea, sin espacios repetidos, con largo máximo. */
export function cleanTitle(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_LENGTH) : '';
}

function isInt(n: unknown): n is number {
  return Number.isInteger(n);
}
