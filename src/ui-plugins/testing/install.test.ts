import { expect, it } from 'vitest';
import { defineUiPlugin, UiKernel } from '../../ui-kernel/kernel';
import { installOfficialUiPlugins } from '../official/install';

it('installs real plugin fibers by order then id, keeping lazy factories unevaluated', async () => {
  const kernel = new UiKernel();
  const applied: string[] = [];
  let loaded = false;
  const lazy = () => { loaded = true; return Promise.resolve({ default: () => null }); };
  const plugin = (id: string, order: number) => ({ ...defineUiPlugin({
    meta: { id },
    apply(ctx) {
      applied.push(id);
      ctx.ui.views.register({ id, titleKey: `${id}:title`, component: lazy });
    },
  }), order });
  const plugins = [plugin('dstu.ui.z', 30), plugin('dstu.ui.b', 10), plugin('dstu.ui.a', 10)];
  const ready = installOfficialUiPlugins(kernel, plugins);
  // Cordis activates fibers asynchronously: consumers must await the completed installer.
  await ready;
  expect(applied).toEqual(['dstu.ui.a', 'dstu.ui.b', 'dstu.ui.z']);
  expect(plugins.map((entry) => entry.meta.id)).toEqual(['dstu.ui.z', 'dstu.ui.b', 'dstu.ui.a']);
  expect(kernel.slots.get<{ component: unknown }>('views', 'dstu.ui.a')?.value.component).toBe(lazy);
  expect(loaded).toBe(false);
  expect(kernel.slots.list('views').map(({ origin }) => origin)).toEqual(['builtin', 'builtin', 'builtin']);
  await kernel.dispose();
  expect(kernel.slots.list('views')).toEqual([]);
});
