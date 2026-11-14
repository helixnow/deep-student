import { defineUiPlugin } from '@/ui-kernel/kernel';
import { contributeCommands } from '@/command-palette/contribute';
import { notesCommands } from '@/command-palette/modules/notes.commands';

/** Notes, Finder and mind map commands. */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.notes' },
  apply(ctx) {
    contributeCommands(ctx, () => notesCommands);
  },
}), { order: 140 });
