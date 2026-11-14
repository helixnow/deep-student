import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { defineUiPlugin, UiKernel } from '../kernel';
import { UiNavigationError } from '../services/navigation';
import { UiPluginDisposedError } from '../scope';

const viewPlugin = (id: string, viewId: string) =>
  defineUiPlugin({ meta: { id }, apply: (ctx) => ctx.ui.views.register({ id: viewId, titleKey: `${viewId}:title`, component: () => null }) });

async function capture(kernel: UiKernel, id = 'caller'): Promise<Context> {
  let captured: Context | undefined;
  await kernel.install(defineUiPlugin({ meta: { id }, apply: (ctx) => { captured = ctx; } }));
  return captured!;
}

describe('navigate service', () => {
  it('routes ctx.ui.navigate to the window navigator with the calling plugin as source', async () => {
    const navigate = vi.fn();
    const kernel = new UiKernel({ navigate });
    await kernel.install(viewPlugin('community.stats', 'stats'));
    const ctx = await capture(kernel, 'community.stats-commands');
    ctx.ui.navigate('stats', { returnTo: 'chat-v2' });
    expect(navigate).toHaveBeenCalledWith({ view: 'stats', params: { returnTo: 'chat-v2' }, source: 'community.stats-commands' });
    expect(ctx.ui.navigation.canNavigate('stats')).toBe(true);
    expect(ctx.ui.navigation.canNavigate('missing')).toBe(false);
    await kernel.dispose();
  });

  it('rejects views that are not registered in the views slot', async () => {
    const navigate = vi.fn();
    const kernel = new UiKernel({ navigate });
    const ctx = await capture(kernel);
    expect(() => ctx.ui.navigate('nope')).toThrow(UiNavigationError);
    expect(() => ctx.ui.navigate('nope')).toThrow('ctx.ui.navigate: unknown view "nope"');
    expect(navigate).not.toHaveBeenCalled();
    await kernel.dispose();
  });

  it('fails loudly when the window has no navigator', async () => {
    const kernel = new UiKernel();
    await kernel.install(viewPlugin('views', 'home'));
    const ctx = await capture(kernel);
    expect(() => ctx.ui.navigate('home')).toThrow('ctx.ui.navigate: no navigator is available in this window');
    expect(ctx.ui.navigation.canNavigate('home')).toBe(false);
    await kernel.dispose();
  });

  it('lets one framework plugin provide the navigator and reverts to the window default when it unloads', async () => {
    const fallback = vi.fn();
    const framework = vi.fn();
    const kernel = new UiKernel({ navigate: fallback });
    await kernel.install(viewPlugin('views', 'home'));
    await kernel.install(defineUiPlugin({ meta: { id: 'dstu.frame.shell' }, apply: (ctx) => ctx.ui.navigation.provide(framework) }));
    await expect(kernel.install(defineUiPlugin({ meta: { id: 'rival' }, apply: (ctx) => ctx.ui.navigation.provide(vi.fn()) })))
      .rejects.toThrow('ctx.ui.navigation.provide: a navigator is already provided by "dstu.frame.shell"');
    const ctx = await capture(kernel);
    ctx.ui.navigate('home');
    expect(framework).toHaveBeenCalledWith({ view: 'home', params: undefined, source: 'caller' });
    expect(fallback).not.toHaveBeenCalled();

    await kernel.unload('dstu.frame.shell');
    ctx.ui.navigate('home');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(framework).toHaveBeenCalledTimes(1);
    await kernel.dispose();
  });

  it('revokes navigation for an unloaded caller and for views whose owner unloaded', async () => {
    const navigate = vi.fn();
    const kernel = new UiKernel({ navigate });
    await kernel.install(viewPlugin('views', 'home'));
    let go: ((view: string) => void) | undefined;
    await kernel.install(defineUiPlugin({ meta: { id: 'caller' }, apply: (ctx) => { go = ctx.ui.navigate; } }));
    go!('home');
    expect(navigate).toHaveBeenCalledTimes(1);

    await kernel.unload('caller');
    expect(() => go!('home')).toThrow(UiPluginDisposedError);

    const other = await capture(kernel, 'other');
    await kernel.unload('views');
    expect(() => other.ui.navigate('home')).toThrow('unknown view "home"');
    expect(navigate).toHaveBeenCalledTimes(1);
    await kernel.dispose();
  });
});
