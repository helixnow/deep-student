import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareMobileManifest, DEFAULT_CHUNKS, GOLDEN_FILE, moduleIds, run, updateMobileManifest, workbenchModules,
} from '../mobile-manifest.mjs';

const script = path.resolve(__dirname, '../mobile-manifest.mjs');
const tempDirs: string[] = [];

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w16-mobile-manifest-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeChunks(dir: string, modules: string[], name = 'chunks.json') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ chunks: [{ fileName: 'assets/main.js', name: 'main', isEntry: true, modules: Object.fromEntries(modules.map((id) => [id, 10])) }], assets: [] }));
  return file;
}

describe('mobile manifest: module table', () => {
  it('reads Rollup records, normalized graphs and plain arrays, and normalises ids', () => {
    const rollup = { chunks: [{ modules: { '/repo/src/main.tsx': 1, '/repo/src/features/workbench/apps/a.tsx?raw': 2 } }] };
    expect(moduleIds(rollup, '/repo')).toEqual(['src/features/workbench/apps/a.tsx', 'src/main.tsx']);
    const graph = { chunks: { index: { modules: { 'src/features/workbench/apps/b.tsx': 1 } } } };
    expect(moduleIds(graph)).toEqual(['src/features/workbench/apps/b.tsx']);
    expect(moduleIds(['/repo/src/x.ts', '/repo/src/x.ts', '/elsewhere/node_modules/react/index.js'], '/repo'))
      .toEqual(['node_modules/react/index.js', 'src/x.ts']);
    expect(() => moduleIds({})).toThrow(/no modules table/);
  });

  it('keeps only the desktop Workbench prefix', () => {
    expect(workbenchModules([
      'src/features/workbench/apps/a.tsx', 'src/features/workbench/apps/b.css', 'src/features/learning-hub/page.tsx', 'src/main.tsx',
    ])).toEqual(['src/features/workbench/apps/a.tsx', 'src/features/workbench/apps/b.css']);
  });
});

describe('mobile manifest: only-shrink baseline', () => {
  it('compares exact sets', () => {
    expect(compareMobileManifest(['a', 'b'], ['a'])).toEqual({ added: [], removed: ['b'], ok: false });
    expect(compareMobileManifest(['a'], ['a', 'c'])).toEqual({ added: ['c'], removed: [], ok: false });
    expect(compareMobileManifest(['a'], ['a'])).toEqual({ added: [], removed: [], ok: true });
  });

  it('refuses to grow the baseline and accepts a shrink', () => {
    expect(updateMobileManifest(['a'], ['a', 'b'])).toEqual({ written: false, added: ['b'], removed: [] });
    expect(updateMobileManifest(['a'], ['a', 'b'], { allowGrowth: true })).toEqual({ written: true, added: ['b'], removed: [] });
    expect(updateMobileManifest(['a', 'b'], ['a'])).toEqual({ written: true, added: [], removed: ['b'] });
  });

  it('fails without a baseline, on a new module, and on a stale entry; --update records the shrink', () => {
    const repo = tempRepo();
    const chunks = writeChunks(repo, ['src/main.tsx', 'src/features/workbench/apps/a.tsx']);
    const options = { repoRoot: repo, chunks, golden: 'golden.json' };

    expect(run({ ...options, mode: 'check' }).failures).toEqual(['golden.json missing; capture it on the baseline commit with --update']);

    expect(run({ ...options, mode: 'update' }).written).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(repo, 'golden.json'), 'utf8'))).toEqual(['src/features/workbench/apps/a.tsx']);
    expect(run({ ...options, mode: 'check' }).failures).toEqual([]);

    writeChunks(repo, ['src/main.tsx']);
    expect(run({ ...options, mode: 'check' }).failures)
      .toEqual(['baseline lists a module the mobile build no longer has (run --update to record the shrink): src/features/workbench/apps/a.tsx']);

    expect(run({ ...options, mode: 'update' }).written).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(repo, 'golden.json'), 'utf8'))).toEqual([]);
    expect(run({ ...options, mode: 'check' }).failures).toEqual([]);
  });

  it('fails on a module that re-enters through App/main/command-palette, and --update refuses it', () => {
    const repo = tempRepo();
    const chunks = writeChunks(repo, ['src/main.tsx']);
    const golden = path.join(repo, 'golden.json');
    fs.writeFileSync(golden, '[]\n');
    writeChunks(repo, ['src/main.tsx', 'src/features/workbench/apps/registerAll.ts']);

    const failure = 'desktop Workbench module in the mobile build: src/features/workbench/apps/registerAll.ts';
    expect(run({ repoRoot: repo, chunks, golden: 'golden.json', mode: 'check' }).failures).toEqual([failure]);
    const update = run({ repoRoot: repo, chunks, golden: 'golden.json', mode: 'update' });
    expect(update.written).toBe(false);
    expect(update.failures).toEqual([
      'mobile manifest gained 1 desktop Workbench module(s); cut the static path instead (reviewed exception: --allow-growth):',
      '  + src/features/workbench/apps/registerAll.ts',
    ]);
    expect(JSON.parse(fs.readFileSync(golden, 'utf8'))).toEqual([]);
    expect(run({ repoRoot: repo, chunks, golden: 'golden.json', mode: 'update', allowGrowth: true }).written).toBe(true);
  });

  it('--expect-empty states the final W38 claim', () => {
    const repo = tempRepo();
    const golden = path.join(repo, 'golden.json');
    fs.writeFileSync(golden, '[]\n');
    const modules = path.join(repo, 'modules.json');
    fs.writeFileSync(modules, JSON.stringify(['src/features/workbench/apps/a.tsx']));
    const failing = run({ repoRoot: repo, modules, golden: 'golden.json', expectEmpty: true });
    expect(failing.failures).toEqual(expect.arrayContaining([
      'desktop Workbench module in the mobile build: src/features/workbench/apps/a.tsx',
      '--expect-empty: the mobile build still contains 1 desktop Workbench module(s)',
    ]));
    fs.writeFileSync(modules, JSON.stringify(['src/main.tsx']));
    expect(run({ repoRoot: repo, modules, golden: 'golden.json', expectEmpty: true }).failures).toEqual([]);
  });
});

describe('mobile manifest: CLI', () => {
  it('exits 1 on a real module and 0 with --expect-empty when none remains', () => {
    const repo = tempRepo();
    const golden = path.join(repo, 'golden.json');
    fs.writeFileSync(golden, '[]\n');
    const modules = path.join(repo, 'modules.json');
    fs.writeFileSync(modules, JSON.stringify(['src/features/workbench/apps/a.tsx']));
    const args = [script, '--check', '--modules', modules, '--golden', golden, '--expect-empty'];
    const failing = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain('desktop Workbench module in the mobile build: src/features/workbench/apps/a.tsx');

    fs.writeFileSync(modules, JSON.stringify(['src/main.tsx']));
    const passing = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain('0 desktop Workbench module(s)');
    expect(passing.stdout).not.toContain(DEFAULT_CHUNKS);
  });

  it('reports a missing build record as a usage-level failure', () => {
    const repo = tempRepo();
    const result = spawnSync(process.execPath, [script, '--check', '--chunks', path.join(repo, 'nope.json'), '--golden', path.join(repo, 'golden.json')], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('missing');
  });
});
