import { definePlugin } from '../../kernel/api.ts';
import { createVectorService } from './service.ts';

export default definePlugin({
  meta: { id: 'dstu.vector', lane: 'F7-native', commands: [], provides: ['vector'] },
  apply(ctx) {
    const vector = createVectorService();
    ctx.provide('vector', vector);
    ctx.effect(() => () => vector.dispose());
  },
});
