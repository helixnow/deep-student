import { defineUiPlugin } from '@/ui-kernel/kernel';
import { contributeCommands } from '@/command-palette/contribute';
import { ankiCommands } from '@/command-palette/modules/anki.commands';

/** Anki commands + the review screen's card action slot. */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.anki' },
  apply(ctx) {
    ctx.ui.declareSlot({ name: 'review.cardActions', cardinality: 'list', description: '闪卡复习界面当前卡片的操作按钮：run 收到卡片 id 与正反面文本' });
    contributeCommands(ctx, () => ankiCommands);
  },
}), { order: 170 });
