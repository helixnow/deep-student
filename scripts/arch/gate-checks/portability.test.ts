import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { introduced } from './portability.mjs';

const SCRIPT = path.resolve(__dirname, 'portability.mjs');
const SCANNER = path.resolve(__dirname, '../../portability/scan.mjs');

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'w09-portability-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' }).trim();
  const write = (files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), t);
    }
  };
  const commit = (message: string) => { git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q');
  return { root, write, commit };
}
const gate = (root: string, ...args: string[]) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, '--root', root, '--scanner', SCANNER, '--baseline', 'portability-baseline.json', ...args], { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout + err.stderr };
  }
};

describe('portability gate wiring: only changes since base are blocking', () => {
  it('pre-existing NEW entries and mobile-profile violations pass; ones introduced since base fail with file:line', () => {
    const { root, write, commit } = fixture();
    write({
      'host/plugins/alpha/index.ts': 'export const a = 1;\n',
      'host/plugins/beta/index.ts': 'export const b = 1;\n',
      'host/profiles/mobile.json': JSON.stringify({ plugins: [{ id: 'dstu.alpha', module: '../plugins/alpha/index.ts' }] }),
    });
    execFileSync(process.execPath, [SCANNER, '--root', root, '--write-baseline', '--baseline', 'portability-baseline.json']);
    // Debt already on the base branch: the whitelist lags behind the code.
    write({ 'host/plugins/alpha/index.ts': "import fs from 'node:fs';\nexport const a = fs.existsSync('.');\n" });
    const base = commit('base');

    const clean = gate(root, '--base', base);
    expect(clean.out).toMatch(/NEW 1 \(base 1\), mobile profile violations 1 \(base 1\); 0 introduced/);
    expect(clean.code).toBe(0);

    write({
      'host/plugins/beta/index.ts': "import os from 'node:os';\nexport const b = os.EOL;\n",
      'host/plugins/alpha/index.ts': "import fs from 'node:fs';\nimport { z } from './zip.ts';\nexport const a = fs.existsSync('.') && z;\n",
      'host/plugins/alpha/zip.ts': "\nimport zlib from 'node:zlib';\nexport const z = zlib.constants;\n",
    });
    commit('head');
    const bad = gate(root, '--base', base);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('host/plugins/beta/index.ts:1 [portability]');
    expect(bad.out).toContain('host/plugins/alpha/zip.ts:2 [portability]');
    expect(bad.out).toContain('host/plugins/alpha/zip.ts:2 [mobile-profile]');
    expect(bad.out).toContain('dstu.alpha');
    expect(bad.out).not.toContain('host/plugins/alpha/index.ts:1');

    const strict = gate(root);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain('host/plugins/alpha/index.ts:1 [portability]');
  });

  it('a missing scanner is skipped', () => {
    const { root } = fixture();
    const out = execFileSync(process.execPath, [SCRIPT, '--root', root, '--scanner', 'nope/scan.mjs'], { encoding: 'utf8' });
    expect(out).toContain('不存在，跳过');
  });

  it('introduced() compares counts per key, so moved lines are not new but extra occurrences are', () => {
    const key = (e: { file: string; key: string }) => `${e.file}\0${e.key}`;
    const base = [{ file: 'a.ts', key: 'node-builtin:fs', line: 3 }];
    expect(introduced([{ file: 'a.ts', key: 'node-builtin:fs', line: 9 }], base, key)).toEqual([]);
    expect(introduced([{ file: 'a.ts', key: 'node-builtin:fs', line: 9 }, { file: 'a.ts', key: 'node-builtin:fs', line: 12 }], base, key))
      .toEqual([{ file: 'a.ts', key: 'node-builtin:fs', line: 12 }]);
  });
});
