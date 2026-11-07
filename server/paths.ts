// Ubicación de la raíz del proyecto (la carpeta con package.json), igual en desarrollo y en el instalador.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Sube desde esta carpeta hasta encontrar el package.json del proyecto. */
export function findProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
  return dir;
}
