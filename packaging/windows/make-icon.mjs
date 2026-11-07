// Genera el icono de aula-local (.ico con 16, 32, 48 y 256 px) sin depender de fuentes.
// Uso directo: node packaging/windows/make-icon.mjs <salida.ico>
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

export const TAMANOS = [16, 32, 48, 256];
const VERDE = '#1f7a4d';

// Rectángulo con esquinas redondeadas (sin depender de roundRect).
function rutaRedondeada(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Dibuja el icono en un lienzo de n × n píxeles. El diseño usa una rejilla de 64 × 64.
function dibujar(n) {
  const canvas = createCanvas(n, n);
  const ctx = canvas.getContext('2d');
  const u = n / 64;

  // Fondo verde redondeado.
  rutaRedondeada(ctx, 0, 0, 64 * u, 64 * u, 14 * u);
  ctx.fillStyle = VERDE;
  ctx.fill();

  // Pizarrón blanco (marco) con un trazo de gráfico dentro.
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 5 * u;
  rutaRedondeada(ctx, 12 * u, 14 * u, 40 * u, 28 * u, 4 * u);
  ctx.stroke();

  ctx.lineWidth = 4 * u;
  ctx.beginPath();
  ctx.moveTo(20 * u, 34 * u);
  ctx.lineTo(28 * u, 26 * u);
  ctx.lineTo(34 * u, 31 * u);
  ctx.lineTo(44 * u, 21 * u);
  ctx.stroke();

  // Soporte del pizarrón.
  ctx.beginPath();
  ctx.moveTo(32 * u, 42 * u);
  ctx.lineTo(32 * u, 50 * u);
  ctx.moveTo(22 * u, 50 * u);
  ctx.lineTo(42 * u, 50 * u);
  ctx.stroke();

  return canvas;
}

// Devuelve el archivo .ico completo: cabecera ICONDIR + entradas + PNG de cada tamaño.
export function generarIco() {
  const imagenes = TAMANOS.map((n) => ({ n, png: dibujar(n).toBuffer('image/png') }));
  const cabecera = Buffer.alloc(6 + 16 * imagenes.length);
  cabecera.writeUInt16LE(0, 0); // reservado
  cabecera.writeUInt16LE(1, 2); // tipo: icono
  cabecera.writeUInt16LE(imagenes.length, 4);

  let offset = cabecera.length;
  imagenes.forEach(({ n, png }, i) => {
    const e = 6 + 16 * i;
    const dim = n >= 256 ? 0 : n; // en ICO, 0 significa 256
    cabecera.writeUInt8(dim, e);
    cabecera.writeUInt8(dim, e + 1);
    cabecera.writeUInt8(0, e + 2); // sin paleta
    cabecera.writeUInt8(0, e + 3); // reservado
    cabecera.writeUInt16LE(1, e + 4); // planos
    cabecera.writeUInt16LE(32, e + 6); // bits por píxel
    cabecera.writeUInt32LE(png.length, e + 8);
    cabecera.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([cabecera, ...imagenes.map((img) => img.png)]);
}

export function escribirIco(rutaSalida) {
  writeFileSync(rutaSalida, generarIco());
  return rutaSalida;
}

const esDirecto = process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
if (esDirecto) {
  const salida = process.argv[2];
  if (!salida) {
    console.error('Uso: node packaging/windows/make-icon.mjs <salida.ico>');
    process.exit(1);
  }
  console.log(`Icono generado: ${escribirIco(path.resolve(salida))}`);
}
