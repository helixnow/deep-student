/** Test-only registered Host commands/events for the F1→F2 raw-source JSON transport test. */
import { CommandError, definePlugin } from '../../../host/kernel/api.ts';
import { jsonNumberToRawJSON, parseJsonDocument } from '../../../host/platform/util/api.ts';

function raw(text: string): unknown {
  const node = parseJsonDocument(text);
  if (node.kind !== 'number') throw new Error('expected numeric Value');
  return jsonNumberToRawJSON(node.value);
}

const payload = {
  raw: [raw('1e400'), raw('-1e400'), raw('-1e-400'), raw('-0'), raw('9007199254740993'), raw('1.5'), raw('-0.0')],
  typed: [Infinity, -Infinity, NaN, -0, 0, 1.5],
  lookalike: { rawJSON: '1e400' },
};
Object.freeze(payload.raw); Object.freeze(payload.typed); Object.freeze(payload.lookalike); Object.freeze(payload);

export default definePlugin({
  meta: { id: 'fixture.raw-json', commands: ['raw_json_success', 'raw_json_error', 'raw_json_binary', 'raw_json_ordinary'] },
  apply(ctx) {
    ctx.commands.register('raw_json_success', () => {
      ctx.backendEvents.emitTo({ kind: 'WebviewWindow', label: 'main' }, 'raw-source://value', payload);
      return payload;
    });
    ctx.commands.register('raw_json_error', () => { throw new CommandError(payload); });
    ctx.commands.register('raw_json_binary', () => new Uint8Array([0, 127, 255]));
    ctx.commands.register('raw_json_ordinary', () => {
      const ordinary = { typed: payload.typed, lookalike: payload.lookalike };
      ctx.backendEvents.emit('raw-source://ordinary', ordinary);
      return ordinary;
    });
  },
});
