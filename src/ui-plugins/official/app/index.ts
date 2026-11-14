import { defineUiPlugin } from '@/ui-kernel/kernel';
import { contributeCommands } from '@/command-palette/contribute';
import { getGlobalCommands } from '@/command-palette/modules/global.commands';
import { settingsCommands } from '@/command-palette/modules/settings.commands';

/** Application-wide commands: palette, window, zoom, theme, clipboard, and the settings shortcuts. */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.app' },
  apply(ctx) {
    contributeCommands(ctx, getGlobalCommands);
    contributeCommands(ctx, () => settingsCommands);
  },
}), { order: 130 });
