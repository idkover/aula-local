// Utilidades de prueba: un PDF mínimo válido generado en memoria y lectura del ancho de un PNG.

/** PDF de `pages` páginas tamaño carta horizontal, cada una con su número escrito en Helvetica. */
export function makePdf(pages: number): Buffer {
  const objects: string[] = [];
  const pageIds = Array.from({ length: pages }, (_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pageIds.forEach((id, i) => {
    const stream = `BT /F1 96 Tf 300 280 Td (${i + 1}) Tj ET`;
    objects[id] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error('No es un PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
