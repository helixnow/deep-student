#!/usr/bin/env node
/**
 * FE-A1 acceptance: three deliberate mutations, each must be caught by its layer.
 *
 *   bin/heavy node tests/visual/mutations/verify-mutations.mjs [--only nav-order,class,arg-key] [--also-screenshots]
 *
 *   nav-order  swap two nav entries in the official shell plugin   → slot snapshot (layer 1)
 *   class      change one Tailwind class of the sidebar toggle      → DOM golden (layer 2) [+ screenshots]
 *   arg-key    rename groupId → group_id in one chat_v2_list_sessions call → IPC trace (layer 3)
 *
 * Each mutation is applied to the working tree, the layer runs against it (class / arg-key rebuild the
 * demo into tests/visual/.out/mutant-<name>, ≈1 min each), the layer must exit non-zero with the expected
 * finding in its output, and the file is restored in `finally`. Refuses to run on files with local changes.
 * Exit 0 only if every selected mutation was caught; a summary is written to tests/visual/.out/mutations.json.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, runBuildChild } from '../lib/build.mjs';

const MUTATIONS = [
  {
    name: 'nav-order',
    file: 'src/ui-plugins/official/shell/index.ts',
    apply(source) {
      const lines = source.split('\n');
      const at = (id) => lines.findIndex((line) => line.trimStart().startsWith(`{ id: '${id}', viewId: '${id}'`));
      const a = at('learning-hub');
      const b = at('media');
      if (a < 0 || b !== a + 2) throw new Error('nav entries learning-hub/media not found where expected');
      const [first, second] = [lines.slice(a, a + 2), lines.slice(b, b + 2)];
      lines.splice(a, 4, ...second, ...first);
      return lines.join('\n');
    },
    build: false,
    layer: ['scripts/plugins/slot-snapshot.mjs', '--check'],
    expect: [/slot nav: sequence chat-v2 > learning-hub > media .* → chat-v2 > media > learning-hub/],
  },
  {
    name: 'class',
    file: 'src/components/ModernSidebar.tsx',
    apply: (source) => replaceOnce(source, 'className="sidebar-session-toggle block w-full cursor-default appearance-none border-0 bg-transparent py-1 pl-9 pr-2.5',
      'className="sidebar-session-toggle block w-full cursor-default appearance-none border-0 bg-transparent py-1 pl-10 pr-2.5'),
    build: true,
    layer: ['tests/visual/dom-golden.mjs', '--check', '--scenes', 'shell-chat', '--retries', '0'],
    expect: [/^\s*-.*\.pl-9\..*sidebar-session-toggle/m, /^\s*\+.*\.pl-10\..*sidebar-session-toggle/m],
    screenshots: ['tests/visual/screenshots.mjs', '--check', '--scenes', 'shell-chat'],
  },
  {
    name: 'arg-key',
    file: 'src/features/chat/stores/sessionListStore.ts',
    apply: (source) => replaceOnce(source, "status: 'active', groupId: '*', limit: 10000, offset: 0,", "status: 'active', group_id: '*', limit: 10000, offset: 0,"),
    build: true,
    layer: ['scripts/plugins/ipc-trace.mjs', '--check', '--scenes', 'shell-chat', '--retries', '0'],
    expect: [/\+ chat_v2_list_sessions\(group_id,limit,offset,status\)/],
  },
];

function replaceOnce(source, from, to) {
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) throw new Error(`expected exactly one occurrence of: ${from.slice(0, 80)}…`);
  return source.slice(0, at) + to + source.slice(at + from.length);
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const argv = process.argv.slice(2);
const onlyAt = argv.indexOf('--only');
const only = onlyAt >= 0 ? new Set(argv[onlyAt + 1].split(',')) : null;
const alsoScreenshots = argv.includes('--also-screenshots');
const selected = MUTATIONS.filter((m) => !only || only.has(m.name));
const outDir = path.join(repoRoot, 'tests/visual/.out');
fs.mkdirSync(outDir, { recursive: true });

const summary = [];
for (const mutation of selected) {
  const file = path.join(repoRoot, mutation.file);
  if (spawnSync('git', ['diff', '--quiet', '--', mutation.file], { cwd: repoRoot }).status !== 0) {
    throw new Error(`${mutation.file} has local changes; commit or stash them first`);
  }
  const original = fs.readFileSync(file, 'utf8');
  const record = { name: mutation.name, file: mutation.file, caught: false, layerExit: null, findings: [] };
  console.log(`\n=== mutation ${mutation.name}: ${mutation.file}`);
  try {
    fs.writeFileSync(file, mutation.apply(original));
    const layer = [...mutation.layer];
    let dist = null;
    if (mutation.build) {
      dist = path.join(outDir, `mutant-${mutation.name}`);
      const status = runBuildChild('demo', dist);
      if (status !== 0) throw new Error(`mutant demo build failed (exit ${status})`);
      layer.push('--dist', dist);
    }
    const result = run(layer);
    fs.writeFileSync(path.join(outDir, `mutation-${mutation.name}.log`), result.output);
    record.layerExit = result.status;
    record.findings = mutation.expect.map((pattern) => ({ pattern: String(pattern), found: pattern.test(result.output) }));
    record.caught = result.status !== 0 && record.findings.every((f) => f.found);
    console.log(`  layer ${mutation.layer[0]} exit ${result.status}; expected findings ${record.findings.map((f) => (f.found ? 'found' : 'MISSING')).join(', ')}`);
    if (alsoScreenshots && mutation.screenshots && dist) {
      const shots = run([...mutation.screenshots, '--dist', dist]);
      fs.writeFileSync(path.join(outDir, `mutation-${mutation.name}-screenshots.log`), shots.output);
      record.screenshotsExit = shots.status;
      console.log(`  screenshots exit ${shots.status} (${shots.status !== 0 ? 'also caught' : 'not caught'})`);
    }
  } finally {
    fs.writeFileSync(file, original);
  }
  console.log(`  ${record.caught ? '✓ caught' : '✗ NOT caught'}`);
  summary.push(record);
}
fs.writeFileSync(path.join(outDir, 'mutations.json'), `${JSON.stringify(summary, null, 2)}\n`);
const missed = summary.filter((r) => !r.caught);
console.log(`\n[mutations] ${summary.length - missed.length}/${summary.length} caught${missed.length ? `; missed: ${missed.map((r) => r.name).join(', ')}` : ''}`);
process.exit(missed.length ? 1 : 0);
