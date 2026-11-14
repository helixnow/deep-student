#!/usr/bin/env node
/**
 * W38 evidence: the mobile build carries no desktop Workbench module.
 *
 *   # produce the authoritative Rollup module table (VITE_DS_PLATFORM=mobile, same config as desktop)
 *   VITE_DS_PLATFORM=mobile bin/heavy node tests/visual/lib/build.mjs main tests/visual/.out/mobile-dist
 *
 *   node scripts/plugins/mobile-manifest.mjs --check --chunks tests/visual/.out/mobile-dist/.ds-chunks.json
 *   node scripts/plugins/mobile-manifest.mjs --check --chunks <file> --expect-empty
 *   node scripts/plugins/mobile-manifest.mjs --update --chunks <file>
 *
 * The baseline is `tests/visual/__golden__/mobile-manifest.json`: every `src/features/workbench/**` module the
 * mobile build still contains when the baseline was captured. Before W38 that is the whole desktop Workbench tree
 * (the host files reach it statically); afterwards the set may only shrink. `--check` fails on a module the
 * baseline does not list (a new static path from App/main/command-palette into Workbench) and on a stale baseline
 * entry, so the file keeps proving the cut instead of silently staying large. `--update` rewrites the baseline and
 * refuses to grow it; `--allow-growth` is the reviewed exception. `--expect-empty` is the final W38 claim: the
 * mobile build contains zero desktop Workbench modules, whatever the baseline says.
 *
 * `--modules <file>` accepts a plain JSON array of module ids when a caller only has the module list (for example
 * a Vite manifest conversion); otherwise the Rollup record from tests/visual/lib/build.mjs is used.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeModuleId } from './chunk-graph.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const GOLDEN_FILE = 'tests/visual/__golden__/mobile-manifest.json';
export const DEFAULT_CHUNKS = 'tests/visual/.out/mobile-dist/.ds-chunks.json';
export const WORKBENCH_PREFIX = 'src/features/workbench/';

/** Every module id in a Rollup record (`build.mjs`), a normalized chunk graph, or a plain id array. */
export function moduleIds(input, repoRoot = root) {
  if (Array.isArray(input)) {
    return [...new Set(input.filter((id) => typeof id === 'string').map((id) => normalizeModuleId(id, repoRoot)))].sort();
  }
  if (!input || typeof input !== 'object') throw new Error('module list must be a JSON array or an object with chunks/modules');
  const ids = new Set();
  const add = (modules) => {
    if (Array.isArray(modules)) {
      for (const id of modules) if (typeof id === 'string') ids.add(normalizeModuleId(id, repoRoot));
    } else if (modules && typeof modules === 'object') {
      for (const id of Object.keys(modules)) ids.add(normalizeModuleId(id, repoRoot));
    }
  };
  if (input.chunks) {
    for (const chunk of (Array.isArray(input.chunks) ? input.chunks : Object.values(input.chunks))) add(chunk?.modules ?? []);
  } else if (input.modules) add(input.modules);
  else throw new Error('no modules table: expected chunks[].modules, chunks{}.modules or modules');
  return [...ids].sort();
}

/** The desktop Workbench modules in `ids`, with the query stripped and ids repo-relative. */
export function workbenchModules(ids, prefix = WORKBENCH_PREFIX) {
  return ids.filter((id) => id.startsWith(prefix)).sort();
}

export function compareMobileManifest(baseline, actual) {
  const added = actual.filter((id) => !baseline.includes(id));
  const removed = baseline.filter((id) => !actual.includes(id));
  return { added, removed, ok: added.length === 0 && removed.length === 0 };
}

/** `--update` semantics: write `actual`, but never add a module the reviewed baseline did not have. */
export function updateMobileManifest(baseline, actual, { allowGrowth = false } = {}) {
  const { added, removed } = compareMobileManifest(baseline, actual);
  if (added.length && !allowGrowth) return { written: false, added, removed };
  return { written: true, added, removed };
}

export function readModules({ chunks, modules = null, repoRoot = root } = {}) {
  const file = path.resolve(repoRoot, modules ?? chunks);
  if (!fs.existsSync(file)) throw new Error(`${path.relative(repoRoot, file)} missing${modules ? '' : '; build with: VITE_DS_PLATFORM=mobile node tests/visual/lib/build.mjs main tests/visual/.out/mobile-dist'}`);
  return moduleIds(JSON.parse(fs.readFileSync(file, 'utf8')), repoRoot);
}

export function run({ repoRoot = root, chunks = DEFAULT_CHUNKS, modules = null, golden = GOLDEN_FILE, mode = 'check', allowGrowth = false, expectEmpty = false } = {}) {
  const actual = workbenchModules(readModules({ chunks, modules, repoRoot }));
  const goldenPath = path.resolve(repoRoot, golden);
  const hasBaseline = fs.existsSync(goldenPath);
  const baseline = hasBaseline ? JSON.parse(fs.readFileSync(goldenPath, 'utf8')) : [];
  if (!Array.isArray(baseline)) throw new Error(`${golden} must be a JSON array of module ids`);
  if (mode === 'update') {
    // Without a checked-in baseline this is the initial capture (the baseline commit); growth only applies after.
    const result = hasBaseline ? updateMobileManifest(baseline, actual, { allowGrowth }) : { written: true, added: [], removed: [] };
    if (!result.written) return { mode, actual, baseline, hasBaseline, golden: goldenPath, ...result, failures: [
      `mobile manifest gained ${result.added.length} desktop Workbench module(s); cut the static path instead (reviewed exception: --allow-growth):`,
      ...result.added.map((id) => `  + ${id}`),
    ] };
    fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
    fs.writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
    return { mode, actual, baseline, hasBaseline, golden: goldenPath, ...result, written: true, failures: [] };
  }
  const failures = [];
  if (!hasBaseline) {
    const shown = path.relative(repoRoot, goldenPath);
    failures.push(`${shown.startsWith('..') ? goldenPath : shown} missing; capture it on the baseline commit with --update`);
  } else {
    const compared = compareMobileManifest(baseline, actual);
    for (const id of compared.added) failures.push(`desktop Workbench module in the mobile build: ${id}`);
    for (const id of compared.removed) failures.push(`baseline lists a module the mobile build no longer has (run --update to record the shrink): ${id}`);
  }
  if (expectEmpty && actual.length) failures.push(`--expect-empty: the mobile build still contains ${actual.length} desktop Workbench module(s)`);
  return { mode, actual, baseline, hasBaseline, golden: goldenPath, written: false, added: [], removed: [], failures };
}

function parseArgs(argv) {
  const options = { mode: 'check', chunks: DEFAULT_CHUNKS, modules: null, golden: GOLDEN_FILE, allowGrowth: false, expectEmpty: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') options.mode = 'check';
    else if (arg === '--update') options.mode = 'update';
    else if (arg === '--chunks') options.chunks = argv[++i];
    else if (arg === '--modules') options.modules = argv[++i];
    else if (arg === '--golden') options.golden = argv[++i];
    else if (arg === '--allow-growth') options.allowGrowth = true;
    else if (arg === '--expect-empty') options.expectEmpty = true;
    else if (arg === '--json') options.json = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function main(argv) {
  let result;
  try {
    const { json, ...options } = parseArgs(argv);
    result = run(options);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const id of result.actual) console.log(`  · ${id}`);
      for (const failure of result.failures) console.log(`  ✗ ${failure}`);
      const relative = path.relative(process.cwd(), result.golden);
      const shown = relative.startsWith('..') ? result.golden : relative || result.golden;
      console.log(`mobile-manifest: ${result.actual.length} desktop Workbench module(s); ${result.mode} `
        + `${result.written ? 'wrote ' : ''}${shown}; ${result.failures.length} failure${result.failures.length === 1 ? '' : 's'}`);
    }
  } catch (error) {
    console.error(`mobile-manifest: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  process.exitCode = result.failures.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
