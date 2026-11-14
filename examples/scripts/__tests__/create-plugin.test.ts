// @vitest-environment node
/**
 * 社区插件脚手架：在临时目录里生成插件，跑与仓库示例同一套一致性用例（examples/testing/conformance.ts）、
 * plugin-manifest 门禁（无新增）、类型检查，并按生产路径装载 Host 半与 UI 半。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { run as runManifestGate } from '../../../scripts/electron-migration/gate-checks/plugin-manifest.mjs';
import { checkManifest } from '../../../host/kernel/manifest.ts';
import { describeConformance } from '../../testing/conformance';
import { APP_VERSION, createUiKernel, examplePackages, installUiHalf, loadExample, REPO_ROOT, type ExampleManifest } from '../../testing/harness';
import { typecheck } from '../../testing/typecheck';
import { createPlugin, CreatePluginError } from '../create-plugin.mjs';

const SCRIPT = path.join(REPO_ROOT, 'examples', 'scripts', 'create-plugin.mjs');
/** 一次类型检查要解析 host/ 或 src/ 的整个导入闭包（本机约 1–10 秒）。 */
const TYPECHECK_TIMEOUT = 60_000;
/** 临时目录按门禁的目录结构放：<tmp>/package.json + <tmp>/examples/plugins/<目录>，门禁可以直接 --root 到这里。 */
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w27-create-plugin-')));
fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(tmp, 'package.json'));
const pluginsDir = path.join(tmp, 'examples', 'plugins');

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const repoExamples = examplePackages().map((e) => e.dirName);
const full = await createPlugin({ id: 'example.study-timer', out: path.join(pluginsDir, 'study-timer') });
const hostOnly = await createPlugin({ id: 'example.quick-host', out: path.join(pluginsDir, 'quick-host'), hostOnly: true });
const readPkg = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as ExampleManifest;

describe('generated plugin with both halves (example.study-timer)', () => {
  it('writes the Host half, UI half, manifest, i18n, profiles and a test', () => {
    expect(full.files).toEqual([
      '.gitignore', 'README.md', '__tests__/study-timer.test.tsx', 'i18n.ts', 'index.ts', 'package.json', 'test.profile.json', 'ui.tsx', 'user.profile.json',
    ]);
    expect(readPkg(full.out)).toMatchObject({
      name: 'deepstudent-plugin-study-timer',
      version: '0.1.0',
      engines: { deepStudent: `^${APP_VERSION.split('.').slice(0, 2).join('.')}` },
      deepStudent: { manifestVersion: 1, id: 'example.study-timer', platforms: ['desktop'], host: './index.ts', ui: './dist/ui.js' },
    });
  });

  describeConformance({ dir: full.out, pkg: readPkg(full.out), gateFile: 'examples/plugins/study-timer/package.json' });

  it('type-checks: Host half with the Host settings, UI half and test with the UI settings', () => {
    const files = (...names: string[]) => new Map(names.map((n) => [path.join(full.out, n), null]));
    expect(typecheck(files('index.ts'), 'host')).toEqual([]);
    expect(typecheck(files('ui.tsx', 'i18n.ts', '__tests__/study-timer.test.tsx'), 'ui')).toEqual([]);
  }, TYPECHECK_TIMEOUT);

  it('loads through the production profile loader; the UI half calls the Host half over plugin:host|call', async () => {
    const { host, result } = await loadExample(path.join(full.out, 'test.profile.json'));
    const { kernel, commands } = createUiKernel(host, { i18n: { addBundle: () => () => undefined } });
    try {
      expect(result.degraded).toEqual([]);
      const ui = (await import(path.join(full.out, 'ui.tsx'))).default;
      const { installed, host: remoteHost } = await installUiHalf(kernel, ui);
      expect(installed).toBe(true);
      expect(kernel.slots.list('views').map((e) => [e.key, e.owner, e.origin])).toEqual([['example.study-timer/main', 'example.study-timer', 'community']]);
      expect(commands.list().map((c) => c.id)).toEqual(['example.study-timer.open']);
      const remote = remoteHost.exampleStudyTimer!;
      await expect(remote.greet!('Ada')).resolves.toBe('Hello, Ada');
      await expect(remote.greet!('  ')).rejects.toBe('name is required');
    } finally {
      await kernel.dispose();
      await host.dispose();
    }
  });
});

describe('generated Host-only plugin (example.quick-host)', () => {
  it('has no UI half, build script or remote methods', async () => {
    expect(hostOnly.files).not.toContain('ui.tsx');
    expect(hostOnly.files).not.toContain('i18n.ts');
    expect(readPkg(hostOnly.out).deepStudent).not.toHaveProperty('ui');
    const plugin = (await import(path.join(hostOnly.out, 'index.ts'))).default;
    expect(plugin.meta).not.toHaveProperty('remote');
    expect(typecheck(new Map([[path.join(hostOnly.out, 'index.ts'), null], [path.join(hostOnly.out, '__tests__/quick-host.test.ts'), null]]), 'host')).toEqual([]);
  }, TYPECHECK_TIMEOUT);

  describeConformance({ dir: hostOnly.out, pkg: readPkg(hostOnly.out), gateFile: 'examples/plugins/quick-host/package.json' });
});

describe('plugin-manifest gate', () => {
  it('reports nothing for a tree holding only the generated plugins', () => {
    const result = runManifestGate({ root: tmp });
    expect(result.summary).toMatchObject({ examples: 2, existing: 0, fresh: 0 });
  });

  it('is unchanged on the repository: nothing was generated into examples/plugins', () => {
    expect(examplePackages().map((e) => e.dirName)).toEqual(repoExamples);
    expect(repoExamples).not.toContain('study-timer');
    expect(runManifestGate().summary).toMatchObject({ fresh: 0, stale: 0 });
  });
});

describe('ids and options', () => {
  it('derives the names of a community publisher and scopes the npm package by publisher', async () => {
    const out = path.join(tmp, 'community', 'study-stats');
    await createPlugin({ id: 'alice.study-stats', out });
    const pkg = readPkg(out);
    expect(pkg.name).toBe('@alice/deepstudent-plugin-study-stats');
    expect(checkManifest(pkg, { appVersion: APP_VERSION, context: 'community-install', platform: 'desktop', expectedId: 'alice.study-stats' }).ok).toBe(true);
    expect(fs.readFileSync(path.join(out, 'index.ts'), 'utf8')).toContain("provides: ['aliceStudyStats']");
  });

  it.each([
    ['community.notes', /publishers .*community are forbidden/],
    ['dstu.notes', /publisher "dstu" is reserved for built-in plugins/],
    ['Alice.Notes', /invalid plugin id/],
    ['notes', /invalid plugin id/],
  ])('refuses %s', async (id, message) => {
    await expect(createPlugin({ id, out: path.join(tmp, 'refused') })).rejects.toThrow(message);
    expect(fs.existsSync(path.join(tmp, 'refused'))).toBe(false);
  });

  it('refuses a non-empty directory unless --force', async () => {
    await expect(createPlugin({ id: 'example.study-timer', out: full.out })).rejects.toBeInstanceOf(CreatePluginError);
    await expect(createPlugin({ id: 'example.study-timer', out: full.out, force: true })).resolves.toMatchObject({ out: full.out });
  });

  it('CLI: lists the created files, and exits 1 with the reason for a forbidden id', () => {
    const ok = spawnSync(process.execPath, [SCRIPT, 'example.cli-check', '--out', path.join(tmp, 'cli-check'), '--host-only'], { encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain(`created ${path.join(tmp, 'cli-check')}`);
    expect(ok.stdout).toContain('  index.ts');
    const bad = spawnSync(process.execPath, [SCRIPT, 'community.cli-check', '--out', path.join(tmp, 'cli-bad')], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('forbidden');
  });
});
