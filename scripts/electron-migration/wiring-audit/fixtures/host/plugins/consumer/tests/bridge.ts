import type { Context } from '../context.ts';
export const bridge = {
  meta: { provides: ['real', 'old@1'] },
  apply(ctx: Context) { ctx.provide('real', {}); },
};
export const testHostOptions = { provide: { rpc: {}, oldAlias: {} } };
