import { defineUiPlugin } from '@/ui-sdk';
import { workshopContributions } from './api';

export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.plugin-workshop', version: '1.0.0', host: true, platforms: ['desktop'] },
  apply(ctx) {
    ctx.ui.attach(workshopContributions, mount => mount(ctx));
  },
}), { order: 130 });
