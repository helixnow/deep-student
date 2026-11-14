import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE_FILE, parseRange, run, satisfies, schemaProblems } from './plugin-manifest.mjs';

const SCRIPT = path.resolve(__dirname, 'plugin-manifest.mjs');

type Json = Record<string, unknown>;
const manifest = (ds: Json = {}, top: Json = {}): Json => ({
  name: 'deepstudent-plugin-study-stats',
  version: '1.2.0',
  type: 'module',
  scripts: { build: 'esbuild ui.tsx' },
  engines: { deepStudent: '^0.11', node: '>=22' },
  deepStudent: { manifestVersion: 1, id: 'alice.study-stats', platforms: ['desktop'], host: './index.ts', ...ds },
  ...top,
});
const without = (o: Json, key: string): Json => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

describe('plugin manifest v1 schema', () => {
  it('accepts minimal host-only, ui-only and full manifests; npm top-level fields stay free', () => {
    expect(schemaProblems(manifest())).toEqual([]);
    expect(schemaProblems(manifest({ host: undefined, ui: './dist/ui.js' }))).toEqual([]);
    expect(schemaProblems(manifest({
      ui: './dist/ui.mjs', platforms: ['desktop', 'mobile'],
      requires: { 'alice.common': '^2.0', 'dstu.chat': '>=0.11.0 <0.13.0' },
      permissions: ['service:review', 'service:wordOfDay'],
    }, { private: true, license: 'MIT', repository: { type: 'git', url: 'x' } }))).toEqual([]);
  });

  it('is strict inside deepStudent and requires engines.deepStudent at the package top level', () => {
    expect(schemaProblems(manifest({ unknownField: 'x' }))).toEqual(['/deepStudent 不认识的字段 unknownField']);
    expect(schemaProblems(manifest({ displayName: 'x' }))).toEqual([]);
    expect(schemaProblems(manifest({ engines: { deepStudent: '^0.11' } }))).toEqual(['/deepStudent 不认识的字段 engines']);
    expect(schemaProblems(manifest({ manifestVersion: 2 }))).toEqual(['/deepStudent/manifestVersion 必须是 1']);
    expect(schemaProblems(manifest({ manifestVersion: '1' }))).toEqual(['/deepStudent/manifestVersion 必须是 1']);
    expect(schemaProblems(without(manifest(), 'engines'))).toEqual(['/ 缺少 engines']);
    expect(schemaProblems(manifest({}, { engines: { node: '>=22' } }))).toEqual(['/engines 缺少 deepStudent']);
    expect(schemaProblems(manifest({ host: undefined }))).toEqual(['/deepStudent host 与 ui 至少写一个']);
    expect(schemaProblems(manifest({ platforms: [] }))).toEqual(['/deepStudent/platforms must NOT have fewer than 1 items']);
    expect(schemaProblems(manifest({ platforms: ['web'] }))).toEqual(['/deepStudent/platforms/0 must be equal to one of the allowed values']);
    expect(schemaProblems(manifest({}, { version: '1.2' }))).toEqual(['/version 格式不合法（^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$）']);
    for (const missing of ['manifestVersion', 'id', 'platforms']) {
      const ds = without(manifest().deepStudent as Json, missing);
      expect(schemaProblems({ ...manifest(), deepStudent: ds })).toEqual([`/deepStudent 缺少 ${missing}`]);
    }
  });

  it('id is <publisher>.<name> (official dstu.* may have more segments); forbidden publishers are rejected', () => {
    for (const id of ['alice.study-stats', 'dstu.chat', 'dstu.platform.crypto', 'dstu.ui.learning-hub', 'example.word-of-day', 'local.my-plugin', 'test.fixture', 'ab.cd', 'dstux.y1']) {
      expect(schemaProblems(manifest({ id })), id).toEqual([]);
    }
    for (const id of ['community.word-of-day', 'ds.x1', 'deepstudent.x1', 'deep-student.x1', 'official.x1', 'builtin.x1', 'system.x1']) {
      expect(schemaProblems(manifest({ id })), id).toEqual(['/deepStudent/id 使用了保留的 publisher']);
    }
    for (const id of ['alice', 'Alice.stats', 'a.stats', 'alice.s', 'alice.study.stats', '1alice.stats', 'alice.stats/x', 'alice:stats', `a${'b'.repeat(39)}.stats`]) {
      expect(schemaProblems(manifest({ id })), id).toEqual(['/deepStudent/id 不是合法的插件 id（dstu.<段>… 或 <publisher>.<name>）']);
    }
    expect(schemaProblems(manifest({ requires: { 'community.x1': '^1.0' } }))).toEqual(['/deepStudent/requires 的键不是合法的插件 id']);
  });

  it('permissions are kind:target with the closed kind set {service}; unknown kinds are rejected', () => {
    expect(schemaProblems(manifest({ permissions: ['network:example.com'] }))).toEqual(['/deepStudent/permissions/0 未知权限 kind（v1 只有 service）']);
    expect(schemaProblems(manifest({ permissions: ['notify:'] }))).toEqual(['/deepStudent/permissions/0 语法应为 <kind>:<target>']);
    expect(schemaProblems(manifest({ permissions: ['review'] }))).toEqual(['/deepStudent/permissions/0 语法应为 <kind>:<target>']);
    expect(schemaProblems(manifest({ permissions: ['service:review', 'clipboard:read'] }))).toEqual(['/deepStudent/permissions/1 未知权限 kind（v1 只有 service）']);
    expect(schemaProblems(manifest({ permissions: ['service:Review'] }))).toEqual(['/deepStudent/permissions/0 service 的目标应为 lowerCamelCase 服务名']);
    expect(schemaProblems(manifest({ permissions: ['service:*'] }))).toEqual(['/deepStudent/permissions/0 service 的目标应为 lowerCamelCase 服务名']);
    expect(schemaProblems(manifest({ permissions: ['service:review', 'service:review'] }))).toEqual(['/deepStudent/permissions must NOT have duplicate items (items ## 1 and 0 are identical)']);
  });

  it('entries are ./-relative without .. segments; ui of community plugins is built ESM', () => {
    expect(schemaProblems(manifest({ host: './src/index.mts' }))).toEqual([]);
    expect(schemaProblems(manifest({ host: './../x.ts' }))).toEqual(['/deepStudent/host 不得含 .. 段']);
    expect(schemaProblems(manifest({ host: 'index.ts' }))[0]).toMatch(/^\/deepStudent\/host 格式不合法/);
    expect(schemaProblems(manifest({ host: './index.tsx' }))[0]).toMatch(/^\/deepStudent\/host 格式不合法/);
    expect(schemaProblems(manifest({ ui: './dist/ui.css' }))[0]).toMatch(/^\/deepStudent\/ui 格式不合法/);
  });
});

const ACCEPTED = ['^0.11', '^0.11.2', '^1.2', '^1.2.3', '^0.0.3', '^0.0', '~0.11', '~1.2.3', '0.11.0', '>=0.11.0', '>=0.11.0 <0.13.0'];
const REJECTED = ['^1', '1.0', '*', 'x', '', '>=0.11', '>0.11.0', '<1.0.0', '0.11.x', '^0.11 || ^1.0', '0.11.0 - 0.12.0', '^0.11.0-beta', '>=0.11.0  <1.0.0', ' ^0.11', '^01.2', 'latest'];
const VERSIONS = ['0.0.2', '0.0.3', '0.0.4', '0.10.9', '0.11.0', '0.11.5', '0.11.0-rc.1', '0.12.0', '0.12.9', '0.13.0', '1.0.0', '1.2.2', '1.2.3', '1.3.0', '1.9.9', '2.0.0'];

describe('version ranges (strict npm-semver subset)', () => {
  it('the schema accepts exactly the documented forms', () => {
    for (const r of ACCEPTED) expect(schemaProblems(manifest({}, { engines: { deepStudent: r } })), r).toEqual([]);
    for (const r of REJECTED) expect(schemaProblems(manifest({}, { engines: { deepStudent: r } })), JSON.stringify(r)).toEqual([expect.stringMatching(/^\/engines\/deepStudent 不是合法的版本范围/)]);
    for (const r of ACCEPTED) expect(parseRange(r), r).not.toBeNull();
    for (const r of REJECTED) expect(parseRange(r), r).toBeNull();
  });

  it('evaluates like npm semver (caret on 0.x, tilde, exact, bounded; prereleases never match)', () => {
    expect(satisfies('0.11.0', '^0.11')).toBe(true);
    expect(satisfies('0.11.9', '^0.11')).toBe(true);
    expect(satisfies('0.12.0', '^0.11')).toBe(false);
    expect(satisfies('0.11.0', '^1.0')).toBe(false);
    expect(satisfies('1.9.9', '^1.2')).toBe(true);
    expect(satisfies('2.0.0', '^1.2')).toBe(false);
    expect(satisfies('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfies('0.11.0-rc.1', '^0.11')).toBe(false);
    expect(satisfies('0.11.0', '*')).toBeNull();
    expect(satisfies('0.11', '^0.11')).toBeNull();

    const require = createRequire(import.meta.url);
    let semver: { satisfies(v: string, r: string): boolean; validRange(r: string): string | null } | null = null;
    try { semver = require('semver'); } catch { semver = null; }
    if (!semver) return;
    for (const r of ACCEPTED) {
      expect(semver.validRange(r), r).not.toBeNull();
      for (const v of VERSIONS) expect(satisfies(v, r), `${v} in ${r}`).toBe(semver.satisfies(v, r));
    }
  });

  it('includePrerelease follows semver 7 (same table as the Host contract test, from semver 7.8.6)', () => {
    const ranges = ['^0.11', '^0.11.2', '^0.12', '^0.12.0', '^1.2', '^1.2.3', '^0.0.3', '^0.0', '~0.11', '~0.12', '~0.12.0', '~1.2.3', '0.11.0', '0.12.0', '>=0.11.0', '>=0.12.0', '>=0.11.0 <0.12.0', '>=0.11.0 <0.13.0'];
    const admitted: Record<string, string[]> = {
      '0.0.3-beta': ['^0.0'],
      '0.0.4-0': ['^0.0'],
      '0.10.9-rc.1': [],
      '0.11.0-rc.1': ['^0.11', '~0.11'],
      '0.11.2-0': ['^0.11', '~0.11', '>=0.11.0', '>=0.11.0 <0.12.0', '>=0.11.0 <0.13.0'],
      '0.11.5-beta': ['^0.11', '^0.11.2', '~0.11', '>=0.11.0', '>=0.11.0 <0.12.0', '>=0.11.0 <0.13.0'],
      '0.12.0-0': ['^0.12', '~0.12', '>=0.11.0', '>=0.11.0 <0.12.0', '>=0.11.0 <0.13.0'],
      '0.12.0-beta.1': ['^0.12', '~0.12', '>=0.11.0', '>=0.11.0 <0.12.0', '>=0.11.0 <0.13.0'],
      '0.12.1-beta.1': ['^0.12', '^0.12.0', '~0.12', '~0.12.0', '>=0.11.0', '>=0.12.0', '>=0.11.0 <0.13.0'],
      '0.13.0-0': ['>=0.11.0', '>=0.12.0', '>=0.11.0 <0.13.0'],
      '1.2.0-beta': ['^1.2', '>=0.11.0', '>=0.12.0'],
      '1.2.3-beta': ['^1.2', '>=0.11.0', '>=0.12.0'],
      '1.3.0-beta': ['^1.2', '^1.2.3', '>=0.11.0', '>=0.12.0'],
      '2.0.0-0': ['>=0.11.0', '>=0.12.0'],
      '2.0.0-beta': ['>=0.11.0', '>=0.12.0'],
    };
    for (const [v, expected] of Object.entries(admitted)) {
      expect(ranges.filter((r) => satisfies(v, r, { includePrerelease: true })), v).toEqual(expected);
      expect(ranges.filter((r) => satisfies(v, r)), `${v} (npm default)`).toEqual([]);
    }
    for (const r of ranges) for (const v of ['0.11.0', '0.11.9', '0.12.0', '1.2.3']) {
      expect(satisfies(v, r, { includePrerelease: true }), `${v} in ${r}`).toBe(satisfies(v, r));
    }

    // semver 不是直接依赖，解析到的可能是传递依赖的 6.x，它对 includePrerelease 的展开与 7 不同；只与 7.x 对照。
    const require = createRequire(import.meta.url);
    let semver: { satisfies(v: string, r: string, o?: { includePrerelease?: boolean }): boolean } | null = null;
    try { semver = require('semver/package.json').version.startsWith('7.') ? require('semver') : null; } catch { semver = null; }
    if (!semver) return;
    for (const r of [...ranges, ...ACCEPTED]) for (const v of [...Object.keys(admitted), ...VERSIONS]) {
      expect(satisfies(v, r, { includePrerelease: true }), `${v} in ${r}`).toBe(semver.satisfies(v, r, { includePrerelease: true }));
    }
  });
});

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function repo(files: Record<string, string | Json>) {
  const root = mkdtempSync(path.join(tmpdir(), 'w09-plugin-manifest-'));
  roots.push(root);
  for (const [f, t] of Object.entries({ 'package.json': { name: 'deep-student', version: '0.11.0' }, ...files })) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), typeof t === 'string' ? t : `${JSON.stringify(t, null, 2)}\n`);
  }
  return root;
}
const cli = (root: string, ...args: string[]) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
};
const rules = (root: string) => run({ root }).all.map((f) => `${f.file} ${f.rule}: ${f.detail}`);

describe('plugin-manifest gate', () => {
  it('passes valid official and example packages', () => {
    const root = repo({
      'host/plugins/review/package.json': manifest({ id: 'dstu.review' }),
      'src/ui-plugins/official/notes/package.json': manifest({ id: 'dstu.ui.notes', host: undefined, ui: './index.tsx' }),
      'examples/plugins/word-of-day/package.json': manifest({ id: 'example.word-of-day', ui: './dist/ui.js' }),
      'host/plugins/review/node_modules/x/package.json': { name: 'x' },
      'host/plugins/review/tests/fixtures/package.json': { name: 'fixture' },
    });
    const r = run({ root });
    expect(r.all).toEqual([]);
    expect(r.summary).toMatchObject({ appVersion: '0.11.0', official: 2, examples: 1 });
  });

  it('reports context ids, engines that exclude the app version, empty ranges, self requires, missing and broken manifests', () => {
    const root = repo({
      'host/plugins/review/package.json': manifest({ id: 'alice.review' }),
      'examples/plugins/a/package.json': manifest({ id: 'dstu.example', requires: { 'dstu.example': '^0.11' } }, { engines: { deepStudent: '^1.0' } }),
      'examples/plugins/b/package.json': manifest({ id: 'example.beta', requires: { 'example.gamma': '>=1.0.0 <1.0.0' } }, { engines: { deepStudent: '>=0.12.0 <0.11.0' } }),
      'examples/plugins/c/README.md': 'no manifest',
      'examples/plugins/d/package.json': '{ "name": ',
      'examples/plugins/loose-file.mjs': 'export {}',
    });
    expect(rules(root)).toEqual([
      'host/plugins/review/package.json id-context: 官方插件的 id 必须以 dstu. 开头：alice.review',
      'examples/plugins/a/package.json id-context: 示例插件的 id 必须以 example. 开头：dstu.example',
      'examples/plugins/a/package.json engines-unsatisfied: /engines/deepStudent ^1.0 不包含当前应用版本 0.11.0',
      'examples/plugins/a/package.json requires-self: /deepStudent/requires 依赖了自己：dstu.example',
      'examples/plugins/b/package.json range-empty: /engines/deepStudent 区间为空：>=0.12.0 <0.11.0',
      'examples/plugins/b/package.json range-empty: /deepStudent/requires/example.gamma 区间为空：>=1.0.0 <1.0.0',
      'examples/plugins/c/package.json manifest-missing: 示例插件目录没有 package.json（manifest 唯一载体是 package.json#deepStudent）',
      expect.stringMatching(/^examples\/plugins\/d\/package.json json-invalid: package.json 无法解析：/),
    ]);
  });

  it('follows the app version: the same range passes or fails as package.json#version moves', () => {
    const files = { 'examples/plugins/a/package.json': manifest({ id: 'example.alpha' }) };
    expect(rules(repo(files))).toEqual([]);
    expect(rules(repo({ ...files, 'package.json': { version: '0.12.0' } }))).toEqual(['examples/plugins/a/package.json engines-unsatisfied: /engines/deepStudent ^0.11 不包含当前应用版本 0.12.0']);
  });

  it('a prerelease app version is judged like the Host (semver 7 includePrerelease, main decision 1)', () => {
    const at = (engines: string) => rules(repo({
      'package.json': { version: '0.12.0-beta.1' },
      'examples/plugins/a/package.json': manifest({ id: 'example.alpha' }, { engines: { deepStudent: engines } }),
    }));
    expect(at('^0.12')).toEqual([]);
    expect(at('>=0.11.0 <0.12.0')).toEqual([]);
    expect(at('^0.12.0')).toEqual(['examples/plugins/a/package.json engines-unsatisfied: /engines/deepStudent ^0.12.0 不包含当前应用版本 0.12.0-beta.1']);
    expect(at('^0.11')).toEqual(['examples/plugins/a/package.json engines-unsatisfied: /engines/deepStudent ^0.11 不包含当前应用版本 0.12.0-beta.1']);
  });

  it('CLI ratchet: baselined findings pass, new ones fail with file:line, fixed ones go stale, growth needs --allow-increase', () => {
    const legacy = { name: 'p', version: '1.0.0', deepStudent: { host: './index.ts', engines: { deepStudent: '^1.0' } } };
    const root = repo({ 'examples/plugins/legacy/package.json': legacy });
    expect(cli(root, '--check').code).toBe(1);
    expect(cli(root, '--write-baseline').out).toContain('wrote 5 baseline entries (5 findings)');
    const ok = cli(root, '--check');
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('0 official + 1 example packages; 5 known (schema 5), 5 baselined, 0 new, 0 stale');

    mkdirSync(path.join(root, 'examples/plugins/bad'), { recursive: true });
    writeFileSync(path.join(root, 'examples/plugins/bad/package.json'), `${JSON.stringify(manifest({ id: 'example.bad', permissions: ['network:x.com'] }), null, 2)}\n`);
    const bad = cli(root, '--check');
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/examples\/plugins\/bad\/package.json:\d+ \[schema\] \/deepStudent\/permissions\/0 未知权限 kind（v1 只有 service）/);
    expect(cli(root, '--write-baseline').code).toBe(1);
    rmSync(path.join(root, 'examples/plugins/bad'), { recursive: true });

    writeFileSync(path.join(root, 'examples/plugins/legacy/package.json'), `${JSON.stringify(manifest({ id: 'example.legacy' }), null, 2)}\n`);
    const fixed = cli(root, '--check');
    expect(fixed.code).toBe(0);
    expect(fixed.out).toContain('5 stale baseline entries');
    expect(cli(root, '--write-baseline').out).toContain('wrote 0 baseline entries');
  });

  it.skipIf(!run().hasBaseline)('real tree: every example manifest is v1-clean and nothing is baselined', () => {
    const r = run();
    expect(r.summary).toMatchObject({ existing: 0, fresh: 0, stale: 0 });
    expect(r.baseline.entries).toEqual([]);
    expect(BASELINE_FILE).toBe('scripts/electron-migration/gate-checks/plugin-manifest-baseline.json');
  });
});
