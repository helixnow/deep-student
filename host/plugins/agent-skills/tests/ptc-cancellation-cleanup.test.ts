import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { NativeStarlark } from '../../../platform/native/starlark/api.ts';
import { PtcExecutor, type PtcExecutionContext } from '../src/tools/ptc-executor.ts';

function context(signal: AbortSignal): PtcExecutionContext {
  return {
    sessionId: 'session', messageId: 'message', blockId: 'block', toolCallId: 'ptc',
    cancel: signal,
    dispatcher: {
      async dispatchWithAdmission(call) {
        return { toolName: call.name, input: call.arguments, output: null, success: true };
      },
    },
  };
}

const call = { id: 'ptc', name: 'builtin-ptc_run', arguments: { script: 'None' } };

describe('PTC cancellation resource cleanup', () => {
  it.each([false, true])('releases the parent listener after script failure=%s', async (fails) => {
    const parent = new AbortController();
    const executor = new PtcExecutor({
      nativeStarlark: {
        async evaluate() {
          if (fails) throw new Error('script failed');
          return null;
        },
      },
    });
    const result = await executor.execute(call, context(parent.signal));
    expect(result.success).toBe(!fails);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
  });

  it('does not accumulate cancellation listeners across completed sub-tool calls', async () => {
    const nativeStarlark: NativeStarlark = {
      async evaluate(_script, options) {
        for (let i = 0; i < 12; i += 1) {
          await options.call('rag_search', {});
          expect(getEventListeners(options.signal, 'abort')).toHaveLength(0);
        }
        return null;
      },
    };
    const result = await new PtcExecutor({ nativeStarlark })
      .execute(call, context(new AbortController().signal));
    expect(result.success).toBe(true);
  });

  it('releases the parent listener when the native service resolver throws', async () => {
    const parent = new AbortController();
    const executor = new PtcExecutor({ nativeStarlark: () => { throw new Error('service unavailable'); } });
    await expect(executor.execute(call, context(parent.signal))).rejects.toThrow('service unavailable');
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
  });

  it('still cancels an in-flight sub-tool when the parent is cancelled', async () => {
    const parent = new AbortController();
    const ctx = context(parent.signal);
    let childSignal: AbortSignal | undefined;
    ctx.dispatcher = {
      async dispatchWithAdmission(call, sub) {
        childSignal = sub.cancel;
        parent.abort();
        return { toolName: call.name, input: call.arguments, output: null, success: true };
      },
    };
    const executor = new PtcExecutor({
      nativeStarlark: {
        async evaluate(_script, options) {
          await options.call('rag_search', {});
          if (options.signal.aborted) throw new Error('cancelled');
          return null;
        },
      },
    });
    const result = await executor.execute(call, ctx);
    expect(result.success).toBe(false);
    expect(childSignal?.aborted).toBe(true);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
  });
});
