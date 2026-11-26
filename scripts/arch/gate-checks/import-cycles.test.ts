import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE_FILE, baselineGrowth, importGraph, run, runtimeImports, scanImportCycles } from './import-cycles.mjs';

const SCRIPT = path.resolve(__dirname, 'import-cycles.mjs');
const ROOT = path.resolve(__dirname, '../../..');

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function repo(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), 'w09-import-cycles-'));
  roots.push(root);
  write(root, files);
  return root;
}
function write(root: string, files: Record<string, string>) {
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), t);
  }
}
const cli = (root: string, ...args: string[]) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
};

describe('import-cycles gate: runtime edges', () => {
  it('counts imports evaluated with the module; import type / export type / import() are not edges', () => {
    const text = [
      "import type { A } from './a.ts';",
      "export type { B } from './b.ts';",
      "import { type C } from './c.ts';",
      "import d from './d.ts';",
      "import './e.ts';",
      "export * from './f.ts';",
      "export { g } from './g.ts';",
      "import h = require('./h.ts');",
      "const lazy = () => import('./i.ts');",
      "import { readFileSync } from 'node:fs';",
    ].join('\n');
    expect(runtimeImports('x.ts', text)).toEqual([
      // verbatimModuleSyntax keeps `import { type C }` as `import {} from './c.ts'`: c.ts is still evaluated.
      { specifier: './c.ts', line: 3 },
      { specifier: './d.ts', line: 4 },
      { specifier: './e.ts', line: 5 },
      { specifier: './f.ts', line: 6 },
      { specifier: './g.ts', line: 7 },
      { specifier: './h.ts', line: 8 },
      { specifier: 'node:fs', line: 10 },
    ]);
  });

  it('a type-only back edge does not close a cycle', () => {
    const root = repo({
      'host/plugins/a/api.ts': "import { b } from '../b/api.ts';\nexport const a = b;\n",
      'host/plugins/b/api.ts': "import type { a } from '../a/api.ts';\nexport const b = 1;\nexport const lazy = () => import('../a/api.ts');\n",
    });
    expect(scanImportCycles(importGraph(root)).findings).toEqual([]);
  });
});

describe('import-cycles gate: negative example (deliberate TDZ cycle)', () => {
  // Same shape as the 2026-11-07 agent-skills/api.ts ⇄ chat/api.ts crash: a's executor value-imports b's api,
  // b's registry reads a constant from a's api at module top level.
  const modules = (ext: string) => ({
    [`host/plugins/a/api.${ext}`]: `import { run } from './src/executor.${ext}';\nexport const NAME = 'a.tool';\nexport { run };\n`,
    [`host/plugins/a/src/executor.${ext}`]: `import { registry } from '../../b/api.${ext}';\nexport const run = () => registry.size;\n`,
    [`host/plugins/b/api.${ext}`]: `export { registry } from './src/registry.${ext}';\n`,
    [`host/plugins/b/src/registry.${ext}`]: `import { NAME } from '../../a/api.${ext}';\nexport const registry = new Set([NAME]);\n`,
  });

  it('the cycle really crashes at load time, and the scanner reports every edge on it with the cycle path', () => {
    const root = repo({ 'package.json': '{"type":"module"}\n', ...modules('mjs') });
    expect(() => execFileSync(process.execPath, [path.join(root, 'host/plugins/a/api.mjs')], { encoding: 'utf8', stdio: 'pipe' }))
      .toThrow(/Cannot access 'NAME' before initialization/);

    const { components, findings } = scanImportCycles(importGraph(root, ['host/plugins/a/api.mjs']));
    expect(components).toHaveLength(1);
    expect(findings.map((f) => `${f.file}:${f.line} -> ${f.to}`)).toEqual([
      'host/plugins/a/api.mjs:1 -> host/plugins/a/src/executor.mjs',
      'host/plugins/a/src/executor.mjs:1 -> host/plugins/b/api.mjs',
      'host/plugins/b/api.mjs:1 -> host/plugins/b/src/registry.mjs',
      'host/plugins/b/src/registry.mjs:1 -> host/plugins/a/api.mjs',
    ]);
    const back = findings.find((f) => f.file === 'host/plugins/b/src/registry.mjs')!;
    expect(back.crossPlugin).toBe(true);
    expect(back.cycle).toEqual([
      'host/plugins/b/src/registry.mjs', 'host/plugins/a/api.mjs', 'host/plugins/a/src/executor.mjs', 'host/plugins/b/api.mjs', 'host/plugins/b/src/registry.mjs',
    ]);
    expect(back.message).toContain('跨插件运行时导入环');
  });

  it('ratchet: baselined cycles pass; an injected cycle exits 1 with file:line; a broken cycle is reported stale', () => {
    const root = repo(modules('ts'));
    expect(cli(root, '--write-baseline').code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, BASELINE_FILE), 'utf8')).entries).toHaveLength(4);
    expect(cli(root, '--check').code).toBe(0);

    write(root, {
      'host/plugins/c/api.ts': "import { helper } from './src/impl.ts';\nexport const C = 1;\nexport { helper };\n",
      'host/plugins/c/src/impl.ts': "// c\nimport { C } from '../api.ts';\nexport const helper = () => C;\n",
    });
    const bad = cli(root, '--check');
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('host/plugins/c/src/impl.ts:2 [runtime-import-cycle]');
    expect(bad.out).toContain('host/plugins/c/src/impl.ts → host/plugins/c/api.ts → host/plugins/c/src/impl.ts');
    expect(bad.out).toContain('host/plugins/c/api.ts:1 [runtime-import-cycle]');
    expect(bad.out).not.toContain('host/plugins/a/');

    write(root, { 'host/plugins/c/src/impl.ts': "// c\nimport type { C } from '../api.ts';\nexport const helper = (c: typeof C) => c;\n" });
    write(root, { 'host/plugins/b/src/registry.ts': "import type { NAME } from '../../a/api.ts';\nexport const registry = new Set<typeof NAME>();\n" });
    const fixed = run({ root });
    expect(fixed.summary).toMatchObject({ cyclicEdges: 0, fresh: 0, stale: 4 });
    expect(cli(root, '--check').code).toBe(0);
  });

  it('portable.ts is an entry too: a cycle reachable only from it is caught', () => {
    const root = repo({
      'host/plugins/v/api.ts': "export const desktopOnly = 1;\n",
      'host/plugins/v/portable.ts': "import { helper } from './src/impl.ts';\nexport const V = 1;\nexport { helper };\n",
      'host/plugins/v/src/impl.ts': "import { V } from '../portable.ts';\nexport const helper = () => V;\n",
    });
    const result = run({ root });
    expect(result.summary).toMatchObject({ entries: 2, cyclicEdges: 2, fresh: 2 });
    expect(cli(root, '--check').out).toContain('host/plugins/v/src/impl.ts → host/plugins/v/portable.ts → host/plugins/v/src/impl.ts');
  });

  it('baseline counts only go down: rewriting with a new cyclic edge is refused unless --allow-increase', () => {
    const root = repo(modules('ts'));
    cli(root, '--write-baseline');
    write(root, { 'host/plugins/b/src/registry.ts': "import { NAME } from '../../a/api.ts';\nimport { run } from '../../a/api.ts';\nexport const registry = new Set([NAME]);\n" });
    const refused = cli(root, '--write-baseline');
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/host\/plugins\/b\/src\/registry\.ts → host\/plugins\/a\/api\.ts 1 → 2/);
    expect(cli(root, '--write-baseline', '--allow-increase').code).toBe(0);
    expect(baselineGrowth({ entries: [{ file: 'x', to: 'y', count: 2 }] }, [{ file: 'x', to: 'y', count: 1 }])).toEqual([]);
  });
});

describe('import-cycles gate: repository', () => {
  it('reports the integration TDZ cycle (executor-registry → agent-skills/api.ts) while those edges exist', () => {
    const graph = importGraph(ROOT);
    const has = (from: string, to: string) => (graph.get(from) ?? []).some((e) => e.to === to);
    const registry = 'host/plugins/chat/src/executor-registry.ts';
    const skillsApi = 'host/plugins/agent-skills/api.ts';
    if (!has(registry, skillsApi) || !has('host/plugins/agent-skills/src/tools/skills-tool-executor.ts', 'host/plugins/chat/api.ts')) return;
    const finding = scanImportCycles(graph).findings.find((f) => f.file === registry && f.to === skillsApi);
    expect(finding?.crossPlugin).toBe(true);
    expect(finding?.cycle[0]).toBe(registry);
    expect(finding?.cycle.at(-1)).toBe(registry);
  });
});
