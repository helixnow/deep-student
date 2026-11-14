import { defineUiPlugin } from '@/ui-kernel/kernel';
import { contributeCommands } from '@/command-palette/contribute';
import { devCommands } from '@/command-palette/modules/dev.commands';

/**
 * Developer commands. Only development builds install this plugin (`meta.devOnly`); the guard below also lets
 * production bundles drop the dev command module.
 */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.dev', devOnly: true },
  apply(ctx) {
    if (import.meta.env.DEV) contributeCommands(ctx, () => devCommands);
  },
}), { order: 180 });
