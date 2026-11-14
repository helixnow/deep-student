import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { readShellPlatform } from '@/ui-kernel/services/shell-platform';
import { DESKTOP_CAPABILITIES, MOBILE_CAPABILITIES, UiPlatformService } from '@/ui-kernel/services/platform';
import { UI_PLATFORMS } from '@/ui-kernel/meta';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';

/** What the Electron preload exposes (W06 electron/API.md): frozen, `process.platform` / `process.arch` names. */
const preload = (os: string, arch = 'arm64', kind = 'desktop') => Object.freeze({ kind, os, arch });

afterEach(() => {
  delete (globalThis as { __DS_PLATFORM__?: unknown }).__DS_PLATFORM__;
});

describe('shell platform bridge (FE-A5)', () => {
  it('normalizes process.platform names and keeps arch', () => {
    expect(readShellPlatform(preload('darwin'))).toEqual({ kind: 'desktop', os: 'macos', arch: 'arm64' });
    expect(readShellPlatform(preload('win32', 'x64'))).toEqual({ kind: 'desktop', os: 'windows', arch: 'x64' });
    expect(readShellPlatform(preload('linux', 'x64'))).toEqual({ kind: 'desktop', os: 'linux', arch: 'x64' });
    expect(readShellPlatform({ kind: 'mobile', os: 'android' })).toEqual({ kind: 'mobile', os: 'android' });
    expect(readShellPlatform({ kind: 'mobile', os: 'iOS' })).toEqual({ kind: 'mobile', os: 'ios' });
    expect(readShellPlatform(preload('freebsd'))).toEqual({ kind: 'desktop', os: 'unknown', arch: 'arm64' });
    expect(readShellPlatform(preload('constructor'))).toMatchObject({ os: 'unknown' });
  });

  it('is undefined without a shell or for anything that is not a platform description', () => {
    expect(readShellPlatform()).toBeUndefined();
    for (const value of [null, 'desktop', 1, {}, { kind: 'web', os: 'darwin' }, { kind: 'Desktop' }]) {
      expect(readShellPlatform(value)).toBeUndefined();
    }
  });

  it('reads globalThis.__DS_PLATFORM__ by default', () => {
    globalThis.__DS_PLATFORM__ = preload('darwin', 'x64');
    expect(readShellPlatform()).toEqual({ kind: 'desktop', os: 'macos', arch: 'x64' });
  });

  it('accepts exactly the kernel platform kinds', () => {
    for (const kind of UI_PLATFORMS) expect(readShellPlatform({ kind, os: 'linux' })?.kind).toBe(kind);
    expect([...UI_PLATFORMS].sort()).toEqual(['desktop', 'mobile']);
  });
});

describe('kernel platform service defaults to the shell (ctx.ui.platform)', () => {
  it('without a shell keeps the desktop default with os unknown', () => {
    expect(new UiPlatformService().current).toEqual({ kind: 'desktop', os: 'unknown', capabilities: [...DESKTOP_CAPABILITIES] });
  });

  it('with the Electron preload starts as that desktop, os and arch included', async () => {
    globalThis.__DS_PLATFORM__ = preload('win32', 'x64');
    const kernel = new UiKernel();
    let ctx: Context | undefined;
    await kernel.install(defineUiPlugin({ meta: { id: 'example.platform' }, apply: (c) => { ctx = c; } }));
    expect(ctx!.ui.platform).toMatchObject({ kind: 'desktop', os: 'windows', arch: 'x64', capabilities: [...DESKTOP_CAPABILITIES] });
    expect(ctx!.ui.platform.has('multi-window')).toBe(true);
    await kernel.dispose();
  });

  it('with a mobile shell skips desktop-only plugins; an explicit platform still wins', async () => {
    globalThis.__DS_PLATFORM__ = { kind: 'mobile', os: 'android' };
    const kernel = new UiKernel();
    expect(kernel.platform.current).toEqual({ kind: 'mobile', os: 'android', capabilities: [...MOBILE_CAPABILITIES] });
    expect(await kernel.install(defineUiPlugin({ meta: { id: 'example.desk', platforms: ['desktop'] }, apply() {} }))).toBe(false);
    expect(kernel.skipped()).toEqual([{ id: 'example.desk', reason: 'platform', platform: 'mobile', platforms: ['desktop'] }]);
    await kernel.dispose();

    const explicit = new UiKernel({ platform: { kind: 'desktop', os: 'linux', capabilities: [] } });
    expect(explicit.platform.current).toEqual({ kind: 'desktop', os: 'linux', capabilities: [] });
    await explicit.dispose();
  });
});
