/**
 * `host/profiles/generate.ts`: the official profile must also load the kernel-owned channel
 * plugin. Rust keeps `PluginManager` in Tauri state and calls `register_extensions()` on the
 * first line of `run()`, so `dstu.plugins` cannot depend on a business lane's index.ts.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateDesktopProfile } from '../../profiles/generate.ts';

const FIXTURES = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

describe('generateDesktopProfile', () => {
  it('prepends the kernel plugin and keeps business plugins sorted by directory', async () => {
    const profile = JSON.parse(await generateDesktopProfile(`${FIXTURES}profile-host/`)) as {
      plugins: { id: string; module: string }[];
    };
    expect(profile.plugins).toEqual([
      { id: 'dstu.plugins', module: '../kernel/plugins.ts' },
      // 平台插件默认导出 definePlugin；没有默认导出的纯模块（pure）跳过。
      { id: 'dstu.platform.demo', module: '../platform/demo/index.ts' },
      { id: 'dstu.alpha', module: '../plugins/alpha/index.ts' },
      { id: 'dstu.zeta', module: '../plugins/zeta/index.ts' },
    ]);
  });

  it('rejects duplicate plugin ids instead of silently loading the same id twice', async () => {
    await expect(generateDesktopProfile(`${FIXTURES}profile-host-duplicate/`)).rejects.toThrow('duplicate plugin id dstu.plugins');
  });

  it('keeps the committed desktop profile in sync with host/platform and host/plugins', async () => {
    // 等价于 `node host/profiles/generate.ts --check`：新增/删除插件目录后必须重新生成并提交。
    const generated = await generateDesktopProfile();
    const committed = await readFile(new URL('../../profiles/desktop.json', import.meta.url), 'utf8');
    expect(committed).toBe(generated);
    const parsed = JSON.parse(generated) as { plugins: { id: string; module: string }[] };
    expect(parsed.plugins[0]).toEqual({ id: 'dstu.plugins', module: '../kernel/plugins.ts' });
    expect(parsed.plugins[1]).toEqual({ id: 'dstu.sync-startup', module: '../plugins/sync/startup.ts' });
    // F2 的真实外壳插件也在官方清单中（不在 host/ 下，模块路径回退两级）。
    expect(parsed.plugins).toContainEqual({ id: 'dstu.shell', module: '../../electron/index.ts' });
    expect(parsed.plugins).toContainEqual({ id: 'dstu.vector', module: '../platform/vector/index.ts' });
    expect(parsed.plugins).toContainEqual({ id: 'dstu.platform.backup-config', module: '../platform/settings/backup-commands.ts' });
  }, 120_000);
});
