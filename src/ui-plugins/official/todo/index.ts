import { defineUiPlugin } from '@/ui-kernel/kernel';
import { contributeCommands } from '@/command-palette/contribute';
import { automationCommands } from '@/command-palette/modules/automation.commands';

/** Todo automation commands. */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.todo' },
  apply(ctx) {
    contributeCommands(ctx, () => automationCommands);
  },
}), { order: 160 });
