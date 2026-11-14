/** Observe the public Shell rejection; no replacement browser or error decoder. */
import { CommandError, definePlugin, ShellError } from '../../../host/kernel/api.ts';

export default definePlugin({
  meta: { id: 'fixture.browser-error', commands: ['browser_error_probe'] },
  apply(ctx) {
    ctx.commands.register<{ op: string; args: unknown }>('browser_error_probe', async ({ op, args }, call) => {
      try {
        return await ctx.shell.request(op, args);
      } catch (error) {
        if (!(error instanceof ShellError)) throw error;
        throw new CommandError({
          publicShellError: true, name: error.name, op: error.op,
          message: error.message, display: String(error),
          ...(error.data === undefined ? {} : { data: error.data }),
          source: call.source,
        });
      }
    });
  },
});
