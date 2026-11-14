import type { Context } from './context.ts';
import type { Unused } from './unused.ts';
const OLD_NAME = 'old@1';
export default {
  meta: { id: 'fixture.consumer', lane: 'fixture', provides: [], commands: [] },
  inject: ['real'],
  apply(ctx: Context) {
    ctx.real.run();
    ctx.get(OLD_NAME);
    ctx['bracketMissing'];
    ctx.inject(['rpc'], linked => linked.rpc.run());
    ctx.inject(['childMissing'], () => {});
    const attach = (name: string) => ctx.get(name);
    attach('wrappedMissing');
    // ctx.commentOnly and ctx.get('commentMissing') are not consumers.
    const text = "ctx.stringOnly";
    void text;
    const optional = ctx.get('real');
    if (optional === undefined) return null;
    throw new Error('service not available: fixture');
  },
};

interface ToolContext { get(name: string): unknown; toolField: string }
export function tool(ctx: ToolContext) { return [ctx.toolField, ctx.get('notAService')]; }
export function configOnly(plugin: { apply(): void }) { plugin.apply(); }
