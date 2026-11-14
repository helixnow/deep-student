import { defineUiPlugin } from '@/ui-sdk';
import { debugPanelContributions } from './api';

/**
 * Analysis Panel entries (development builds only). The official panels load with the debug panel chunk and
 * announce themselves there (`src/debug-panel/panels.ts`); this plugin declares `debug.panels` and contributes each
 * one, in announcement order.
 */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.debug', devOnly: true, slots: ['debug.panels'] },
  apply(ctx) {
    ctx.ui.declareSlot({ name: 'debug.panels', cardinality: 'list', description: '调试面板：id = 面板 id（仅开发构建）' });
    if (!import.meta.env.DEV) return;
    let order = 0;
    ctx.effect(() => debugPanelContributions.attach((panel) => {
      ctx.ui.contribute('debug.panels', { id: panel.id, order: order++, value: panel });
    }), 'debug.panels');
  },
}), { order: 190 });
