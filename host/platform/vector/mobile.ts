import { definePlugin } from '../../kernel/core.ts';
import { createMobileVector } from '../storage-mobile/vector-sqlite.ts';

export { createMobileVector };

export default definePlugin({
  meta: { id: 'dstu.vector', provides: ['vector'], platforms: ['mobile'] },
  inject: ['storage'],
  apply(ctx) {
    const service = createMobileVector(ctx.storage);
    ctx.effect(() => () => service.dispose());
    ctx.reflect.provide('vector', service);
  },
});
