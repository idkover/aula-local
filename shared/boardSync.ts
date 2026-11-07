// Dibujo sin conexión: el tablero local del alumno es la verdad mientras la pregunta siga abierta, y
// al (re)unirse se reconcilia con lo que tiene el servidor. Sin DOM, para usarlo igual en el cliente
// (client/student/main.ts) y en las pruebas.
//
// Funciona porque las operaciones del servidor son idempotentes por id de trazo: `stroke:add` ignora ids
// repetidos, `stroke:remove` ignora ids que no existen y `board:clear` se puede repetir. Por eso no hace
// falta una cola de operaciones (que se perdería en la ventana de ~18 s en la que el cliente aún no nota
// la caída, o con los eventos que socket.io reenvía antes del `student:join`): basta comparar estados.
import { MAX_STROKES_PER_ANSWER, MAX_TEXT_LENGTH, parseStroke } from './strokes.js';
import type {
  AckResult,
  AnswerSubmitPayload,
  QuestionRefPayload,
  Stroke,
  StrokeAddPayload,
  StrokeRemovePayload,
} from './types.js';

// ---------- Comparación de tableros ----------

export type BoardDiff = {
  /** Vaciar el pizarrón del servidor (el local quedó vacío). Si es true, `remove` y `add` van vacíos. */
  clear: boolean;
  /** Ids que solo tiene el servidor. */
  remove: string[];
  /** Trazos que solo tiene el alumno, en el orden del tablero local. */
  add: Stroke[];
};

/** Qué le falta al servidor para quedar igual que el tablero local. Solo compara ids. */
export function diffBoard(local: readonly Stroke[], server: readonly Stroke[]): BoardDiff {
  if (local.length === 0) return { clear: server.length > 0, remove: [], add: [] };
  const localIds = new Set(local.map((s) => s.id));
  const serverIds = new Set(server.map((s) => s.id));
  return {
    clear: false,
    remove: [...serverIds].filter((id) => !localIds.has(id)),
    add: local.filter((s) => !serverIds.has(s.id)),
  };
}

export function isEmptyDiff(diff: BoardDiff): boolean {
  return !diff.clear && diff.remove.length === 0 && diff.add.length === 0;
}

// ---------- Reconciliación ----------

/** Cómo salen los eventos hacia el servidor. En el navegador es el socket; en las pruebas, un registro. */
export interface SyncChannel {
  strokeAdd(payload: StrokeAddPayload): void;
  strokeRemove(payload: StrokeRemovePayload): void;
  boardClear(payload: QuestionRefPayload): void;
  /** Rechaza si el servidor no responde a tiempo. */
  answerSubmit(payload: AnswerSubmitPayload): Promise<AckResult>;
}

export type ReconcileInput = {
  questionId: string;
  /** Tablero local (la verdad del alumno). */
  local: readonly Stroke[];
  /** Trazos que el servidor dice tener (`state:sync.myAnswer.strokes`). */
  server: readonly Stroke[];
  channel: SyncChannel;
  /** Presente si había una entrega pendiente: se envía justo después de los trazos. */
  submit?: { text?: string };
};

export type ReconcileResult = {
  diff: BoardDiff;
  /** Respuesta del servidor a la entrega pendiente (si había una). Rechaza si no hubo respuesta a tiempo. */
  submitted?: Promise<AckResult>;
};

/**
 * Deja el servidor igual que el tablero local y, si había una entrega pendiente, la envía.
 * Todos los eventos salen de forma síncrona: quien la llama puede marcar el estado como sincronizado
 * en el mismo turno, sin que se cuele una edición entre la comparación y el envío.
 */
export function reconcileBoard(input: ReconcileInput): ReconcileResult {
  const { questionId, channel } = input;
  const diff = diffBoard(input.local, input.server);
  if (diff.clear) channel.boardClear({ questionId });
  for (const strokeId of diff.remove) channel.strokeRemove({ questionId, strokeId });
  for (const stroke of diff.add) channel.strokeAdd({ questionId, stroke });
  if (!input.submit) return { diff };
  const payload: AnswerSubmitPayload =
    input.submit.text === undefined ? { questionId } : { questionId, text: input.submit.text };
  return { diff, submitted: channel.answerSubmit(payload) };
}

// ---------- Estado local persistido ----------

export const BOARD_KEY_PREFIX = 'aula.board.';

/** Lo que el dispositivo guarda de una pregunta abierta, para sobrevivir a recargar la pestaña. */
export type LocalBoardState = {
  v: 1;
  strokes: Stroke[];
  /** Respuesta escrita (preguntas de texto). */
  text?: string;
  /** El alumno pulsó "Entregar" sin conexión: se envía al volver. */
  pendingSubmit: boolean;
  /** Ya había entregado antes (sirve para reenviar si el servidor perdió la entrega). */
  submitted?: boolean;
  /** Hubo cambios que el servidor aún podía no tener. */
  dirty?: boolean;
  savedAt: number;
};

export function boardKey(sessionId: string, questionId: string): string {
  return `${BOARD_KEY_PREFIX}${sessionId}.${questionId}`;
}

export function serializeBoardState(state: LocalBoardState): string {
  return JSON.stringify(state);
}

/** Lee un estado guardado. Devuelve undefined si no existe o está dañado; descarta trazos inválidos. */
export function parseBoardState(raw: string | null | undefined): LocalBoardState | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { v, strokes, text, pendingSubmit, submitted, dirty, savedAt } = value as Record<string, unknown>;
  if (v !== 1 || !Array.isArray(strokes) || typeof pendingSubmit !== 'boolean') return undefined;
  if (text !== undefined && typeof text !== 'string') return undefined;
  if (submitted !== undefined && typeof submitted !== 'boolean') return undefined;
  if (dirty !== undefined && typeof dirty !== 'boolean') return undefined;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return undefined;

  const seen = new Set<string>();
  const clean: Stroke[] = [];
  for (const candidate of strokes as unknown[]) {
    const stroke = parseStroke(candidate);
    if (!stroke || seen.has(stroke.id)) continue;
    seen.add(stroke.id);
    clean.push(stroke);
    if (clean.length >= MAX_STROKES_PER_ANSWER) break;
  }
  const state: LocalBoardState = { v: 1, strokes: clean, pendingSubmit, savedAt };
  if (text !== undefined) state.text = text.slice(0, MAX_TEXT_LENGTH);
  if (submitted !== undefined) state.submitted = submitted;
  if (dirty !== undefined) state.dirty = dirty;
  return state;
}

/** De todas las claves del almacenamiento, las de tableros guardados que ya no sirven (todas menos `keep`). */
export function staleBoardKeys(allKeys: readonly string[], keep?: string): string[] {
  return allKeys.filter((key) => key.startsWith(BOARD_KEY_PREFIX) && key !== keep);
}
