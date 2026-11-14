/**
 * Desktop smoke diagnostics (W12): one-off measurements that reuse the golden-suite harness but are not
 * part of it, e.g. `__tests__/diagnostics/host-heap.spec.ts`. Needs the same production `dist/` build.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './__tests__/diagnostics',
  testMatch: ['**/*.spec.ts'],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: '../../../test-results/w12-diagnostics/artifacts',
});
