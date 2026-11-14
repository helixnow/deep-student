import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { defineUiPlugin, STRICT_COMMUNITY_NAMESPACES, UiKernel, type UiAdapters, type UiPluginMeta } from '../kernel';

function memoryI18n(initial: readonly string[] = ['zh-CN', 'zh', 'en-US']) {
  let languages = [...initial];
  const listeners = new Set<() => void>();
  const bundles = new Map<string, Record<string, unknown>>();
  const adapter: NonNullable<UiAdapters['i18n']> = {
    addBundle: vi.fn((lng: string, ns: string, resources: Record<string, unknown>) => {
      bundles.set(`${lng}/${ns}`, resources);
      return () => void bundles.delete(`${lng}/${ns}`);
    }),
    languages: () => languages,
    onLanguageChanged: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    isReservedNamespace: (ns) => ['common', 'settings'].includes(ns),
  };
  return {
    adapter,
    bundles,
    setLanguages(next: string[]) {
      languages = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

async function pluginCtx(kernel: UiKernel, meta: UiPluginMeta, origin: 'builtin' | 'community' = 'community'): Promise<Context> {
  let ctx: Context | undefined;
  await kernel.install(defineUiPlugin({ meta, apply: (c) => { ctx = c; } }), { origin });
  return ctx!;
}

const zhCN = { title: '学习统计', greet: '你好，{{name}}', menu: { open: '打开' }, items_other: '{{count}} 项' };
const enUS = { title: 'Study stats', greet: 'Hello {{name}}', menu: { open: 'Open' }, items_one: '{{count}} item', items_other: '{{count}} items', onlyEn: 'English only' };

describe('i18n namespaces', () => {
  it('binds addBundles to the plugin namespace, resolves per language and forwards bundles to i18next', async () => {
    const i18n = memoryI18n();
    const kernel = new UiKernel({ i18n: i18n.adapter });
    const ctx = await pluginCtx(kernel, { id: 'community.study-stats' });
    const t = ctx.ui.i18n.addBundles({ 'zh-CN': zhCN, 'en-US': enUS });
    expect(ctx.ui.i18n.namespace).toBe('community.study-stats');
    expect(t('title')).toBe('学习统计');
    expect(t('greet', { name: 'Ada' })).toBe('你好，Ada');
    expect(t('menu.open')).toBe('打开');
    expect(t('onlyEn')).toBe('English only');
    expect(t('items', { count: 3 })).toBe('3 项');
    expect(t('absent', { defaultValue: 'Default {{x}}', x: 1 })).toBe('Default 1');
    expect([...i18n.bundles.keys()].sort()).toEqual(['en-US/community.study-stats', 'zh-CN/community.study-stats']);

    i18n.setLanguages(['en-US']);
    expect(t('title')).toBe('Study stats');
    expect(t('items', { count: 1 })).toBe('1 item');
    expect(t('items', { count: 2 })).toBe('2 items');
    expect(ctx.ui.i18n.t('title')).toBe('Study stats');
    await kernel.dispose();
  });

  it('never falls back into official or other plugins\u2019 namespaces', async () => {
    const i18n = memoryI18n(['en-US']);
    const kernel = new UiKernel({ i18n: i18n.adapter });
    const other = await pluginCtx(kernel, { id: 'community.other' });
    other.ui.i18n.addBundles({ 'en-US': { title: 'Other', secret: 'leak' } });
    const ctx = await pluginCtx(kernel, { id: 'community.mine' });
    const t = ctx.ui.i18n.addBundles({ 'en-US': { title: 'Mine' } });
    expect(t('title')).toBe('Mine');
    expect(t('secret')).toBe('secret');
    expect(t('community.other:title')).toBe('community.other:title');
    expect(t('common:save')).toBe('common:save');
    await kernel.dispose();
  });

  it('keeps v1 addBundle for fresh namespaces (API v1 plugins, deprecated) but rejects writes into reserved or foreign namespaces', async () => {
    const i18n = memoryI18n(['zh-CN']);
    const kernel = new UiKernel({ i18n: i18n.adapter }, { strictCommunityNamespaces: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const word = await pluginCtx(kernel, { id: 'community.word-of-day' });
    word.ui.i18n.addBundle('zh-CN', 'wordOfDay', { title: '每日单词' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('community.word-of-day: ctx.ui.i18n.addBundle into "wordOfDay" is deprecated'));
    expect(i18n.bundles.get('zh-CN/wordOfDay')).toEqual({ title: '每日单词' });
    expect(word.ui.i18n.t('wordOfDay:title')).toBe('每日单词');

    const intruder = await pluginCtx(kernel, { id: 'community.intruder' });
    expect(() => intruder.ui.i18n.addBundle('zh-CN', 'common', { save: 'x' })).toThrow('ctx.ui.i18n.addBundle: namespace "common" is reserved for official texts');
    expect(() => intruder.ui.i18n.addBundle('zh-CN', 'wordOfDay', { title: 'x' })).toThrow('ctx.ui.i18n.addBundle: namespace "wordOfDay" belongs to plugin "community.word-of-day"');
    expect(() => intruder.ui.i18n.addBundles({ 'zh-CN': {} })).not.toThrow();
    await expect(pluginCtx(kernel, { id: 'community.squatter', i18n: { namespace: 'community.intruder' } }))
      .rejects.toThrow('community.squatter: meta.i18n.namespace must be "community.squatter" (namespaces are derived from the plugin id)');
    expect(i18n.bundles.has('zh-CN/common')).toBe(false);

    const official = await pluginCtx(kernel, { id: 'dstu.ui.extra' }, 'builtin');
    official.ui.i18n.addBundle('zh-CN', 'common', { extra: '官方' });
    expect(i18n.bundles.get('zh-CN/common')).toEqual({ extra: '官方' });
    warn.mockRestore();
    await kernel.dispose();
  });

  it('strict mode rejects non-derived namespaces from API v1 community plugins as well; official plugins are not limited', async () => {
    expect(new UiKernel().strictCommunityNamespaces).toBe(STRICT_COMMUNITY_NAMESPACES);
    const i18n = memoryI18n(['zh-CN']);
    const kernel = new UiKernel({ i18n: i18n.adapter }, { strictCommunityNamespaces: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v1 = await pluginCtx(kernel, { id: 'example.word-of-day' });
    expect(() => v1.ui.i18n.addBundle('zh-CN', 'wordOfDay', { title: '每日单词' }))
      .toThrow('ctx.ui.i18n.addBundle: namespace "wordOfDay" is not derived from plugin id "example.word-of-day"; use "example.word-of-day" or ctx.ui.i18n.addBundles');
    expect(i18n.bundles.has('zh-CN/wordOfDay')).toBe(false);
    v1.ui.i18n.addBundle('zh-CN', 'example.word-of-day', { title: '每日单词' });
    expect(v1.ui.i18n.t('title')).toBe('每日单词');
    expect(i18n.bundles.get('zh-CN/example.word-of-day')).toEqual({ title: '每日单词' });
    expect(warn).not.toHaveBeenCalled();

    const official = await pluginCtx(kernel, { id: 'dstu.ui.extra' }, 'builtin');
    official.ui.i18n.addBundle('zh-CN', 'common', { extra: '官方' });
    expect(i18n.bundles.get('zh-CN/common')).toEqual({ extra: '官方' });
    warn.mockRestore();
    await kernel.dispose();
  });

  it('RF-W17-community-i18n-strict: a kernel built without options rejects non-derived namespaces from API v1 community plugins', async () => {
    const i18n = memoryI18n(['zh-CN']);
    const kernel = new UiKernel({ i18n: i18n.adapter });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const legacy = defineUiPlugin({
      meta: { id: 'example.legacy-words' },
      apply: (ctx) => ctx.ui.i18n.addBundle('zh-CN', 'legacyWords', { title: '旧词' }),
    });
    await expect(kernel.install(legacy, { origin: 'community' }))
      .rejects.toThrow('ctx.ui.i18n.addBundle: namespace "legacyWords" is not derived from plugin id "example.legacy-words"; use "example.legacy-words" or ctx.ui.i18n.addBundles');
    expect(i18n.bundles.has('zh-CN/legacyWords')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    const v1 = await pluginCtx(kernel, { id: 'example.words' });
    v1.ui.i18n.addBundle('zh-CN', 'example.words', { title: '单词' });
    expect(v1.ui.i18n.t('title')).toBe('单词');
    warn.mockRestore();
    await kernel.dispose();
  });

  it('limits community plugins to the namespace derived from their id (plugin ecosystem v1); official plugins are not limited', async () => {
    const i18n = memoryI18n(['en-US']);
    const kernel = new UiKernel({ i18n: i18n.adapter });
    const v2 = await pluginCtx(kernel, { id: 'example.stats', apiVersion: 2 });
    expect(() => v2.ui.i18n.addBundle('en-US', 'stats', { title: 'x' }))
      .toThrow('ctx.ui.i18n.addBundle: namespace "stats" is not derived from plugin id "example.stats"; use "example.stats" or ctx.ui.i18n.addBundles');
    expect(i18n.bundles.has('en-US/stats')).toBe(false);
    v2.ui.i18n.addBundle('en-US', 'example.stats', { title: 'Stats' });
    expect(v2.ui.i18n.t('title')).toBe('Stats');
    expect(i18n.bundles.get('en-US/example.stats')).toEqual({ title: 'Stats' });

    const colon = await pluginCtx(kernel, { id: 'legacy:tool', apiVersion: 2 });
    expect(colon.ui.i18n.namespace).toBe('legacy_tool');
    expect(() => colon.ui.i18n.addBundle('en-US', 'legacy_tool', { a: 'A' })).not.toThrow();
    await expect(pluginCtx(kernel, { id: 'example.named', i18n: { namespace: 'named' } })).rejects.toThrow('meta.i18n.namespace must be "example.named"');
    expect(await pluginCtx(kernel, { id: 'example.same', i18n: { namespace: 'example.same' } })).toBeDefined();

    const official = await pluginCtx(kernel, { id: 'dstu.ui.stats', apiVersion: 2, i18n: { namespace: 'officialStats' } }, 'builtin');
    expect(official.ui.i18n.namespace).toBe('officialStats');
    official.ui.i18n.addBundle('en-US', 'statsExtra', { title: 'Extra' });
    expect(i18n.bundles.get('en-US/statsExtra')).toEqual({ title: 'Extra' });
    await kernel.dispose();
  });

  it('still fails loudly for v1 addBundle when the window has no i18n adapter, while v2 bundles work', async () => {
    const kernel = new UiKernel();
    const ctx = await pluginCtx(kernel, { id: 'p' });
    expect(() => ctx.ui.i18n.addBundle('en-US', 'p', {})).toThrow('i18n adapter is not available');
    expect(ctx.ui.i18n.addBundles({ 'en-US': { hi: 'Hi' } })('hi')).toBe('Hi');
    await kernel.dispose();
  });

  it('removes bundles and releases namespaces on unload', async () => {
    const i18n = memoryI18n(['en-US']);
    const kernel = new UiKernel({ i18n: i18n.adapter }, { strictCommunityNamespaces: false });
    const ctx = await pluginCtx(kernel, { id: 'community.a' });
    const t = ctx.ui.i18n.addBundles({ 'en-US': { title: 'A' } });
    ctx.ui.i18n.addBundle('en-US', 'legacyA', { title: 'Legacy A' });
    await kernel.unload('community.a');
    expect([...i18n.bundles.keys()]).toEqual([]);
    expect(t('title')).toBe('title');

    const again = await pluginCtx(kernel, { id: 'community.a', version: '2.0.0' });
    expect(again.ui.i18n.addBundles({ 'en-US': { title: 'A2' } })('title')).toBe('A2');
    const b = await pluginCtx(kernel, { id: 'community.b' });
    b.ui.i18n.addBundle('en-US', 'legacyA', { title: 'B legacy' });
    expect(b.ui.i18n.t('legacyA:title')).toBe('B legacy');
    await kernel.dispose();
  });

  it('useT re-renders plugin components when the language changes', async () => {
    const i18n = memoryI18n(['zh-CN']);
    const kernel = new UiKernel({ i18n: i18n.adapter });
    const ctx = await pluginCtx(kernel, { id: 'community.study-stats' });
    ctx.ui.i18n.addBundles({ 'zh-CN': zhCN, 'en-US': enUS });
    function Title() {
      const t = ctx.ui.i18n.useT();
      return <h1>{t('title')}</h1>;
    }
    render(<Title />);
    expect(screen.getByRole('heading').textContent).toBe('学习统计');
    act(() => i18n.setLanguages(['en-US']));
    expect(screen.getByRole('heading').textContent).toBe('Study stats');
    await kernel.dispose();
  });
});
