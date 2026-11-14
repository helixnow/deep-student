#!/usr/bin/env node
/**
 * One command for the real-window desktop smoke (W12):
 *
 *   node host/e2e/smoke/desktop-smoke.mjs [--rebuild] [playwright args…]
 *
 * 1. `src/version.ts` (generated, untracked) via scripts/generate-version.mjs; DEEP_STUDENT_BUILD_NUMBER
 *    defaults to 20000 because snapshot checkouts have no build-baseline commit.
 * 2. The sandboxed preload bundle (electron/scripts/build-preload.mjs).
 * 3. The production frontend `dist/` when missing or with `--rebuild` (vite needs more than the default
 *    V8 heap for this app).
 * 4. `playwright test -c host/e2e/smoke/playwright-electron.config.ts` (golden paths ①–⑤, agent tools ⑥, sync ⑦, old data ⑧, perf baseline ⑨).
 *
 * No network access is needed; every user-data location is redirected per spec (see __tests__/support/app.ts).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../../..');
const args = process.argv.slice(2);
const rebuild = args.includes('--rebuild');
const playwrightArgs = args.filter((arg) => arg !== '--rebuild');
const env = { ...process.env, DEEP_STUDENT_BUILD_NUMBER: process.env.DEEP_STUDENT_BUILD_NUMBER ?? '20000' };

function run(label, command, commandArgs, extraEnv = {}) {
  process.stdout.write(`[desktop-smoke] ${label}\n`);
  const result = spawnSync(command, commandArgs, { cwd: repo, stdio: 'inherit', env: { ...env, ...extraEnv } });
  if (result.status !== 0) {
    process.stderr.write(`[desktop-smoke] ${label} failed (exit ${result.status ?? result.signal})\n`);
    process.exit(result.status ?? 1);
  }
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
run('generate src/version.ts', process.execPath, ['scripts/generate-version.mjs']);
run('build preload', process.execPath, ['electron/scripts/build-preload.mjs']);
if (rebuild || !existsSync(join(repo, 'dist', 'index.html'))) {
  run('vite build (dist/)', npx, ['vite', 'build'], { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim() });
}
run('playwright golden paths', npx, ['playwright', 'test', '-c', 'host/e2e/smoke/playwright-electron.config.ts', ...playwrightArgs]);
