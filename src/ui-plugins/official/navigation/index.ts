import { defineUiPlugin } from '@/ui-kernel/kernel';
import { contributeCommands } from '@/command-palette/contribute';
import { getNavigationCommands } from '@/command-palette/modules/navigation.commands';

/** View navigation commands (palette and shortcuts). */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.navigation' },
  apply(ctx) {
    contributeCommands(ctx, getNavigationCommands);
  },
}), { order: 110 });
