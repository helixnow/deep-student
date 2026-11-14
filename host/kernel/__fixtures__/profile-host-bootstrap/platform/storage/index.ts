import { definePlugin } from '../../../../api.ts';
export default definePlugin({
  meta: { id: 'dstu.platform.storage', provides: ['storage'] },
  inject: ['paths'],
  apply(ctx) {
    (ctx.get('bootstrapTrace') as string[]).push(ctx.get('storageStartupSync') ? 'storage:provider-ready' : 'storage:provider-missing');
    ctx.reflect.provide('storage', {});
  },
});
