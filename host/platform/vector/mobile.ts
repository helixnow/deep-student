/** Native Lance indexes are unavailable in a Web Worker; do not silently return empty search results. */
import { definePlugin } from '../../kernel/core.ts';
import type { VectorService } from './api.ts';

export function createMobileVector(): VectorService {
  return {
    async connect() {
      throw new Error('UNSUPPORTED_ON_PLATFORM: vector.index is not available on mobile');
    },
  };
}

export default definePlugin({
  meta: { id: 'dstu.vector', provides: ['vector'], platforms: ['mobile'] },
  apply(ctx) { ctx.reflect.provide('vector', createMobileVector()); },
});
