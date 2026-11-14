#!/usr/bin/env node
/**
 * FE-A1 layer 5 — build chunk graph (plans/FRONTEND-PLUGINIZATION.md §2.8, R6-06 as a script).
 *
 *   node scripts/plugins/chunk-graph.mjs [--check] [--dist DIR] [--strict] [--allow-growth BYTES]
 *   node scripts/plugins/chunk-graph.mjs --update [--dist DIR]
 *
 * Without --dist the production main build (`vite.config.ts`, unchanged, version module pinned)
 * runs first in an 8 GiB child process (≈5 min; run through bin/heavy). The build records Rollup's
 * own chunk table (tests/visual/lib/build.mjs); this script normalises it (no hashes, repo-relative
 * module ids) and compares with tests/visual/__golden__/chunk-graph/main.json.
 *
 * --check rules (the FE-B contract):
 *   1. the entry's static closure gains no source module, except under src/ui-kernel/ and src/ui-sdk/;
 *   2. its bytes (chunks + imported CSS, minus kernel/SDK modules) do not grow beyond --allow-growth (default 0);
 *   3. every lazily loaded src module of the baseline is still a dynamic entry outside the entry closure.
 * --strict additionally fails on any structural difference (used for the build-twice stability proof).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const goldenFile = path.join(root, 'tests/visual/__golden__/chunk-graph/main.json');
export const ENTRY_GROWTH_EXEMPT = ['src/ui-kernel/', 'src/ui-sdk/'];

/** Repo-relative, symlink- and query-free module id. */
export function normalizeModuleId(id, repoRoot = root) {
  let clean = id.replace(/\?.*$/, '');
  if (clean.startsWith('\0')) return `virtual:${clean.slice(1)}`;
  const nm = clean.lastIndexOf('/node_modules/');
  if (nm >= 0) return `node_modules/${clean.slice(nm + '/node_modules/'.length)}`;
  if (path.isAbsolute(clean)) clean = path.relative(repoRoot, clean);
  return clean.split(path.sep).join('/');
}

function packageOf(moduleId) {
  const rest = moduleId.slice('node_modules/'.length).split('/');
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}

const stripHash = (file) => file.replace(/-[A-Za-z0-9_-]{8}(\.[a-z]+)$/, '$1');

/** Raw Rollup table (build.mjs) → hash-free graph keyed by stable chunk identities. */
export function normalizeBundle(raw, repoRoot = root) {
  const nameCount = new Map();
  for (const chunk of raw.chunks) if (!chunk.facadeModuleId) nameCount.set(chunk.name, (nameCount.get(chunk.name) ?? 0) + 1);
  const keyOf = new Map();
  for (const chunk of raw.chunks) {
    const ids = Object.keys(chunk.modules).map((id) => normalizeModuleId(id, repoRoot)).sort();
    const key = chunk.facadeModuleId
      ? normalizeModuleId(chunk.facadeModuleId, repoRoot)
      : nameCount.get(chunk.name) > 1 ? `${chunk.name}~${ids[0] ?? 'empty'}` : chunk.name;
    keyOf.set(chunk.fileName, key);
  }
  const cssBytes = new Map(raw.assets.map((asset) => [asset.fileName, asset.bytes]));
  const chunks = {};
  for (const chunk of [...raw.chunks].sort((a, b) => keyOf.get(a.fileName).localeCompare(keyOf.get(b.fileName)))) {
    const sources = {};
    const packages = {};
    for (const [id, bytes] of Object.entries(chunk.modules)) {
      const moduleId = normalizeModuleId(id, repoRoot);
      if (moduleId.startsWith('node_modules/')) packages[packageOf(moduleId)] = (packages[packageOf(moduleId)] ?? 0) + bytes;
      else sources[moduleId] = bytes;
    }
    chunks[keyOf.get(chunk.fileName)] = {
      file: stripHash(chunk.fileName),
      kind: chunk.isEntry ? 'entry' : chunk.isDynamicEntry ? 'dynamic' : 'shared',
      bytes: chunk.bytes,
      css: (chunk.importedCss ?? []).map((file) => ({ file: stripHash(file), bytes: cssBytes.get(file) ?? 0 })).sort((a, b) => a.file.localeCompare(b.file)),
      imports: chunk.imports.map((file) => keyOf.get(file) ?? `?${file}`).sort(),
      dynamicImports: chunk.dynamicImports.map((file) => keyOf.get(file) ?? `?${file}`).sort(),
      modules: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))),
      packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))),
    };
  }
  return withSummary({ chunks });
}

function closureOf(chunks, start) {
  const seen = new Set();
  const stack = [...start];
  while (stack.length) {
    const key = stack.pop();
    if (seen.has(key) || !chunks[key]) continue;
    seen.add(key);
    stack.push(...chunks[key].imports);
  }
  return [...seen].sort();
}

const exempt = (moduleId) => ENTRY_GROWTH_EXEMPT.some((prefix) => moduleId.startsWith(prefix));

export function withSummary(graph) {
  const entries = Object.keys(graph.chunks).filter((key) => graph.chunks[key].kind === 'entry').sort();
  const closure = closureOf(graph.chunks, entries);
  const modules = closure.flatMap((key) => Object.keys(graph.chunks[key].modules)).sort();
  const packages = [...new Set(closure.flatMap((key) => Object.keys(graph.chunks[key].packages)))].sort();
  const chunkBytes = closure.reduce((sum, key) => sum + graph.chunks[key].bytes, 0);
  const css = [...new Map(closure.flatMap((key) => graph.chunks[key].css).map((item) => [item.file, item])).values()];
  const cssBytes = css.reduce((sum, item) => sum + item.bytes, 0);
  const exemptBytes = closure.reduce((sum, key) => sum + Object.entries(graph.chunks[key].modules)
    .filter(([id]) => exempt(id)).reduce((s, [, bytes]) => s + bytes, 0), 0);
  const lazy = Object.keys(graph.chunks).filter((key) => graph.chunks[key].kind === 'dynamic' && key.startsWith('src/')).sort();
  return {
    ...graph,
    summary: {
      entries,
      entryClosure: { chunks: closure, bytes: chunkBytes, cssBytes, exemptBytes, modules, packages },
      lazySources: lazy.map((key) => ({ key, inEntryClosure: closure.includes(key) })),
      totals: { chunks: Object.keys(graph.chunks).length, bytes: Object.values(graph.chunks).reduce((sum, c) => sum + c.bytes, 0) },
    },
  };
}

/** Rule violations (fail --check) and an informational structural diff (fails --strict). */
export function compareGraphs(baseline, actual, { allowGrowth = 0 } = {}) {
  const violations = [];
  const changes = [];
  const before = baseline.summary.entryClosure;
  const after = actual.summary.entryClosure;
  const addedModules = after.modules.filter((id) => !before.modules.includes(id));
  for (const id of addedModules.filter((m) => !exempt(m))) violations.push(`entry closure gained source module ${id}`);
  for (const pkg of after.packages.filter((p) => !before.packages.includes(p))) violations.push(`entry closure gained package ${pkg}`);
  const budget = (s) => s.bytes + s.cssBytes - s.exemptBytes;
  const growth = budget(after) - budget(before);
  if (growth > allowGrowth) {
    violations.push(`entry closure grew by ${growth} bytes (chunks ${before.bytes}→${after.bytes}, css ${before.cssBytes}→${after.cssBytes}, kernel/SDK ${before.exemptBytes}→${after.exemptBytes}; allowed ${allowGrowth})`);
  }
  const afterLazy = new Map(actual.summary.lazySources.map((item) => [item.key, item]));
  for (const item of baseline.summary.lazySources) {
    const now = afterLazy.get(item.key);
    if (!now) violations.push(`lazy module ${item.key} is no longer a dynamic entry chunk`);
    else if (now.inEntryClosure && !item.inEntryClosure) violations.push(`lazy module ${item.key} is now in the entry static closure`);
  }

  for (const id of addedModules) changes.push(`entry closure + ${id}`);
  for (const id of before.modules.filter((m) => !after.modules.includes(m))) changes.push(`entry closure - ${id}`);
  const keys = new Set([...Object.keys(baseline.chunks), ...Object.keys(actual.chunks)]);
  for (const key of [...keys].sort()) {
    const b = baseline.chunks[key];
    const a = actual.chunks[key];
    if (!b || !a) { changes.push(`chunk ${b ? '-' : '+'} ${key}`); continue; }
    for (const field of ['file', 'kind', 'bytes']) if (b[field] !== a[field]) changes.push(`chunk ${key}: ${field} ${b[field]} → ${a[field]}`);
    for (const field of ['imports', 'dynamicImports', 'css', 'packages']) {
      if (JSON.stringify(b[field]) !== JSON.stringify(a[field])) changes.push(`chunk ${key}: ${field} changed`);
    }
    const moduleIds = new Set([...Object.keys(b.modules), ...Object.keys(a.modules)]);
    for (const id of [...moduleIds].sort()) {
      if (b.modules[id] === a.modules[id]) continue;
      changes.push(`chunk ${key}: module ${id} ${b.modules[id] ?? '∅'} → ${a.modules[id] ?? '∅'}`);
    }
  }
  return { violations, changes, growth };
}

function parseArgs(argv) {
  const opts = { mode: 'check', dist: null, strict: false, allowGrowth: 0, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.mode = 'check';
    else if (arg === '--update') opts.mode = 'update';
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--dist') opts.dist = path.resolve(argv[++i]);
    else if (arg === '--allow-growth') opts.allowGrowth = Number(argv[++i]);
    else if (arg === '--write-actual') opts.out = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let dist = opts.dist;
  if (!dist) {
    const { runBuildChild, defaultMainDir } = await import('../../tests/visual/lib/build.mjs');
    dist = defaultMainDir;
    const status = runBuildChild('main', dist);
    if (status !== 0) {
      console.error(`[chunk-graph] build failed (exit ${status})`);
      process.exit(status);
    }
  }
  const rawFile = path.join(dist, '.ds-chunks.json');
  if (!fs.existsSync(rawFile)) throw new Error(`${rawFile} missing: build with tests/visual/lib/build.mjs (plain vite build does not record chunks)`);
  const actual = normalizeBundle(JSON.parse(fs.readFileSync(rawFile, 'utf8')));
  const text = `${JSON.stringify(actual, null, 1)}\n`;
  if (opts.out) fs.writeFileSync(opts.out, text);
  const s = actual.summary;
  console.log(`[chunk-graph] ${s.totals.chunks} chunks, ${s.totals.bytes} bytes; entry closure ${s.entryClosure.chunks.length} chunks ${s.entryClosure.bytes} bytes + css ${s.entryClosure.cssBytes}; ${s.lazySources.length} lazy src chunks`);
  if (opts.mode === 'update') {
    fs.mkdirSync(path.dirname(goldenFile), { recursive: true });
    fs.writeFileSync(goldenFile, text);
    console.log(`[chunk-graph] wrote ${path.relative(root, goldenFile)}`);
    return;
  }
  if (!fs.existsSync(goldenFile)) throw new Error(`${path.relative(root, goldenFile)} missing; run with --update on the baseline commit`);
  const baseline = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
  const { violations, changes, growth } = compareGraphs(baseline, actual, { allowGrowth: opts.allowGrowth });
  for (const line of changes.slice(0, 80)) console.log(`  ~ ${line}`);
  if (changes.length > 80) console.log(`  … ${changes.length - 80} more changes`);
  for (const line of violations) console.log(`  ✗ ${line}`);
  const failed = violations.length > 0 || (opts.strict && changes.length > 0);
  console.log(`[chunk-graph] check ${failed ? 'FAILED' : 'passed'}: ${violations.length} violations, ${changes.length} structural changes, entry growth ${growth} bytes${opts.strict ? ' (strict)' : ''}`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
