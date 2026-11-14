/**
 * FE-A3 内核侧：Host 状态驱动的 UI 插件撤下 / 重装、插件内配对半、v1 右键菜单适配、平台枚举单一来源。
 */
import { describe, expect, it, vi } from 'vitest';
import { PLUGIN_PLATFORMS } from '../../../host/kernel/core';
import { defineUiPlugin, UiKernel } from '../kernel';
import { UI_PLATFORMS } from '../meta';

const manifest = (installed: string[], degraded: { id: string; reason: string }[] = []) => ({
  plugins: installed.map((id) => ({ id })),
  degraded,
});

const navIds = (kernel: UiKernel) => kernel.slots.list('nav').map((e) => `${e.owner}:${e.id}`);

describe('host status reconciliation', () => {
  it('installs paired plugins optimistically, withholds them while the Host half is missing and reinstalls on return', async () => {
    const kernel = new UiKernel();
    const applies: string[] = [];
    const plugin = defineUiPlugin({
      meta: { id: 'community.stats', host: true },
      apply(ctx) {
        applies.push(ctx.ui.hostStatus.state('community.stats'));
        ctx.ui.nav.register({ id: 'stats', viewId: 'stats', labelKey: 'stats' });
      },
    });
    expect(await kernel.install(plugin)).toBe(true);
    expect(navIds(kernel)).toEqual(['community.stats:stats']);

    kernel.hostStatus.update(manifest(['dstu.chat']));
    await kernel.settled();
    expect(navIds(kernel)).toEqual([]);
    expect(kernel.list()).toEqual([]);
    expect(kernel.pairing()).toEqual([{ id: 'community.stats', kind: 'plugin', hosts: ['community.stats'], availability: 'missing', active: false }]);
    expect(await kernel.install(plugin)).toBe(false);

    kernel.hostStatus.update(manifest(['dstu.chat', 'community.stats']));
    await kernel.settled();
    expect(navIds(kernel)).toEqual(['community.stats:stats']);
    expect(applies).toEqual(['unknown', 'online']);

    kernel.hostStatus.updateDegraded([{ id: 'community.stats', reason: 'missing service "db"' }]);
    await kernel.settled();
    expect(applies).toEqual(['unknown', 'online', 'degraded']);
    expect(kernel.pairing()).toEqual([{ id: 'community.stats', kind: 'plugin', hosts: ['community.stats'], availability: 'degraded', active: true }]);

    await kernel.unload('community.stats');
    expect(kernel.pairing()).toEqual([]);
    await kernel.dispose();
  });

  it('does not touch plugins when the manifest confirms the optimistic state', async () => {
    const kernel = new UiKernel();
    const apply = vi.fn((ctx) => ctx.ui.nav.register({ id: 'stats', viewId: 'stats', labelKey: 'stats' }));
    await kernel.install(defineUiPlugin({ meta: { id: 'community.stats', host: true }, apply }));
    await kernel.install(defineUiPlugin({ meta: { id: 'plain' }, apply: () => {} }));
    const changes = vi.fn();
    kernel.slots.subscribe(changes);
    kernel.hostStatus.update(manifest(['community.stats']));
    await kernel.settled();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(changes).not.toHaveBeenCalled();
    await kernel.dispose();
  });

  it('only infers degradation (never absence) from a status list without the v2 inventory', async () => {
    const kernel = new UiKernel();
    kernel.hostStatus.updateDegraded([{ id: 'dstu.anki', reason: 'x' }]);
    expect(kernel.hostStatus.known).toBe(false);
    expect(kernel.hostStatus.state('dstu.anki')).toBe('degraded');
    expect(kernel.hostStatus.state('dstu.chat')).toBe('unknown');
    expect(kernel.hostStatus.availability(['dstu.chat'])).toBe('available');
    await kernel.dispose();
  });
});

describe('ctx.ui.pair', () => {
  const frame = (degradedApplies: string[]) => defineUiPlugin({
    meta: { id: 'dstu.ui.frame' },
    async apply(ctx) {
      ctx.ui.nav.register({ id: 'home', viewId: 'home', labelKey: 'home', order: 10 });
      await ctx.ui.pair(defineUiPlugin({
        meta: { id: 'dstu.anki', host: true },
        apply(half) {
          const degraded = half.ui.hostStatus.state('dstu.anki') === 'degraded';
          degradedApplies.push(degraded ? 'degraded' : 'normal');
          half.ui.nav.register({ id: 'cards', viewId: 'cards', labelKey: degraded ? 'cards.unavailable' : 'cards', order: 20 });
        },
      }));
      ctx.ui.nav.register({ id: 'settings', viewId: 'settings', labelKey: 'settings', order: 30 });
    },
  });

  it('keeps half contributions under the frame plugin and swaps only the half on host changes', async () => {
    const kernel = new UiKernel();
    const applies: string[] = [];
    await kernel.install(frame(applies), { origin: 'builtin' });
    expect(navIds(kernel)).toEqual(['dstu.ui.frame:home', 'dstu.ui.frame:cards', 'dstu.ui.frame:settings']);
    expect(kernel.slots.list('nav').every((e) => e.origin === 'builtin')).toBe(true);
    expect(kernel.pairing()).toEqual([{ id: 'dstu.anki', kind: 'half', parent: 'dstu.ui.frame', hosts: ['dstu.anki'], availability: 'available', active: true }]);

    kernel.hostStatus.update(manifest([]));
    await kernel.settled();
    expect(navIds(kernel)).toEqual(['dstu.ui.frame:home', 'dstu.ui.frame:settings']);
    expect(kernel.list()).toEqual(['dstu.ui.frame']);

    kernel.hostStatus.update(manifest([], [{ id: 'dstu.anki', reason: 'boom' }]));
    await kernel.settled();
    expect(kernel.slots.list('nav').map((e) => (e.value as { labelKey: string }).labelKey)).toEqual(['home', 'cards.unavailable', 'settings']);
    expect(applies).toEqual(['normal', 'degraded']);

    kernel.hostStatus.update(manifest(['dstu.anki']));
    await kernel.settled();
    expect(navIds(kernel)).toEqual(['dstu.ui.frame:home', 'dstu.ui.frame:cards', 'dstu.ui.frame:settings']);
    expect(applies).toEqual(['normal', 'degraded', 'normal']);

    await kernel.unload('dstu.ui.frame');
    expect(kernel.pairing()).toEqual([]);
    kernel.hostStatus.update(manifest([]));
    await kernel.settled();
    expect(applies).toHaveLength(3);
    await kernel.dispose();
  });

  it('skips the half at install time when the host is already known to be missing', async () => {
    const kernel = new UiKernel();
    kernel.hostStatus.update(manifest([]));
    await kernel.install(frame([]), { origin: 'builtin' });
    expect(navIds(kernel)).toEqual(['dstu.ui.frame:home', 'dstu.ui.frame:settings']);
    await kernel.dispose();
  });

  it('rejects halves without a host and calls from outside a plugin', async () => {
    const kernel = new UiKernel();
    const half = defineUiPlugin({ meta: { id: 'x' }, apply: () => {} });
    await expect(kernel.install(defineUiPlugin({ meta: { id: 'p' }, apply: (ctx) => ctx.ui.pair(half) }))).rejects.toThrow(/must declare meta.host/);
    await expect(kernel.ui().pair(defineUiPlugin({ meta: { id: 'y', host: true }, apply: () => {} }))).rejects.toThrow(/only available inside a UI plugin/);
    await kernel.dispose();
  });
});

describe('v1 ctx.ui.contextMenu.register', () => {
  const context = (overrides: Record<string, unknown>) => ({ scope: 'empty', resourceItem: null, target: { type: 'empty' }, closeMenu: vi.fn(), ...overrides });

  it('contributes the ContentMenuContribution shape the official resource menu reads', async () => {
    const kernel = new UiKernel();
    const run = vi.fn();
    await kernel.install(defineUiPlugin({
      meta: { id: 'community.export' },
      apply: (ctx) => ctx.ui.contextMenu.register({ id: 'export', resourceTypes: ['note', 'folder'], labelKey: 'menu.export', order: 5, run }),
    }));
    const [entry] = kernel.slots.list('resource.contextMenu');
    const item = entry!.value as { id: string; order: number; labelKey: string; visible(c: unknown): boolean; run(c: unknown): void };
    expect(entry).toMatchObject({ id: 'export', order: 5, owner: 'community.export' });
    expect(item).toMatchObject({ id: 'export', order: 5, labelKey: 'community.export:menu.export' });

    const note = { id: 'n1', type: 'note' };
    const onNote = context({ scope: 'resource', resourceItem: note, target: { type: 'resource', resource: note } });
    expect(item.visible(onNote)).toBe(true);
    expect(item.visible(context({ scope: 'resource', resourceItem: { id: 'e', type: 'exam' } }))).toBe(false);
    expect(item.visible(context({ scope: 'trash-item', resourceItem: note }))).toBe(false);
    expect(item.visible(context({}))).toBe(false);
    const folder = { id: 'f1' };
    const onFolder = context({ scope: 'folder', target: { type: 'folder', folder: { folder } } });
    expect(item.visible(onFolder)).toBe(true);

    item.run(onNote);
    item.run(onFolder);
    expect(run.mock.calls).toEqual([[note], [folder]]);
    expect(onNote.closeMenu).toHaveBeenCalledTimes(1);
    await kernel.dispose();
  });

  it('matches folder items by itemType, keeps namespaced label keys and charges failures to the plugin', async () => {
    const kernel = new UiKernel();
    await kernel.install(defineUiPlugin({
      meta: { id: 'community.any' },
      apply: (ctx) => ctx.ui.contextMenu.register({ id: 'any', resourceTypes: ['*'], labelKey: 'common:ok', run: () => Promise.reject(new Error('nope')) }),
    }));
    const item = kernel.slots.list('resource.contextMenu')[0]!.value as { labelKey: string; visible(c: unknown): boolean; run(c: unknown): void };
    expect(item.labelKey).toBe('common:ok');
    const onItem = context({ scope: 'resource', target: { type: 'folderItem', item: { itemId: 'i', itemType: 'mindmap' } } });
    expect(item.visible(onItem)).toBe(true);
    item.run(onItem);
    await vi.waitFor(() => expect(kernel.errors.count('community.any')).toBe(1));
    await kernel.dispose();
  });
});

describe('platform vocabulary', () => {
  it('UI_PLATFORMS is the Host PLUGIN_PLATFORMS constant itself', () => {
    expect(UI_PLATFORMS).toBe(PLUGIN_PLATFORMS);
  });
});
