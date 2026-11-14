/** Transport-only probes; insight_list itself is the production review command. */
import { CommandError, definePlugin } from '../../../host/kernel/api.ts';

export default definePlugin({
  meta: { id: 'fixture.inbound-json', commands: ['inbound_echo', 'inbound_error', 'inbound_bytes', 'inbound_denied'] },
  apply(ctx) {
    ctx.commands.register('inbound_echo', (args, call) => ({ args, payload: call.payload, source: call.source, headers: call.headers }));
    ctx.commands.register('inbound_bytes', (_args, call) => call.payload);
    ctx.commands.register('inbound_error', () => { throw new CommandError({ error_type: 'Validation', message: 'inbound failure', details: null }); });
    ctx.commands.register('inbound_denied', () => { throw new Error('ACL must reject before handler'); });
  },
});
