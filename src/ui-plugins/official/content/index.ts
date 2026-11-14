import { defineUiPlugin } from '@/ui-kernel/kernel';
import { officialMarkdownEntries, officialMenuEntries } from './entries';
import { MARKDOWN_PIPELINE_SLOTS, markdownPipelineContributions } from './pipeline';

export { officialMarkdownEntries, officialMenuEntries } from './entries';

export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.content' },
  apply(ctx) {
    for (const entry of officialMarkdownEntries) ctx.ui.contribute('markdown.codeBlocks', entry);
    for (const entry of officialMenuEntries) ctx.ui.contribute('resource.contextMenu', entry);
    // The remark/rehype steps load with MarkdownRenderer; contribute them whenever that happens.
    for (const slot of MARKDOWN_PIPELINE_SLOTS) ctx.ui.declareSlot(slot);
    ctx.ui.attach(markdownPipelineContributions, ({ slot, entry }) => ctx.ui.contribute(slot, entry));
  },
}), { order: 40 });
