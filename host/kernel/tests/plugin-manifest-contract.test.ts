/**
 * Host 运行时清单校验（`host/kernel/manifest.ts`、`plugin-id.ts`）与契约
 * `contracts/plugin-manifest/v1.schema.json` 及 W09 门禁 `gate-checks/plugin-manifest.mjs` 的一致性。
 *
 * 样例（范围接受 / 拒绝列表、版本扫描、manifest 构造方式）取自 W09 门禁测试
 * `scripts/electron-migration/gate-checks/plugin-manifest.test.ts`；判定以门禁导出的函数为参照逐条比对。
 * 运行时不导入 `scripts/`（可移植性），只有这个测试把两边放在一起。
 *
 * 官方插件策略：官方插件（`dstu.*`，经 profile 从应用目录装载）在测试里校验、运行时不读 package.json：
 * 它们随应用版本发布（engines 恒满足），profile 由生成器产出、platforms 由 `host/profiles/platforms.test.ts` 守护，
 * 有 package.json 的官方包由门禁按 `official` 上下文校验；运行时只按 `meta.platforms` 跳过不属于当前平台的条目。
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import MANIFEST_SCHEMA from '../../../contracts/plugin-manifest/v1.schema.json' with { type: 'json' };
import * as gate from '../../../scripts/electron-migration/gate-checks/plugin-manifest.mjs';
import { checkManifest, manifestSchemaProblems, parseRange, parseVersion, rangeIsEmpty, satisfies } from '../manifest.ts';
import { ASSIGNED_PUBLISHERS, FORBIDDEN_PUBLISHERS, isValidPluginId } from '../plugin-id.ts';

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

const ACCEPTED = ['^0.11', '^0.11.2', '^1.2', '^1.2.3', '^0.0.3', '^0.0', '~0.11', '~1.2.3', '0.11.0', '>=0.11.0', '>=0.11.0 <0.13.0'];
const REJECTED = ['^1', '1.0', '*', 'x', '', '>=0.11', '>0.11.0', '<1.0.0', '0.11.x', '^0.11 || ^1.0', '0.11.0 - 0.12.0', '^0.11.0-beta', '>=0.11.0  <1.0.0', ' ^0.11', '^01.2', 'latest'];
const VERSIONS = ['0.0.2', '0.0.3', '0.0.4', '0.10.9', '0.11.0', '0.11.5', '0.11.0-rc.1', '0.12.0', '0.12.9', '0.13.0', '1.0.0', '1.2.2', '1.2.3', '1.3.0', '1.9.9', '2.0.0'];

/** 门禁测试中出现过的 manifest 样例（合法与不合法各一批）。 */
const SAMPLES: Json[] = [
  manifest(),
  manifest({ host: undefined, ui: './dist/ui.js' }),
  manifest({ ui: './dist/ui.mjs', platforms: ['desktop', 'mobile'], requires: { 'alice.common': '^2.0', 'dstu.chat': '>=0.11.0 <0.13.0' }, permissions: ['service:review', 'service:wordOfDay'] },
    { private: true, license: 'MIT', repository: { type: 'git', url: 'x' } }),
  manifest({ displayName: 'x' }),
  manifest({ engines: { deepStudent: '^0.11' } }),
  manifest({ manifestVersion: 2 }),
  manifest({ manifestVersion: '1' }),
  without(manifest(), 'engines'),
  manifest({}, { engines: { node: '>=22' } }),
  manifest({ host: undefined }),
  manifest({ platforms: [] }),
  manifest({ platforms: ['web'] }),
  manifest({}, { version: '1.2' }),
  ...['manifestVersion', 'id', 'platforms'].map(missing => ({ ...manifest(), deepStudent: without(manifest().deepStudent as Json, missing) })),
  ...['alice.study-stats', 'dstu.chat', 'dstu.platform.crypto', 'dstu.ui.learning-hub', 'example.word-of-day', 'local.my-plugin', 'test.fixture', 'ab.cd', 'dstux.y1'].map(id => manifest({ id })),
  ...['community.word-of-day', 'ds.x1', 'deepstudent.x1', 'deep-student.x1', 'official.x1', 'builtin.x1', 'system.x1'].map(id => manifest({ id })),
  ...['alice', 'Alice.stats', 'a.stats', 'alice.s', 'alice.study.stats', '1alice.stats', 'alice.stats/x', 'alice:stats', `a${'b'.repeat(39)}.stats`].map(id => manifest({ id })),
  manifest({ requires: { 'community.x1': '^1.0' } }),
  ...[['network:example.com'], ['notify:'], ['review'], ['service:review', 'clipboard:read'], ['service:Review'], ['service:*'], ['service:review', 'service:review']].map(permissions => manifest({ permissions })),
  manifest({ host: './src/index.mts' }),
  manifest({ host: './../x.ts' }),
  manifest({ host: 'index.ts' }),
  manifest({ host: './index.tsx' }),
  manifest({ ui: './dist/ui.css' }),
  ...ACCEPTED.concat(REJECTED).map(range => manifest({}, { engines: { deepStudent: range } })),
];

describe('W01 runtime manifest checks agree with the contract and the W09 gate', () => {
  it('version syntax matches $defs/version', () => {
    const contract = new RegExp(MANIFEST_SCHEMA.$defs.version.pattern);
    for (const v of [...VERSIONS, '1.2', '01.2.3', '1.2.3-', '1.2.3+b', '1.2.3-a.b+c.d', 'v1.2.3', '1.2.3 ', '1.2.3-beta..1']) {
      expect(parseVersion(v) !== null, v).toBe(contract.test(v));
      expect(parseVersion(v) !== null, v).toBe(gate.parseVersion(v) !== null);
    }
    expect(parseVersion('0.11.0-rc.1')).toEqual({ version: [0, 11, 0], prerelease: 'rc.1' });
  });

  it('range subset: same accepted language and the same interval as the gate', () => {
    const contract = new RegExp(MANIFEST_SCHEMA.$defs.range.pattern);
    for (const r of ACCEPTED) {
      expect(contract.test(r), r).toBe(true);
      expect(parseRange(r), r).toEqual(gate.parseRange(r));
    }
    for (const r of REJECTED) {
      expect(contract.test(r), JSON.stringify(r)).toBe(false);
      expect(parseRange(r), JSON.stringify(r)).toBeNull();
    }
    for (const r of ['>=1.0.0 <1.0.0', '>=1.2.0 <1.1.9', '>=0.11.0 <0.11.1']) {
      expect(rangeIsEmpty(parseRange(r)!), r).toBe(gate.rangeIsEmpty(gate.parseRange(r)!));
    }
  });

  it('satisfies() with includePrerelease off agrees with the gate on every sample version x range (prereleases never match)', () => {
    for (const r of [...ACCEPTED, ...REJECTED]) {
      for (const v of [...VERSIONS, '0.11', 'x']) {
        expect(satisfies(v, r, { includePrerelease: false }), `${v} in ${JSON.stringify(r)}`).toBe(gate.satisfies(v, r));
        if (parseVersion(v)?.prerelease === null) expect(satisfies(v, r), `${v} in ${JSON.stringify(r)}`).toBe(gate.satisfies(v, r));
      }
    }
  });

  it('satisfies() on prerelease versions follows semver 7 includePrerelease (table from semver 7.8.6)', () => {
    const ranges = ['^0.11', '^0.11.2', '^0.12', '^0.12.0', '^1.2', '^1.2.3', '^0.0.3', '^0.0', '~0.11', '~0.12', '~0.12.0', '~1.2.3', '0.11.0', '0.12.0', '>=0.11.0', '>=0.12.0', '>=0.11.0 <0.12.0', '>=0.11.0 <0.13.0'];
    // require('semver').satisfies(v, r, { includePrerelease: true }) 为 true 的范围；其余为 false。
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
      expect(ranges.filter(r => satisfies(v, r)), v).toEqual(expected);
      expect(ranges.filter(r => satisfies(v, r, { includePrerelease: true })), v).toEqual(expected);
    }
  });

  it('schema verdicts agree with the gate for every sample manifest', () => {
    for (const sample of SAMPLES) {
      const label = JSON.stringify(sample.deepStudent ?? sample);
      expect(manifestSchemaProblems(sample).length === 0, label).toBe(gate.schemaProblems(sample).length === 0);
    }
  });

  it('a manifest that passes the gate (schema, engines, requires) passes the runtime check, and vice versa', () => {
    for (const sample of SAMPLES) {
      const gateFindings = gate.checkManifest({ file: 'x/package.json', kind: 'example', text: JSON.stringify(sample), appVersion: '0.11.0' })
        .filter(finding => finding.rule !== 'id-context');
      const runtime = checkManifest(sample, { appVersion: '0.11.0', context: 'community-startup' });
      const label = `${JSON.stringify(sample.deepStudent)} engines=${JSON.stringify(sample.engines)}`;
      // dstu.* 在社区来源由运行时拒绝（ID_RESERVED），门禁对应的是 id-context 规则，单独比对。
      if (runtime.ok || runtime.error.code !== 'ID_RESERVED') expect(runtime.ok, label).toBe(gateFindings.length === 0);
      else expect(String((sample.deepStudent as Json).id).startsWith('dstu.'), label).toBe(true);
    }
  });

  it('id syntax and reserved publishers come from the contract', () => {
    expect(FORBIDDEN_PUBLISHERS).toEqual(MANIFEST_SCHEMA.$defs.reservedPublishers.const.forbidden);
    expect(Object.keys(ASSIGNED_PUBLISHERS)).toEqual(['dstu', 'example', 'local', 'test']);
    for (const sample of SAMPLES) {
      const id = (sample.deepStudent as Json | undefined)?.id;
      if (typeof id !== 'string') continue;
      const gateIdProblems = gate.schemaProblems(manifest({ id })).filter(problem => problem.startsWith('/deepStudent/id'));
      expect(isValidPluginId(id), id).toBe(gateIdProblems.length === 0);
    }
  });

  it('the real example packages get the same verdict from the gate and the runtime', async () => {
    const { appVersion, targets, findings } = gate.scan();
    for (const target of targets.filter(t => t.kind === 'example')) {
      const gateOk = !findings.some(f => f.file === target.file && f.rule !== 'id-context');
      let pkg: unknown = null;
      try {
        pkg = JSON.parse(await readFile(new URL(`../../../${target.file}`, import.meta.url), 'utf8'));
      } catch {
        // 缺失或损坏的 package.json：门禁报 manifest-missing / json-invalid，运行时同样不通过。
      }
      expect(checkManifest(pkg, { appVersion, context: 'community-startup' }).ok, target.file).toBe(gateOk);
    }
  });

  it('official profiles only list valid dstu.* (or test fixture) ids', async () => {
    for (const file of ['desktop.json', 'mobile.json']) {
      const profile = JSON.parse(await readFile(new URL(`../../profiles/${file}`, import.meta.url), 'utf8')) as { plugins: { id: string }[] };
      for (const { id } of profile.plugins) {
        expect(isValidPluginId(id), `${file}: ${id}`).toBe(true);
        expect(id.startsWith('dstu.'), `${file}: ${id}`).toBe(true);
      }
    }
  });
});
