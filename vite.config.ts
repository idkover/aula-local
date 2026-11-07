import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const clientDir = fileURLToPath(new URL('./client', import.meta.url));

// Todo el frontend se empaqueta aquí: ninguna página pide recursos externos en runtime.
export default defineConfig({
  root: clientDir,
  base: '/',
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL('./dist/client', import.meta.url)),
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: {
        student: `${clientDir}/student/index.html`,
        teacher: `${clientDir}/teacher/index.html`,
        projector: `${clientDir}/teacher/projector.html`,
        library: `${clientDir}/teacher/library.html`,
        summary: `${clientDir}/teacher/summary.html`,
        pin: `${clientDir}/teacher/pin.html`,
        conectar: `${clientDir}/teacher/conectar.html`,
        guiaRed: `${clientDir}/teacher/guia-red.html`,
      },
    },
  },
});
