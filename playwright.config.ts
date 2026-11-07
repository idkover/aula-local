import { defineConfig, devices } from '@playwright/test';

// Pruebas E2E (Fase 3). Vitest solo recoge `tests/**/*.test.ts`; estas usan `*.spec.ts`.
// No hay `webServer`: cada prueba arranca su propio servidor en un puerto libre (port: 0).
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
