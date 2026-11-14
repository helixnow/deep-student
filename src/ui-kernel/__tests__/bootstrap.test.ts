import { waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import i18n from '@/i18n';
import { addAppEventListener, APP_EVENTS } from '@/events/app';
import { defineUiPlugin, STRICT_COMMUNITY_NAMESPACES, type UiKernel, type UiKernelOptions } from '../kernel';
import { createAppUiKernel } from '../bootstrap';

// The first assembly loads the official plugins' whole module graph; that is shared setup, not what any case checks.
beforeAll(async () => {
  await (await createAppUiKernel()).dispose();
});

let kernel: UiKernel | undefined;
let assembling: Promise<UiKernel> | undefined;
async function assemble(options?: UiKernelOptions): Promise<UiKernel> {
  assembling = createAppUiKernel(options);
  kernel = await assembling;
  return kernel;
}
afterEach(async () => {
  // A case that times out may leave its assembly running; it registers app-wide commands, so it is disposed here too.
  const pending = assembling;
  assembling = undefined;
  const current = kernel ?? (await pending?.catch(() => undefined));
  kernel = undefined;
  await current?.dispose();
});

async function plugin(id: string, origin: 'builtin' | 'community' = 'community'): Promise<Context> {
  let ctx: Context | undefined;
  await kernel!.install(defineUiPlugin({ meta: { id }, apply: (c) => { ctx = c; } }), { origin });
  return ctx!;
}

describe('production UI kernel assembly (createAppUiKernel)', () => {
  it('provides the desktop platform and refines os from the existing platform helper', async () => {
    await assemble();
    expect(kernel.platform.current.kind).toBe('desktop');
    await waitFor(() => expect(kernel!.platform.current.os).not.toBe('unknown'));
  });

  it('navigates through the existing NAVIGATE_TO_VIEW app event', async () => {
    await assemble();
    const details: unknown[] = [];
    const stop = addAppEventListener(APP_EVENTS.NAVIGATE_TO_VIEW, (detail) => details.push(detail));
    try {
      const ctx = await plugin('community.nav');
      ctx.ui.navigate('settings', { returnTo: 'chat-v2' });
      await waitFor(() => expect(details).toEqual([{ returnTo: 'chat-v2', view: 'settings' }]));
    } finally {
      stop();
    }
  });

  it('follows the kernel default for community i18n strict mode', async () => {
    await assemble();
    expect(kernel.strictCommunityNamespaces).toBe(STRICT_COMMUNITY_NAMESPACES);
  });

  it('guards official i18n namespaces and restores an official bundle after a builtin plugin unloads', async () => {
    // 社区插件只有在兼容模式下才能走到“官方保留命名空间”这道检查（严格模式先报“非派生命名空间”）。
    await assemble({ strictCommunityNamespaces: false });
    const original = JSON.parse(JSON.stringify(i18n.getResourceBundle('en-US', 'common')));
    expect(Object.keys(original).length).toBeGreaterThan(0);

    const community = await plugin('community.words');
    expect(() => community.ui.i18n.addBundle('en-US', 'common', { w17Probe: 'x' })).toThrow('namespace "common" is reserved for official texts');
    community.ui.i18n.addBundle('en-US', 'w17Words', { title: 'Words' });
    expect(i18n.getResource('en-US', 'w17Words', 'title')).toBe('Words');

    const official = await plugin('dstu.ui.w17probe', 'builtin');
    official.ui.i18n.addBundle('en-US', 'common', { w17Probe: 'probe' });
    expect(i18n.getResource('en-US', 'common', 'w17Probe')).toBe('probe');
    await kernel.unload('dstu.ui.w17probe');
    expect(i18n.getResource('en-US', 'common', 'w17Probe')).toBeUndefined();
    expect(i18n.getResourceBundle('en-US', 'common')).toEqual(original);

    await kernel.unload('community.words');
    expect(i18n.hasResourceBundle('en-US', 'w17Words')).toBe(false);
  });

  it('exposes subscribable views of the legacy registries with kernel conflict semantics', async () => {
    await assemble();
    expect(kernel.registries.commands.available).toBe(true);
    expect(kernel.registries.chatBlocks.available).toBe(true);
    expect(kernel.registries.workbenchApps.available).toBe(true);
    const ctx = await plugin('community.block');
    let notified = 0;
    const off = kernel.registries.chatBlocks.subscribe(() => notified++);
    ctx.ui.chat.registerBlock('w17-probe-block', { type: 'w17-probe-block', component: () => null });
    expect(notified).toBe(1);
    expect(kernel.registries.chatBlocks.get('w17-probe-block')).toMatchObject({ type: 'w17-probe-block' });
    await kernel.unload('community.block');
    expect(kernel.registries.chatBlocks.get('w17-probe-block')).toBeUndefined();
    expect(notified).toBe(2);
    off();
  });
});
