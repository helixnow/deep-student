import { defineUiPlugin } from '@/ui-kernel/kernel';
import { genuiComponentContributions } from '@/features/generative-ui/componentContributions';

/** Generative UI block components (`genui.components`, key = block type); the built-ins load with the renderer. */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.genui' },
  apply(ctx) {
    ctx.ui.declareSlot({ name: 'genui.components', cardinality: 'keyed', description: '生成式 UI 组件：key = block type' });
    ctx.ui.attach(genuiComponentContributions, (config) => {
      ctx.ui.contribute('genui.components', { id: `genui:${config.type}`, key: config.type, value: config });
    });
  },
}), { order: 60 });
