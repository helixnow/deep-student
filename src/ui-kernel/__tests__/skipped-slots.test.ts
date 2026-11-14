import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel, type UiPlugin } from '../kernel';
import { normalizeUiPluginMeta, UiPluginMetaError, type UiPluginMeta } from '../meta';
import { SlotError } from '../slots';
import { installOfficialUiPlugins } from '../../ui-plugins/official/install';

const panelHost = (meta: Partial<UiPluginMeta> = {}) => defineUiPlugin({
  meta: { id: 'dstu.ui.panel-host', devOnly: true, slots: ['example.panels'], ...meta },
  apply: (ctx) => { ctx.ui.declareSlot({ name: 'example.panels', cardinality: 'list' }); },
});

const panelsFrom = (id: string, entries: string[]) => defineUiPlugin({
  meta: { id },
  apply: (ctx) => {
    for (const entry of entries) {
      const dispose = ctx.ui.contribute('example.panels', { id: entry, value: { id: entry } });
      expect(dispose).toBeTypeOf('function');
    }
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('contributions to the slots of a skipped plugin (meta.slots)', () => {
  it('production: a devOnly owner is skipped and community contributions to its slot are dropped silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kernel = new UiKernel({}, { build: 'production' });
    await expect(kernel.install(panelHost(), { origin: 'builtin' })).resolves.toBe(false);
    await expect(kernel.install(panelsFrom('acme.panels', ['a', 'b']))).resolves.toBe(true);
    expect(kernel.list()).toEqual(['acme.panels']);
    expect(kernel.slots.definition('example.panels')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    // A slot nobody lists is still a mistake.
    const typo = defineUiPlugin({ meta: { id: 'acme.typo' }, apply: (ctx) => { ctx.ui.contribute('example.panel', { id: 'a', value: {} }); } });
    await expect(kernel.install(typo)).rejects.toThrow('slot "example.panel" is not declared');
    await kernel.dispose();
  });

  it('development: a platform-skipped owner; the dropped contribution is warned about once per contributor and slot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kernel = new UiKernel({}, { build: 'development' });
    await expect(kernel.install(panelHost({ devOnly: false, platforms: ['mobile'] }), { origin: 'builtin' })).resolves.toBe(false);
    expect(kernel.skipped()).toEqual([{ id: 'dstu.ui.panel-host', reason: 'platform', platform: 'desktop', platforms: ['mobile'] }]);
    await expect(kernel.install(panelsFrom('acme.panels', ['a', 'b']))).resolves.toBe(true);
    await expect(kernel.install(panelsFrom('acme.panels', ['c']))).resolves.toBe(true);
    expect(warn.mock.calls).toEqual([
      ['[ui-plugins] acme.panels: contribution to slot "example.panels" skipped; the slot belongs to "dstu.ui.panel-host", which is not installed in this build'],
    ]);
    await expect(kernel.install(panelsFrom('acme.more-panels', ['d']))).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]![0]).toMatch(/^\[ui-plugins\] acme\.more-panels: contribution to slot "example\.panels" skipped/);
    await kernel.dispose();
  });

  it('a plugin skipped because what it requires was skipped passes its slots on too; installing the owner later declares the slot', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kernel = new UiKernel({}, { build: 'production' });
    await kernel.install(panelHost({ slots: undefined }), { origin: 'builtin' });
    const nested = defineUiPlugin({
      meta: { id: 'dstu.ui.panel-tabs', requires: ['dstu.ui.panel-host'], slots: ['example.panel-tabs'] },
      apply: (ctx) => { ctx.ui.declareSlot({ name: 'example.panel-tabs', cardinality: 'list' }); },
    });
    await expect(kernel.install(nested, { origin: 'builtin' })).resolves.toBe(false);
    const tabs = defineUiPlugin({ meta: { id: 'acme.tabs' }, apply: (ctx) => { ctx.ui.contribute('example.panel-tabs', { id: 't', value: {} }); } });
    await expect(kernel.install(tabs)).resolves.toBe(true);
    await expect(kernel.install(panelsFrom('acme.panels', ['a']))).rejects.toThrow('slot "example.panels" is not declared');

    const owner = defineUiPlugin({
      meta: { id: 'dstu.ui.panel-tabs', slots: ['example.panel-tabs'] },
      apply: (ctx) => { ctx.ui.declareSlot({ name: 'example.panel-tabs', cardinality: 'list' }); },
    });
    await expect(kernel.install(owner, { origin: 'builtin' })).resolves.toBe(true);
    await kernel.install(tabs);
    expect(kernel.slots.list('example.panel-tabs').map((e) => [e.owner, e.id])).toEqual([['acme.tabs', 't']]);
    await kernel.dispose();
  });

  it('a plugin that lists meta.slots may declare only those slots', async () => {
    const kernel = new UiKernel({}, { build: 'development' });
    await expect(kernel.install(panelHost(), { origin: 'builtin' })).resolves.toBe(true);
    const unlisted = defineUiPlugin({
      meta: { id: 'acme.boards', slots: ['acme.boards'] },
      apply: (ctx) => { ctx.ui.declareSlot({ name: 'acme.board-cards', cardinality: 'list' }); },
    });
    const failure = kernel.install(unlisted);
    await expect(failure).rejects.toThrow(SlotError);
    await expect(failure).rejects.toThrow('acme.boards: slot "acme.board-cards" is not listed in meta.slots; list every slot the plugin declares');
    expect(kernel.slots.definition('acme.board-cards')).toBeUndefined();
    await kernel.dispose();
  });

  it('the official installer records build-time stubs as skipped before installing the rest', async () => {
    const kernel = new UiKernel({}, { build: 'production' });
    const stub: UiPlugin = { name: 'dstu.ui.panel-host', meta: { id: 'dstu.ui.panel-host', devOnly: true, slots: ['example.panels'] }, apply() {} };
    const dependent = defineUiPlugin({
      meta: { id: 'dstu.ui.panel-extras', requires: ['dstu.ui.panel-host'] },
      apply: (ctx) => { ctx.ui.contribute('example.panels', { id: 'x', value: {} }); },
    });
    await installOfficialUiPlugins(kernel, [panelsFrom('dstu.ui.panels', ['a']), dependent], [stub]);
    expect(kernel.list()).toEqual(['dstu.ui.panels']);
    expect(kernel.skipped().map((s) => [s.id, s.reason])).toEqual([['dstu.ui.panel-extras', 'requires'], ['dstu.ui.panel-host', 'build']]);
    await kernel.dispose();
  });

  it('a stub whose plugin does apply at runtime is unloaded again (as if the build left the plugin out)', async () => {
    const kernel = new UiKernel({ platform: { kind: 'mobile', os: 'android', capabilities: [] } }, { build: 'production' });
    const stub: UiPlugin = { name: 'dstu.ui.phone', meta: { id: 'dstu.ui.phone', platforms: ['mobile'] }, apply() {} };
    await installOfficialUiPlugins(kernel, [], [stub]);
    expect(kernel.list()).toEqual([]);
    expect(kernel.skipped()).toEqual([]);
    await kernel.dispose();
  });

  it('normalizes and validates meta.slots', () => {
    expect(normalizeUiPluginMeta({ id: 'a' }).slots).toBeUndefined();
    const slots = ['a.one', 'a.two'];
    const meta = normalizeUiPluginMeta({ id: 'a', slots });
    expect(meta.slots).toEqual(['a.one', 'a.two']);
    expect(meta.slots).not.toBe(slots);
    expect(Object.isFrozen(meta.slots)).toBe(true);
    for (const bad of ['a.one', ['a.one', ''], ['a.one', 'a.one'], [1]]) {
      expect(() => normalizeUiPluginMeta({ id: 'a', slots: bad as never }), JSON.stringify(bad)).toThrow(new UiPluginMetaError('a: meta.slots must be an array of distinct non-empty slot names'));
    }
  });
});
