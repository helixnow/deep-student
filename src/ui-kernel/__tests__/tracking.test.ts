/**
 * 新服务必须经 getter（或普通方法）暴露：经 `ctx.ui` 访问时 Cordis 追踪代理把 `this.ctx` 换成调用方插件的 context。
 * 这里验证解构、跨 await、嵌套子 fiber、以及两个插件各自持有的 `ctx.ui` 引用都归属到正确的插件。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { defineUiPlugin, UiKernel } from '../kernel';
import { memoryStorageBackend } from '../services/storage';

describe('Cordis tracking proxy attribution for v2 services', () => {
  it('attributes destructured service accessors and post-await calls to the calling plugin', async () => {
    const navigate = vi.fn();
    const kernel = new UiKernel({ navigate, storage: memoryStorageBackend(), i18n: { addBundle: () => () => {}, languages: () => ['en-US'] } });
    await kernel.install(defineUiPlugin({ meta: { id: 'views' }, apply: (ctx) => ctx.ui.views.register({ id: 'home', titleKey: 'home', component: () => null }) }));
    const seen: Record<string, unknown> = {};
    await kernel.install(defineUiPlugin({ meta: { id: 'community.a' }, async apply(ctx) {
      const { storage, plugin, i18n } = ctx.ui;
      const go = ctx.ui.navigate;
      await Promise.resolve();
      storage.set('k', 'a');
      seen.plugin = plugin?.id;
      seen.namespace = i18n.namespace;
      seen.prefix = ctx.ui.storage.prefix;
      go('home');
    } }));
    expect(seen).toEqual({ plugin: 'community.a', namespace: 'community.a', prefix: 'ds:plugin:community.a:' });
    expect(navigate).toHaveBeenCalledWith({ view: 'home', params: undefined, source: 'community.a' });
    await kernel.dispose();
  });

  it('keeps two plugins\u2019 ctx.ui references apart', async () => {
    const kernel = new UiKernel({ storage: memoryStorageBackend() });
    const uis: Context['ui'][] = [];
    for (const id of ['community.one', 'community.two']) {
      await kernel.install(defineUiPlugin({ meta: { id }, apply: (ctx) => void uis.push(ctx.ui) }));
    }
    expect(uis.map((ui) => ui.plugin?.id)).toEqual(['community.one', 'community.two']);
    expect(uis.map((ui) => ui.storage.prefix)).toEqual(['ds:plugin:community.one:', 'ds:plugin:community.two:']);
    await kernel.dispose();
  });

  it('attributes nested child fibers to the owning plugin and revokes their state with it', async () => {
    const kernel = new UiKernel({ storage: memoryStorageBackend() });
    let store: ReturnType<Context['ui']['createStore']> | undefined;
    let prefix: string | undefined;
    const listener = vi.fn();
    await kernel.install(defineUiPlugin({ meta: { id: 'community.parent' }, async apply(ctx) {
      await ctx.plugin({
        name: 'child',
        apply(child) {
          prefix = child.ui.storage.prefix;
          store = child.ui.createStore({ n: 1 });
          child.ui.platform.subscribe(listener);
          child.ui.contribute('nav', { id: 'child-nav', value: { id: 'child-nav', viewId: 'v', labelKey: 'l' } });
        },
      });
    } }));
    expect(prefix).toBe('ds:plugin:community.parent:');
    expect(kernel.slots.list('nav').map((e) => e.owner)).toEqual(['community.parent']);
    store!.setState({ n: 2 });
    await kernel.unload('community.parent');
    expect(store!.getState()).toEqual({ n: 1 });
    kernel.platform.update({ os: 'linux' });
    expect(listener).not.toHaveBeenCalled();
    expect(kernel.slots.list('nav')).toEqual([]);
  });
});
