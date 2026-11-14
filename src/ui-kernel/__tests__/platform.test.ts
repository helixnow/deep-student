import { describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel } from '../kernel';
import { createDesktopPlatform, DESKTOP_CAPABILITIES } from '../services/platform';

describe('platform service', () => {
  it('defaults to the desktop implementation and exposes it on ctx.ui.platform', async () => {
    const kernel = new UiKernel();
    let seen: { kind: string; os: string; capabilities: readonly string[]; hasMultiWindow: boolean } | undefined;
    await kernel.install(defineUiPlugin({ meta: { id: 'p' }, apply(ctx) {
      const { kind, os, capabilities } = ctx.ui.platform;
      seen = { kind, os, capabilities, hasMultiWindow: ctx.ui.platform.has('multi-window') };
    } }));
    expect(seen).toEqual({ kind: 'desktop', os: 'unknown', capabilities: [...DESKTOP_CAPABILITIES], hasMultiWindow: true });
    expect(kernel.platform.current).toEqual(createDesktopPlatform());
    expect(Object.isFrozen(kernel.platform.current)).toBe(true);
    await kernel.dispose();
  });

  it('accepts a shell-provided platform (mobile is an interface only in this round) and validates it', () => {
    expect(new UiKernel({ platform: { kind: 'mobile', os: 'android', capabilities: ['touch'] } }).platform.current.kind).toBe('mobile');
    expect(() => new UiKernel({ platform: { kind: 'tablet', os: 'android', capabilities: [] } as never })).toThrow('ui platform: unknown kind "tablet" (expected desktop | mobile)');
  });

  it('lets the shell refine os and capabilities later but never the platform kind', () => {
    const kernel = new UiKernel();
    const listener = vi.fn();
    kernel.platform.subscribe(listener);
    kernel.platform.update({ os: 'macos', capabilities: ['multi-window'] });
    expect(kernel.platform.current).toEqual({ kind: 'desktop', os: 'macos', capabilities: ['multi-window'] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => kernel.platform.update({ kind: 'mobile' } as never)).toThrow('ui platform: kind is fixed for the lifetime of a window');
  });

  it('revokes platform subscriptions made by a plugin when it unloads', async () => {
    const kernel = new UiKernel();
    const listener = vi.fn();
    await kernel.install(defineUiPlugin({ meta: { id: 'watcher' }, apply(ctx) { ctx.ui.platform.subscribe(listener); } }));
    kernel.platform.update({ os: 'linux' });
    expect(listener).toHaveBeenCalledTimes(1);
    await kernel.unload('watcher');
    kernel.platform.update({ os: 'windows' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
