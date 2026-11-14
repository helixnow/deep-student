/**
 * FE-A1 layer 4 — screenshot regression of the production demo build.
 * Run through `node tests/visual/screenshots.mjs` (it builds the argument list and environment).
 *
 * Baselines live in tests/visual/__screenshots__/<platform>/ and are never shared between platforms:
 * the canonical set is linux (tests/visual/linux/), darwin proves the tooling locally.
 * Missing baselines fail unless the wrapper passed --update-snapshots.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const platform = process.env.DS_VISUAL_PLATFORM ?? process.platform;

export default defineConfig({
  testDir: here,
  testMatch: /screenshots\.visual\.ts$/,
  outputDir: path.join(here, '.out/screenshots-results'),
  snapshotPathTemplate: `{testDir}/__screenshots__/${platform}/{arg}{ext}`,
  fullyParallel: true,
  workers: Number(process.env.DS_VISUAL_WORKERS ?? 4),
  retries: 0,
  timeout: 120_000,
  updateSnapshots: 'none',
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(here, '.out/screenshots-report') }]],
  expect: {
    timeout: 20_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.001, animations: 'disabled', caret: 'hide', scale: 'css',
      stylePath: path.join(here, 'screenshot.css'),
    },
  },
  use: { headless: true },
});
