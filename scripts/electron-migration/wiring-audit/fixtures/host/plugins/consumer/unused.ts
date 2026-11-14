import type { Context } from './context.ts';
export interface Unused { value: number }
export function unused(ctx: Context) { return ctx.get('dormant'); }
