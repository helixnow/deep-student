import { definePlugin } from '../../../../api.ts';
export default definePlugin({
  meta: { id: 'dstu.platform.paths', provides: ['paths'] },
  apply(ctx) {
    (ctx.get('bootstrapTrace') as string[]).push('paths');
    ctx.reflect.provide('paths', {});
  },
});
