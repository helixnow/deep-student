import { CommandError, definePlugin } from '../api.ts';

const nativeJson = JSON as typeof JSON & { rawJSON(text: string): Readonly<{ rawJSON: string }> };
export default definePlugin({
  meta: { id: 'fixture.raw-json', commands: ['fixture_raw_json'] },
  apply(ctx) {
    ctx.commands.register<{ mode: string }>('fixture_raw_json', ({ mode }) => {
      const value = mode === 'ordinary' ? { typed: Infinity, plain: { rawJSON: '1e400' } } : {
        raw: nativeJson.rawJSON('1e400'), typed: Infinity,
        decimal: nativeJson.rawJSON('1.234567890123456789'),
        nested: [nativeJson.rawJSON('-0'), nativeJson.rawJSON('-1e-400'), 9007199254740993n],
        plain: { rawJSON: '1e400' },
      };
      ctx.backendEvents.emit('fixture-raw-json', value);
      if (mode === 'error') throw new CommandError(value);
      return value;
    });
  },
});
