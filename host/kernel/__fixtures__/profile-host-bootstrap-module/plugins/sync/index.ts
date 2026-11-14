import { definePlugin } from '../../../../api.ts';
export default definePlugin({
  meta: { id: 'fixture.sync', provides: ['sync'] },
  inject: ['storage'],
  apply(ctx) {
    (ctx.get('bootstrapTrace') as string[]).push('sync');
    ctx.provide('sync', {});
  },
});
