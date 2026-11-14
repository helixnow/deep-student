/**
 * 插件平台声明与按平台生成 profile（W14）：缺省只进桌面；移动端只装配声明了 `mobile` 的插件，
 * 并优先选用目录下的 `mobile.ts`；`mobile.json` 与 `desktop.json` 一样由生成器守护。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateDesktopProfile, generateProfile } from './generate.ts';
import { DEFAULT_PLUGIN_PLATFORMS, pluginPlatforms, supportsPlatform } from './platforms.ts';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));

type Profile = { plugins: { id: string; module: string }[] };

describe('pluginPlatforms', () => {
  it('defaults to desktop only and validates declared platforms', () => {
    expect(pluginPlatforms({ id: 'a' })).toBe(DEFAULT_PLUGIN_PLATFORMS);
    expect(pluginPlatforms({ id: 'a', platforms: ['desktop', 'mobile'] })).toEqual(['desktop', 'mobile']);
    expect(supportsPlatform({ id: 'a' }, 'mobile')).toBe(false);
    expect(supportsPlatform({ id: 'a', platforms: ['mobile'] }, 'desktop')).toBe(false);
    expect(() => pluginPlatforms({ id: 'a', platforms: [] })).toThrow('a: meta.platforms must be a non-empty array');
    expect(() => pluginPlatforms({ id: 'a', platforms: ['desktop', 'desktop'] })).toThrow('duplicate platform desktop');
    expect(() => pluginPlatforms({ id: 'a', platforms: ['tv' as 'mobile'] })).toThrow('unknown platform "tv"');
  });
});

describe('generateProfile by platform', () => {
  it('desktop keeps undeclared plugins and ignores mobile.ts variants', async () => {
    const profile = JSON.parse(await generateProfile('desktop', `${FIXTURES}platform-host/`)) as Profile;
    expect(profile.plugins).toEqual([
      { id: 'dstu.plugins', module: '../kernel/plugins.ts' },
      { id: 'fixture.portable-svc', module: '../platform/portable/index.ts' },
      { id: 'fixture.svc', module: '../platform/svc/index.ts' },
      { id: 'fixture.chat', module: '../plugins/chat/index.ts' },
      { id: 'fixture.shell', module: '../plugins/shell/index.ts' },
    ]);
    expect(await generateDesktopProfile(`${FIXTURES}platform-host/`)).toBe(await generateProfile('desktop', `${FIXTURES}platform-host/`));
  });

  it('mobile keeps only plugins that declare mobile and prefers <dir>/mobile.ts', async () => {
    const profile = JSON.parse(await generateProfile('mobile', `${FIXTURES}platform-host/`)) as Profile;
    expect(profile.plugins).toEqual([
      { id: 'fixture.portable-svc', module: '../platform/portable/index.ts' },
      { id: 'fixture.svc', module: '../platform/svc/mobile.ts' },
      { id: 'fixture.chat', module: '../plugins/chat/index.ts' },
      { id: 'fixture.companion', module: '../plugins/companion/index.ts' },
    ]);
  });

  it('fails fast on unknown platforms and on a mobile.ts that does not declare mobile', async () => {
    await expect(generateProfile('desktop', `${FIXTURES}platform-host-invalid/`)).rejects.toThrow('fixture.bad: unknown platform "watch"');
    await expect(generateProfile('mobile', `${FIXTURES}platform-host-mismatch/`)).rejects.toThrow('platform/svc/mobile.ts must declare meta.platforms including "mobile"');
  });
});

describe('official profiles', () => {
  it('desktop.json registers the portable platform services', async () => {
    const desktop = JSON.parse(await readFile(new URL('./desktop.json', import.meta.url), 'utf8')) as Profile;
    expect(desktop.plugins).toEqual(expect.arrayContaining([
      { id: 'dstu.platform.crypto', module: '../platform/crypto/index.ts' },
      { id: 'dstu.platform.files', module: '../platform/files/index.ts' },
      { id: 'dstu.platform.http', module: '../platform/http/index.ts' },
    ]));
  });

  it('mobile.json is in sync with the generator and contains no desktop-only plugin', async () => {
    const generated = await generateProfile('mobile');
    const committed = await readFile(new URL('./mobile.json', import.meta.url), 'utf8');
    expect(committed).toBe(generated);
    const ids = (JSON.parse(generated) as Profile).plugins.map((plugin) => plugin.id);
    expect(ids).toContain('dstu.platform.crypto');
    expect((JSON.parse(generated) as Profile).plugins).toContainEqual({ id: 'dstu.platform.crypto', module: '../platform/crypto/mobile.ts' });
    for (const desktopOnly of ['dstu.plugins', 'dstu.shell']) {
      expect(ids).not.toContain(desktopOnly);
    }
    // 存储与文件服务在两端同 id：移动端必须装移动端实现（storage-mobile、files/mobile.ts），不能装桌面实现。
    const modules = (JSON.parse(generated) as Profile).plugins.map((plugin) => plugin.module);
    // 可移植平台服务都装配移动端实现（`mobile.ts`），桌面实现（`index.ts`）不能进移动端清单。
    for (const name of ['http', 'log', 'paths', 'settings', 'secrets', 'diagnostics']) {
      expect((JSON.parse(generated) as Profile).plugins).toContainEqual({ id: `dstu.platform.${name}`, module: `../platform/${name}/mobile.ts` });
      expect(modules).not.toContain(`../platform/${name}/index.ts`);
    }
    expect((JSON.parse(generated) as Profile).plugins).toContainEqual({ id: 'dstu.vector', module: '../platform/vector/mobile.ts' });
    expect(modules).toContain('../platform/storage-mobile/index.ts');
    expect(modules).not.toContain('../platform/storage/index.ts');
    expect((JSON.parse(generated) as Profile).plugins).toContainEqual({ id: 'dstu.platform.files', module: '../platform/files/mobile.ts' });
    expect(modules).not.toContain('../platform/files/index.ts');
  }, 120_000);

  it('mobile.json assembles a business plugin from host/plugins whose runtime closure is Node-free', async () => {
    const mobile = JSON.parse(await readFile(new URL('./mobile.json', import.meta.url), 'utf8')) as Profile;
    expect(mobile.plugins).toContainEqual({ id: 'dstu.integration', module: '../plugins/integration/index.ts' });
    const desktop = JSON.parse(await readFile(new URL('./desktop.json', import.meta.url), 'utf8')) as Profile;
    expect(desktop.plugins).toContainEqual({ id: 'dstu.integration', module: '../plugins/integration/index.ts' });
  });
});
