import { defineUiPlugin } from '@/ui-kernel/kernel';
import { contributeCommands } from '@/command-palette/contribute';
import { ankiCommands } from '@/command-palette/modules/anki.commands';

/** Anki commands. */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.anki' },
  apply(ctx) {
    contributeCommands(ctx, () => ankiCommands);
  },
}), { order: 170 });
