/**
 * 插件生态 v1 P0（kernel 半）：Host 从 profile 装载社区插件时读取 `package.json#deepStudent`，
 * 不兼容只降级该插件、不阻断启动，降级原因带结构化错误码（`decisions/2026-11-07-plugin-ecosystem-v1.md`）。
 *
 * 社区插件包写在系统临时目录（应用目录之外即社区来源）；官方夹具在 `__fixtures__/plugin-manifest/`。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROFILE_FAILED_EVENT, loadProfile, loadStartupProfile } from '../profile.ts';
import { ContractSet } from '../contracts.ts';
import { assertInstallable, parseDegradedReason, PluginLoadError } from '../manifest.ts';
import { createTestHost, type TestHost } from '../testing.ts';

/** Vitest 只能导入仓库内的模块：社区插件包写到仓库根的 `.tmp/`（已 gitignore，位于 host/、electron/ 之外即社区来源）。 */
const TMP = fileURLToPath(new URL('../../../.tmp/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../__fixtures__/plugin-manifest/', import.meta.url));
const OFFICIAL = { id: 'fixture.manifest-official', module: join(FIXTURES, 'official.plugin.ts') };
const MOBILE_ONLY = { id: 'fixture.manifest-mobile-only', module: join(FIXTURES, 'mobile-only.plugin.ts') };

type Json = Record<string, unknown>;
interface CommunitySpec {
  id: string;
  version?: string;
  /** 覆盖 `deepStudent` 字段（值为 undefined 时删除该字段）。 */
  ds?: Json;
  /** 覆盖 package.json 顶层字段。 */
  top?: Json;
  /** 覆盖模块 meta。 */
  meta?: Json;
  inject?: string[];
  provides?: string[];
  Config?: string;
}

const g = globalThis as { __w01ManifestApplied?: string[]; __w01Configs?: Map<string, unknown> };
let root: string;
let host: TestHost | null = null;

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  root = await mkdtemp(join(TMP, 'w01-manifest-'));
  g.__w01ManifestApplied = [];
  g.__w01Configs = new Map();
});
afterEach(async () => {
  await host?.dispose();
  host = null;
  delete g.__w01ManifestApplied;
  delete g.__w01Configs;
  await rm(root, { recursive: true, force: true });
});

const strip = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** 写一个社区插件包，返回 profile 条目。 */
async function community(spec: CommunitySpec, dirName = spec.id): Promise<{ id: string; module: string }> {
  const dir = join(root, 'packages', dirName);
  await mkdir(dir, { recursive: true });
  const version = spec.version ?? '1.0.0';
  const pkg = strip({
    name: `deepstudent-plugin-${dirName.replace(/\./g, '-')}`,
    version,
    type: 'module',
    engines: { deepStudent: '^0.11' },
    deepStudent: strip({ manifestVersion: 1, id: spec.id, platforms: ['desktop'], host: './index.mjs', ...spec.ds }),
    ...spec.top,
  });
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  const meta = { id: spec.id, version, provides: spec.provides ?? [], ...spec.meta };
  await writeFile(join(dir, 'index.mjs'), [
    `globalThis.__w01ManifestApplied?.push(${JSON.stringify(`evaluated:${spec.id}`)});`,
    spec.Config ? `import Schema from '@deepseek-ai/schemastery';` : '',
    `const meta = ${JSON.stringify(meta)};`,
    'export default {',
    `  name: ${JSON.stringify(spec.id)}, meta, inject: ${JSON.stringify(spec.inject ?? [])},`,
    spec.Config ? `  Config: ${spec.Config},` : '',
    '  apply(ctx, config) {',
    '    globalThis.__w01ManifestApplied?.push(meta.id);',
    '    globalThis.__w01Configs?.set(meta.id, config);',
    '    for (const name of meta.provides) ctx.provide(name, { owner: meta.id });',
    '  },',
    '};',
  ].join('\n'));
  return { id: spec.id, module: join(dir, 'index.mjs') };
}

async function profile(plugins: readonly Json[], extra: Json = {}): Promise<string> {
  const path = join(root, 'user.profile.json');
  await writeFile(path, JSON.stringify({ plugins, ...extra }));
  return path;
}

async function newHost(version = '0.11.0'): Promise<TestHost> {
  host = await createTestHost({ app: { version, dataDir: join(root, 'data') }, contracts: ContractSet.empty() });
  return host;
}

const codes = (degraded: readonly { id: string; reason: string }[]) => degraded.map(item => ({ id: item.id, code: parseDegradedReason(item.reason).code }));

describe('W01 plugin manifest v1 at startup', () => {
  it('loads a valid community plugin next to official plugins and reports it as community', async () => {
    const plugin = await community({ id: 'alice.study-stats', inject: ['manifestOfficial'], provides: ['aliceStudyStats'], ds: { permissions: ['service:manifestOfficial'], requires: { 'fixture.manifest-official': '^0.11' } } });
    const { runtime } = await newHost();
    const result = await loadProfile(runtime, await profile([OFFICIAL, plugin]), { platform: 'desktop' });
    expect(result.degraded).toEqual([]);
    expect(result.installed.map(p => p.id)).toEqual(['fixture.manifest-official', 'alice.study-stats']);
    expect(runtime.uiManifestV2().plugins.map(p => [p.id, p.origin, p.version])).toEqual([
      ['fixture.manifest-official', 'builtin', undefined],
      ['alice.study-stats', 'community', '1.0.0'],
    ]);
  });

  it('checks engines.deepStudent against the app version first: an incompatible plugin is degraded, never evaluated, and startup continues', async () => {
    const old = await community({ id: 'alice.old', top: { engines: { deepStudent: '^0.10' } } });
    const future = await community({ id: 'alice.future', top: { engines: { deepStudent: '>=0.12.0' } }, ds: { someFutureField: true } });
    const ok = await community({ id: 'alice.ok' });
    const { runtime } = await newHost();
    const result = await loadProfile(runtime, await profile([OFFICIAL, old, future, ok]), { platform: 'desktop' });
    expect(codes(result.degraded)).toEqual([{ id: 'alice.old', code: 'ENGINE_INCOMPATIBLE' }, { id: 'alice.future', code: 'ENGINE_INCOMPATIBLE' }]);
    expect(result.degraded[0]!.reason).toBe('ENGINE_INCOMPATIBLE: requires app version ^0.10; this app is 0.11.0');
    expect(result.installed.map(p => p.id)).toEqual(['fixture.manifest-official', 'alice.ok']);
    expect(g.__w01ManifestApplied).toEqual(['evaluated:alice.ok', 'alice.ok']);
  });

  it('rejects newer manifest versions with an upgrade hint before looking at anything else', async () => {
    const plugin = await community({ id: 'alice.next', ds: { manifestVersion: 2, brandNew: {} }, top: { engines: { deepStudent: '^9.0' } } });
    const { runtime } = await newHost();
    const result = await loadProfile(runtime, await profile([plugin]), { platform: 'desktop' });
    expect(result.degraded).toEqual([{ id: 'alice.next', reason: 'MANIFEST_VERSION_UNSUPPORTED: manifestVersion 2 is newer than this app supports (1); upgrade the app' }]);
  });

  it('requires engines.deepStudent and validates the rest of the manifest strictly against the contract', async () => {
    const noEngines = await community({ id: 'alice.no-engines', top: { engines: { node: '>=22' } } });
    const badRange = await community({ id: 'alice.bad-range', top: { engines: { deepStudent: '0.11.x' } } });
    const unknownField = await community({ id: 'alice.unknown-field', ds: { unrecognizedField: 'x' } });
    const selfRequire = await community({ id: 'alice.self', ds: { requires: { 'alice.self': '^1.0' } } });
    const noPackage = { id: 'alice.no-package', module: join(root, 'loose', 'index.mjs') };
    await mkdir(join(root, 'loose'), { recursive: true });
    await writeFile(noPackage.module, 'export default { meta: { id: "alice.no-package" }, apply() {} };');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'not-a-plugin', version: '1.0.0' }));
    const { runtime } = await newHost();
    const result = await loadProfile(runtime, await profile([noEngines, badRange, unknownField, selfRequire, noPackage]), { platform: 'desktop' });
    expect(result.degraded.map(d => d.reason)).toEqual([
      'MANIFEST_INVALID: /engines/deepStudent is required',
      'MANIFEST_INVALID: /engines/deepStudent "0.11.x" is not a supported range (^X.Y[.Z], ~X.Y[.Z], X.Y.Z, >=X.Y.Z[ <A.B.C])',
      'MANIFEST_INVALID: /deepStudent has unknown field "unrecognizedField"',
      'MANIFEST_INVALID: /deepStudent/requires must not require the plugin itself (alice.self)',
      'MANIFEST_MISSING: package.json has no "deepStudent" manifest',
    ]);
    expect(result.installed).toEqual([]);
  });

  it('enforces id format and reserved publishers: dstu.* is for built-in plugins only, forbidden publishers never load', async () => {
    const impostor = await community({ id: 'dstu.chat' }, 'impostor');
    const forbidden = await community({ id: 'community.word-of-day' });
    const local = await community({ id: 'local.dev-plugin' });
    const example = await community({ id: 'example.word-of-day' });
    const { runtime } = await newHost();
    const result = await loadProfile(runtime, await profile([impostor, forbidden, local, example]), { platform: 'desktop' });
    expect(result.degraded).toEqual([
      { id: 'dstu.chat', reason: 'ID_RESERVED: plugin id "dstu.chat": publisher "dstu" is reserved for built-in plugins' },
      { id: 'community.word-of-day', reason: 'MANIFEST_INVALID: /deepStudent/id uses a forbidden publisher' },
    ]);
    expect(result.installed.map(p => p.id)).toEqual(['local.dev-plugin', 'example.word-of-day']);
  });

  it('skips plugins whose platforms exclude the current platform with UNSUPPORTED_ON_PLATFORM (community manifest and official meta)', async () => {
    const mobileOnly = await community({ id: 'alice.mobile-only', ds: { platforms: ['mobile'] } });
    const both = await community({ id: 'alice.everywhere', ds: { platforms: ['desktop', 'mobile'] } });
    const { runtime } = await newHost();
    const result = await loadProfile(runtime, await profile([MOBILE_ONLY, mobileOnly, both]), { platform: 'desktop' });
    expect(result.degraded).toEqual([
      { id: 'alice.mobile-only', reason: 'UNSUPPORTED_ON_PLATFORM: plugin "alice.mobile-only" supports mobile, not desktop' },
      { id: 'fixture.manifest-mobile-only', reason: 'UNSUPPORTED_ON_PLATFORM: plugin "fixture.manifest-mobile-only" supports mobile, not desktop' },
    ]);
    expect(result.installed.map(p => p.id)).toEqual(['alice.everywhere']);
    expect(g.__w01ManifestApplied).not.toContain('fixture.manifest-mobile-only');
  });

  it('checks requires ranges against the loaded versions (official plugins carry the app version) and cascades to dependants', async () => {
    const base = await community({ id: 'alice.base', version: '2.3.0' });
    const ok = await community({ id: 'alice.uses-base', ds: { requires: { 'alice.base': '^2.1', 'fixture.manifest-official': '>=0.11.0 <0.12.0' } } });
    const tooNew = await community({ id: 'alice.wants-base3', ds: { requires: { 'alice.base': '^3.0' } } });
    const missing = await community({ id: 'alice.wants-ghost', ds: { requires: { 'alice.ghost': '^1.0' } } });
    const chained = await community({ id: 'alice.wants-ghost-user', ds: { requires: { 'alice.wants-ghost': '^1.0' } } });
    const { runtime } = await newHost();
    const result = await loadProfile(runtime, await profile([OFFICIAL, base, ok, tooNew, missing, chained]), { platform: 'desktop' });
    expect(result.degraded).toEqual([
      { id: 'alice.wants-base3', reason: 'REQUIRES_INCOMPATIBLE: requires "alice.base" ^3.0 (found 2.3.0)' },
      { id: 'alice.wants-ghost', reason: 'REQUIRES_MISSING: requires "alice.ghost" ^1.0, which is not loaded' },
      { id: 'alice.wants-ghost-user', reason: 'REQUIRES_MISSING: requires "alice.wants-ghost" ^1.0, which is not loaded' },
    ]);
    expect(result.installed.map(p => p.id)).toEqual(['fixture.manifest-official', 'alice.base', 'alice.uses-base']);
  });

  it('only injects declared services: undeclared injection and unknown permission kinds are rejected; log is implicit', async () => {
    const undeclared = await community({ id: 'alice.sneaky', inject: ['manifestOfficial'] });
    const unknownKind = await community({ id: 'alice.network', ds: { permissions: ['network:example.com'] } });
    const implicit = await community({ id: 'alice.logger', inject: ['log'] });
    const { runtime } = await newHost();
    runtime.ctx.provide('log', {});
    const result = await loadProfile(runtime, await profile([OFFICIAL, undeclared, unknownKind, implicit]), { platform: 'desktop' });
    expect(result.degraded).toEqual([
      { id: 'alice.network', reason: 'PERMISSION_UNKNOWN_KIND: unknown permission kind in "network:example.com" (v1 only knows "service")' },
      { id: 'alice.sneaky', reason: 'PERMISSION_UNDECLARED: injects "manifestOfficial" without declaring "service:manifestOfficial" in deepStudent.permissions' },
    ]);
    expect(result.installed.map(p => p.id)).toEqual(['fixture.manifest-official', 'alice.logger']);
  });

  it('keeps community services inside the id-derived namespace and never lets them displace another provider', async () => {
    const foreign = await community({ id: 'alice.stats', provides: ['stats'] });
    const owned = await community({ id: 'alice.study', provides: ['aliceStudy', 'aliceStudyCache'] });
    // `alice-study.xy` 与 `alice.study-xy` 派生出同一服务名 `aliceStudyXy`：后出现的降级，profile 不因“重复提供”整体失败。
    const first = await community({ id: 'alice.study-xy', provides: ['aliceStudyXy'] });
    const second = await community({ id: 'alice-study.xy', provides: ['aliceStudyXy'] });
    const { runtime } = await newHost();
    const result = await loadProfile(runtime, await profile([foreign, owned, first, second]), { platform: 'desktop' });
    expect(result.degraded).toEqual([
      { id: 'alice.stats', reason: 'SERVICE_NAME_INVALID: services "stats" are outside the plugin\'s namespace (derived from the id; see pluginServiceName)' },
      { id: 'alice-study.xy', reason: 'SERVICE_CONFLICT: service "aliceStudyXy" is already provided by "alice.study-xy"' },
    ]);
    expect(result.installed.map(p => p.id)).toEqual(['alice.study', 'alice.study-xy']);
  });

  it('degrades (instead of failing the profile) when the module disagrees with its manifest', async () => {
    const wrongVersion = await community({ id: 'alice.wrong-version', meta: { version: '0.9.0' } });
    const wrongId = await community({ id: 'alice.wrong-id', meta: { id: 'alice.other' } });
    const wrongEntry = await community({ id: 'alice.wrong-entry', ds: { host: './dist/host.mjs' } });
    const uiOnly = await community({ id: 'alice.ui-only', ds: { host: undefined, ui: './dist/ui.js' } });
    const { runtime } = await newHost();
    const result = await loadProfile(runtime, await profile([wrongVersion, wrongId, wrongEntry, uiOnly]), { platform: 'desktop' });
    expect(codes(result.degraded)).toEqual([
      { id: 'alice.wrong-entry', code: 'HOST_ENTRY_MISMATCH' },
      { id: 'alice.ui-only', code: 'HOST_ENTRY_MISMATCH' },
      { id: 'alice.wrong-version', code: 'VERSION_MISMATCH' },
      { id: 'alice.wrong-id', code: 'ID_MISMATCH' },
    ]);
    expect(result.degraded[2]!.reason).toBe('VERSION_MISMATCH: module meta.version "0.9.0" differs from package.json version "1.0.0"');
  });

  it('a user profile with incompatible community plugins still loads (no fallback to the official profile); desktop is the default platform', async () => {
    const plugin = await community({ id: 'alice.mobile', ds: { platforms: ['mobile'] } });
    const ok = await community({ id: 'alice.fine' });
    const userProfile = await profile([OFFICIAL, plugin, ok]);
    const { runtime, events } = await newHost();
    for (const core of ['storage', 'paths', 'log']) runtime.ctx.provide(core, {});
    const result = await loadStartupProfile(runtime, { userProfile, official: join(root, 'missing-official.json') });
    expect(events.filter(e => e.event === PROFILE_FAILED_EVENT)).toEqual([]);
    expect(codes(result.degraded)).toEqual([{ id: 'alice.mobile', code: 'UNSUPPORTED_ON_PLATFORM' }]);
    expect(runtime.degradedPlugins()).toEqual(result.degraded);
    expect(result.installed.map(p => p.id)).toEqual(['fixture.manifest-official', 'alice.fine']);
  });

  it('a prerelease app version is checked with semver includePrerelease: a beta build loads the plugins whose range admits it', async () => {
    const plugin = await community({ id: 'alice.any' });
    const { runtime } = await newHost('0.11.1-beta.1');
    const result = await loadProfile(runtime, await profile([plugin]), { platform: 'desktop' });
    expect(result.degraded).toEqual([]);
    expect(result.installed.map(p => p.id)).toEqual(['alice.any']);
  });

  it('a 0.12.0 beta precedes 0.12.0: ^0.12 and an explicit <0.12.0 admit it, ^0.12.0 and ^0.11 do not; requires on official plugins (app version) agree', async () => {
    const partial = await community({ id: 'alice.partial', top: { engines: { deepStudent: '^0.12' } }, ds: { requires: { 'fixture.manifest-official': '^0.12' } } });
    const bounded = await community({ id: 'alice.bounded', top: { engines: { deepStudent: '>=0.11.0 <0.12.0' } } });
    const full = await community({ id: 'alice.full', top: { engines: { deepStudent: '^0.12.0' } } });
    const previous = await community({ id: 'alice.previous', top: { engines: { deepStudent: '^0.11' } } });
    const needsRelease = await community({ id: 'alice.needs-release', top: { engines: { deepStudent: '^0.12' } }, ds: { requires: { 'fixture.manifest-official': '^0.12.0' } } });
    const { runtime } = await newHost('0.12.0-beta.1');
    const result = await loadProfile(runtime, await profile([OFFICIAL, partial, bounded, full, previous, needsRelease]), { platform: 'desktop' });
    expect(result.degraded).toEqual([
      { id: 'alice.full', reason: 'ENGINE_INCOMPATIBLE: requires app version ^0.12.0; this app is 0.12.0-beta.1' },
      { id: 'alice.previous', reason: 'ENGINE_INCOMPATIBLE: requires app version ^0.11; this app is 0.12.0-beta.1' },
      { id: 'alice.needs-release', reason: 'REQUIRES_INCOMPATIBLE: requires "fixture.manifest-official" ^0.12.0 (found 0.12.0-beta.1)' },
    ]);
    expect(result.installed.map(p => p.id)).toEqual(['fixture.manifest-official', 'alice.partial', 'alice.bounded']);
  });
});

describe('W01 plugin manifest v1 at install time', () => {
  const pkg = (id: string, ds: Json = {}, top: Json = {}): Json => ({
    name: 'deepstudent-plugin-x', version: '1.0.0', engines: { deepStudent: '^0.11' },
    deepStudent: { manifestVersion: 1, id, platforms: ['desktop'], host: './index.mjs', ...ds }, ...top,
  });
  const installed = new Map([['dstu.chat', '0.11.0']]);

  it('accepts a compatible package and returns its manifest', () => {
    expect(assertInstallable(pkg('alice.stats', { requires: { 'dstu.chat': '^0.11' }, permissions: ['service:review'] }), { appVersion: '0.11.0', platform: 'desktop', installed }))
      .toMatchObject({ id: 'alice.stats', version: '1.0.0', permissions: ['service:review'], requires: { 'dstu.chat': '^0.11' } });
    expect(assertInstallable(pkg('example.word-of-day'), { appVersion: '0.11.0', platform: 'desktop', installed }).id).toBe('example.word-of-day');
  });

  it('a beta app installs a plugin whose engines admit the prerelease and rejects one that needs the release', () => {
    const beta = { appVersion: '0.12.0-beta.1', platform: 'desktop' as const, installed: new Map([['dstu.chat', '0.12.0-beta.1']]) };
    expect(assertInstallable(pkg('alice.stats', { requires: { 'dstu.chat': '^0.12' } }, { engines: { deepStudent: '^0.12' } }), beta).id).toBe('alice.stats');
    expect(() => assertInstallable(pkg('alice.stats', {}, { engines: { deepStudent: '^0.12.0' } }), beta)).toThrow(
      expect.objectContaining({ code: 'ENGINE_INCOMPATIBLE' }),
    );
  });

  it.each([
    ['local.dev', pkg('local.dev'), 'ID_RESERVED'],
    ['test.fixture', pkg('test.fixture'), 'ID_RESERVED'],
    ['dstu.fake', pkg('dstu.fake'), 'ID_RESERVED'],
    ['engines', pkg('alice.xy', {}, { engines: { deepStudent: '^0.12' } }), 'ENGINE_INCOMPATIBLE'],
    ['platform', pkg('alice.xy', { platforms: ['mobile'] }), 'UNSUPPORTED_ON_PLATFORM'],
    ['requires', pkg('alice.xy', { requires: { 'alice.yz': '^1.0' } }), 'REQUIRES_MISSING'],
    ['requires range', pkg('alice.xy', { requires: { 'dstu.chat': '^0.12' } }), 'REQUIRES_INCOMPATIBLE'],
  ])('rejects %s', (_label, value, code) => {
    let error: unknown;
    try {
      assertInstallable(value, { appVersion: '0.11.0', platform: 'desktop', installed });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PluginLoadError);
    expect((error as PluginLoadError).code).toBe(code);
  });

  it('RF-W01-k7-kernel-service-install-denial: rejects service permissions that name kernel-only services before anything is written', () => {
    for (const service of ['commands', 'protocols', 'backendEvents', 'shell']) {
      expect(() => assertInstallable(pkg('alice.stats', { permissions: [`service:${service}`] }), { appVersion: '0.11.0', platform: 'desktop', installed }))
        .toThrow(expect.objectContaining({ code: 'KERNEL_API_FORBIDDEN' }));
      let error: unknown;
      try {
        assertInstallable(pkg('alice.stats', { permissions: [`service:${service}`] }), { appVersion: '0.11.0', platform: 'desktop', installed });
      } catch (caught) {
        error = caught;
      }
      expect((error as PluginLoadError).message).toBe(
        `KERNEL_API_FORBIDDEN: plugin "alice.stats" requests kernel-only services "service:${service}"; plugin API v1 does not open them to community plugins`,
      );
    }
    // 普通服务不受影响；kernel-only 只按 service 名精确匹配（service:commands2 是别的服务）。
    expect(assertInstallable(pkg('alice.stats', { permissions: ['service:commands2', 'service:review'] }), { appVersion: '0.11.0', platform: 'desktop', installed }).permissions)
      .toEqual(['service:commands2', 'service:review']);
  });
});
