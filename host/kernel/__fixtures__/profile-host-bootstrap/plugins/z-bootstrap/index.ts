import { definePlugin } from '../../../../api.ts';
export default definePlugin<{ fail?: boolean }>({
  // The generator must recognize the service, not an alphabetic directory/id convention.
  meta: { id: 'fixture.z-bootstrap', provides: ['storageStartupSync'] },
  inject: ['paths'],
  apply(ctx, config) {
    (ctx.get('bootstrapTrace') as string[]).push('bootstrap');
    if (config?.fail) throw new Error('bootstrap apply failed');
    ctx.reflect.provide('storageStartupSync', {});
  },
});
