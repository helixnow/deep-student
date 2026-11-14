/** Shared CLI plumbing for the demo-shell layers: argument parsing, demo server, browser, golden I/O. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { defaultDemoDir, repoRoot } from './build.mjs';
import { serveDirectory } from './serve.mjs';

export { repoRoot };
export const goldenRoot = path.join(repoRoot, 'tests/visual/__golden__');
export const outRoot = path.join(repoRoot, 'tests/visual/.out');

/** Baselines that depend on rasterisation are stored per platform; never mix them. */
export function platformKey() {
  return process.env.DS_VISUAL_PLATFORM ?? process.platform;
}

export function parseLayerArgs(argv, extra = {}) {
  const opts = { mode: 'check', dist: defaultDemoDir, base: null, scenes: null, retries: 1, ...extra };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.mode = 'check';
    else if (arg === '--update') opts.mode = 'update';
    else if (arg === '--dist') opts.dist = path.resolve(argv[++i]);
    else if (arg === '--base') opts.base = argv[++i].replace(/\/$/, '');
    else if (arg === '--scenes') opts.scenes = new Set(argv[++i].split(',').filter(Boolean));
    else if (arg === '--retries') opts.retries = Number(argv[++i]);
    else if (arg === '--build') opts.build = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

export async function startDemo(opts) {
  if (opts.build) {
    const { runBuildChild } = await import('./build.mjs');
    const status = runBuildChild('demo', opts.dist);
    if (status !== 0) throw new Error(`demo build failed (exit ${status})`);
  }
  const server = opts.base ? null : await serveDirectory(opts.dist);
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  return {
    base: opts.base ?? server.url,
    browser,
    async close() {
      await browser.close();
      await server?.close();
    },
  };
}

export function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Short unified diff of two files via git (available wherever the repo is). */
export function showDiff(expectedFile, actualFile, maxLines = 60) {
  const result = spawnSync('git', ['diff', '--no-index', '--no-color', '-U1', '--', expectedFile, actualFile], { encoding: 'utf8' });
  const lines = (result.stdout || '').split('\n').filter((line) => !line.startsWith('diff --git') && !line.startsWith('index '));
  for (const line of lines.slice(0, maxLines)) console.log(`    ${line}`);
  if (lines.length > maxLines) console.log(`    … ${lines.length - maxLines} more diff lines (${path.relative(repoRoot, actualFile)})`);
}
