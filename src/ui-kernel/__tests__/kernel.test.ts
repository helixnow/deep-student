import { describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel, type UiAdapters } from '../kernel';
import { compareCodePoints, SlotError, SlotStore } from '../slots';
import { installOfficialUiPlugins } from '../../ui-plugins/official/install';

function memoryAdapters() {
  const commands = new Map<string, unknown>();
  const blocks = new Map<string, unknown>();
  const adapters: UiAdapters = {
    commands: {
      register(cmd) {
        commands.set(cmd.id, cmd);
        return () => commands.delete(cmd.id);
      },
    },
    chatBlocks: {
      register(type, renderer) {
        if (blocks.has(type)) throw new Error(`dup ${type}`);
        blocks.set(type, renderer);
        return () => blocks.delete(type);
      },
    },
  };
  return { adapters, commands, blocks };
}

describe('UiKernel', () => {
  it('records contributions under the contributing plugin and revokes them on unload', async () => {
    const { adapters, commands, blocks } = memoryAdapters();
    const kernel = new UiKernel(adapters);
    await kernel.install(
      defineUiPlugin({
        meta: { id: 'community.hello' },
        apply(ctx) {
          ctx.ui.nav.register({ id: 'hello-nav', viewId: 'hello', labelKey: 'hello:title', order: 5 });
          ctx.ui.views.register({ id: 'hello', titleKey: 'hello:title', component: () => null });
          ctx.ui.commands.register({ id: 'hello.say' });
          ctx.ui.chat.registerBlock('hello-block', { type: 'hello-block' });
        },
      }),
    );
    expect(kernel.slots.list('nav').map((e) => [e.id, e.owner])).toEqual([['hello-nav', 'community.hello']]);
    expect(kernel.slots.get('views', 'hello')?.owner).toBe('community.hello');
    expect(commands.has('hello.say')).toBe(true);
    expect(blocks.has('hello-block')).toBe(true);

    await kernel.unload('community.hello');
    expect(kernel.slots.list('nav')).toEqual([]);
    expect(kernel.slots.get('views', 'hello')).toBeUndefined();
    expect(commands.size).toBe(0);
    expect(blocks.size).toBe(0);
  });

  it('orders list contributions by order then id across plugins', async () => {
    const kernel = new UiKernel();
    await kernel.install(defineUiPlugin({ meta: { id: 'a' }, apply: (ctx) => ctx.ui.nav.register({ id: 'z', viewId: 'z', labelKey: 'z', order: 1 }) }));
    await kernel.install(defineUiPlugin({ meta: { id: 'b' }, apply: (ctx) => ctx.ui.nav.register({ id: 'y', viewId: 'y', labelKey: 'y', order: 1 }) }));
    await kernel.install(defineUiPlugin({ meta: { id: 'c' }, apply: (ctx) => ctx.ui.nav.register({ id: 'x', viewId: 'x', labelKey: 'x', order: 9 }) }));
    expect(kernel.slots.list('nav').map((e) => e.id)).toEqual(['y', 'z', 'x']);
  });

  it('breaks order ties among community contributions by code point, not by the system locale', async () => {
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare');
    const kernel = new UiKernel();
    await kernel.install(defineUiPlugin({ meta: { id: 'acme.board' }, apply: (ctx) => ctx.ui.declareSlot({ name: 'acme.board.cards', cardinality: 'list' }) }));
    // An en-US collator would sort these 'Acme.a', 'acme.a_b', 'acme.a-b', 'acme.a:b', 'acme.a1', 'acme.ä', 'acme.b', 'acme.z'.
    const tied = ['acme.ä', 'acme.b', 'Acme.a', 'acme.a_b', 'acme.a-b', 'acme.z', 'acme.a1', 'acme.a:b'];
    for (const [index, id] of [...tied, 'first', 'last'].entries()) {
      const order = id === 'first' ? 1 : id === 'last' ? 9 : 3;
      await kernel.install(defineUiPlugin({ meta: { id: `acme.card-${index}` }, apply: (ctx) => ctx.ui.contribute('acme.board.cards', { id, order, value: id }) }));
    }
    expect(kernel.slots.list('acme.board.cards').map((e) => e.id)).toEqual([
      'first', 'Acme.a', 'acme.a-b', 'acme.a1', 'acme.a:b', 'acme.a_b', 'acme.b', 'acme.z', 'acme.ä', 'last',
    ]);
    expect(localeCompare).not.toHaveBeenCalled();
    localeCompare.mockRestore();
  });

  it('installs official plugins of equal order by id in code point order', async () => {
    const kernel = new UiKernel();
    const installed: string[] = [];
    const plugin = (id: string, order: number) => Object.assign(defineUiPlugin({ meta: { id }, apply: () => { installed.push(id); } }), { order });
    await installOfficialUiPlugins(kernel, [
      plugin('dstu.ui.b', 5), plugin('dstu.ui.a_b', 5), plugin('dstu.ui.a-b', 5), plugin('dstu.ui.Z', 5), plugin('dstu.ui.a1', 5), plugin('dstu.ui.first', 1),
    ]);
    expect(installed).toEqual(['dstu.ui.first', 'dstu.ui.Z', 'dstu.ui.a-b', 'dstu.ui.a1', 'dstu.ui.a_b', 'dstu.ui.b']);
    await kernel.dispose();
  });

  it('lists slot definitions by name in code point order', () => {
    const slots = new SlotStore();
    for (const name of ['b.x', 'a_b', 'B.y', 'a.b', 'a-b']) slots.declare({ name, cardinality: 'list' });
    expect(slots.definitions().map((def) => def.name)).toEqual(['B.y', 'a-b', 'a.b', 'a_b', 'b.x']);
  });

  it('compares strings by code point, astral characters included', () => {
    expect(compareCodePoints('a', 'a')).toBe(0);
    expect(compareCodePoints('ab', 'abc')).toBeLessThan(0);
    expect(compareCodePoints('Z', 'a')).toBeLessThan(0);
    // UTF-16 code units would put U+1F600 (a surrogate pair starting at 0xD83D) before U+FFFD.
    expect(['x\u{1F600}', 'x\uFFFD'].sort(compareCodePoints)).toEqual(['x\uFFFD', 'x\u{1F600}']);
    expect(['\u{1F601}', '\u{1F600}b', '\u{1F600}a'].sort(compareCodePoints)).toEqual(['\u{1F600}a', '\u{1F600}b', '\u{1F601}']);
  });

  it('rejects a second plugin claiming the same keyed slot key (it has to use a key of its own)', async () => {
    const kernel = new UiKernel();
    await kernel.install(defineUiPlugin({ meta: { id: 'official.search' }, apply: (ctx) => ctx.ui.views.register({ id: 'search', titleKey: 's', component: 1 }) }));
    const second = kernel.install(defineUiPlugin({ meta: { id: 'community.search' }, apply: (ctx) => ctx.ui.views.register({ id: 'search', titleKey: 's', component: 2 }) }));
    await expect(second).rejects.toBeInstanceOf(SlotError);
    await expect(second).rejects.toThrow('slot "views" key "search" is already provided by "official.search" (search); use a key of your own');
    expect(kernel.list()).toEqual(['official.search']);
    expect(kernel.slots.get('views', 'search')?.value).toMatchObject({ component: 1 });
  });

  it('replaces a plugin installed under the same id, revoking the old contributions', async () => {
    const kernel = new UiKernel();
    await kernel.install(defineUiPlugin({ meta: { id: 'dstu.search' }, apply: (ctx) => ctx.ui.views.register({ id: 'search', titleKey: 's', component: 'official' }) }));
    await kernel.install(defineUiPlugin({ meta: { id: 'dstu.search' }, apply: (ctx) => ctx.ui.views.register({ id: 'search', titleKey: 's', component: 'community' }) }));
    expect(kernel.slots.list('views').map((e) => e.value)).toEqual([{ id: 'search', titleKey: 's', component: 'community' }]);
  });

  it('rolls back every contribution when apply fails', async () => {
    const { adapters, commands } = memoryAdapters();
    const kernel = new UiKernel(adapters);
    await expect(
      kernel.install(
        defineUiPlugin({
          meta: { id: 'broken' },
          apply(ctx) {
            ctx.ui.nav.register({ id: 'n', viewId: 'v', labelKey: 'l' });
            ctx.ui.commands.register({ id: 'broken.cmd' });
            throw new Error('boom');
          },
        }),
      ),
    ).rejects.toThrow('boom');
    expect(kernel.list()).toEqual([]);
    expect(kernel.slots.list('nav')).toEqual([]);
    expect(commands.size).toBe(0);
  });

  it('fails loudly when an adapter-backed extension point is unavailable', async () => {
    const kernel = new UiKernel({});
    await expect(
      kernel.install(defineUiPlugin({ meta: { id: 'p' }, apply: (ctx) => ctx.ui.workbench.registerApp({ typeId: 'x' }) })),
    ).rejects.toThrow('workbenchApps adapter is not available');
  });

  it('lets plugins declare their own slots for sub-extensions', async () => {
    const kernel = new UiKernel();
    await kernel.install(
      defineUiPlugin({
        meta: { id: 'host.dashboard' },
        apply(ctx) {
          ctx.ui.declareSlot({ name: 'dashboard.widgets', cardinality: 'list' });
        },
      }),
    );
    await kernel.install(defineUiPlugin({ meta: { id: 'widget' }, apply: (ctx) => ctx.ui.contribute('dashboard.widgets', { id: 'w1', value: 'W' }) }));
    expect(kernel.slots.list('dashboard.widgets').map((e) => [e.id, e.owner])).toEqual([['w1', 'widget']]);
  });

  it('keeps snapshot references stable until something changes', async () => {
    const kernel = new UiKernel();
    const a = kernel.slots.list('nav');
    expect(kernel.slots.list('nav')).toBe(a);
    await kernel.install(defineUiPlugin({ meta: { id: 'p' }, apply: (ctx) => ctx.ui.nav.register({ id: 'n', viewId: 'v', labelKey: 'l' }) }));
    expect(kernel.slots.list('nav')).not.toBe(a);
  });
});
