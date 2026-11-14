/**
 * Real-window desktop smoke (W12): Playwright drives the production Electron entry against an isolated
 * data root and a local fake LLM. Prerequisites and the one-shot command: host/e2e/smoke/W12-PROGRESS.md.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './__tests__/golden',
  testMatch: ['**/*.spec.ts'],
  // One Electron + Host at a time: each spec owns a full app instance.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: '../../../test-results/w12-desktop-smoke/results.json' }]],
  outputDir: '../../../test-results/w12-desktop-smoke/artifacts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
