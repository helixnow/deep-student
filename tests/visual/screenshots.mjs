#!/usr/bin/env node
/**
 * FE-A1 layer 4 — screenshots (12 scenes × 2 viewports × 2 themes), per-platform baselines.
 *
 *   node tests/visual/screenshots.mjs [--check] [--scenes a,b] [--dist DIR | --base URL] [--build]
 *   node tests/visual/screenshots.mjs --update
 *
 * Wraps `playwright test -c tests/visual/playwright.visual.config.ts`; the HTML report with
 * expected / actual / diff images is written to tests/visual/.out/screenshots-report/.
 * The canonical baseline is linux: tests/visual/linux/run-docker.sh runs this inside the pinned container,
 * tests/visual/linux/run-native.sh on a Linux host that already has the fonts and Chromium.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseLayerArgs, platformKey, repoRoot } from './lib/runner.mjs';

const opts = parseLayerArgs(process.argv.slice(2));
if (opts.build) {
  const { runBuildChild } = await import('./lib/build.mjs');
  const status = runBuildChild('demo', opts.dist);
  if (status !== 0) process.exit(status);
}
const args = ['node_modules/@playwright/test/cli.js', 'test', '-c', 'tests/visual/playwright.visual.config.ts'];
if (opts.mode === 'update') args.push('--update-snapshots=all');
const env = { ...process.env, DS_VISUAL_DIST: opts.dist };
if (opts.base) env.DS_VISUAL_BASE = opts.base;
if (opts.scenes) env.DS_VISUAL_SCENES = [...opts.scenes].join(',');
const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit', env });
if (result.error) throw result.error;
const status = result.status ?? 1;
console.log(`[screenshots] ${opts.mode} ${status === 0 ? 'passed' : 'FAILED'} (${platformKey()}; baselines tests/visual/__screenshots__/${platformKey()}/; report ${path.join('tests/visual/.out/screenshots-report')})`);
process.exit(status);
