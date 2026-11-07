import { defineConfig } from 'vitest/config';

// Separado de vite.config.ts, cuyo `root` apunta a client/.
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
