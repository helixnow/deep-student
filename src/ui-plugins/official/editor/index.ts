import { defineUiPlugin } from '@/ui-sdk';
import { EDITOR_SLOTS, editorContributions } from './editorSlots';

/** Editor framework (FE-B5): owns `editor.extensions` / `editor.slashMenu` / `editor.selectionToolbar` / `editor.blockMenu`;
 * the official entries load with CrepeEditor. */
export default Object.assign(defineUiPlugin({
  meta: {
    id: 'dstu.ui.editor',
    core: true,
    slots: ['editor.extensions', 'editor.slashMenu', 'editor.selectionToolbar', 'editor.blockMenu'],
  },
  apply(ctx) {
    for (const slot of EDITOR_SLOTS) ctx.ui.declareSlot(slot);
    ctx.ui.attach(editorContributions, ({ slot, entry }) => ctx.ui.contribute(slot, entry));
  },
}), { order: 70 });
