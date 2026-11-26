import { defineUiPlugin } from '@/ui-sdk';
import { mountAgentMeshPlugin } from './mount';

export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.agent-mesh', version: '1.0.0', host: true, platforms: ['desktop'] },
  apply(ctx) {
    mountAgentMeshPlugin(ctx);
  },
}), { order: 135 });
