/** URL pública de una diapositiva. Inmutable por sesión, así que el navegador la cachea una sola vez. */
export function slideUrl(sessionId: string, index: number): string {
  return `/slides/${encodeURIComponent(sessionId)}/${index}.png`;
}
