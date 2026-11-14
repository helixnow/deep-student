import type {
  NativeStarlark,
  StarlarkEvaluateOptions,
  StarlarkJson,
} from './api.ts';
import { StarlarkToolFailure } from './api.ts';
export { StarlarkToolFailure } from './api.ts';
import { removeRun, runWasm, WasmCancelledError } from '../wasm/loader.ts';

type HostKind = 'call' | 'object_read' | 'object_write';

interface ReplayEntry {
  kind: HostKind;
  reply: 'value' | 'tool_error' | 'fatal';
  value?: StarlarkJson;
  error?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function executeHost(
  kind: HostKind,
  request: Record<string, unknown>,
  options: StarlarkEvaluateOptions,
): Promise<ReplayEntry> {
  try {
    if (kind === 'call') {
      try {
        const output = await options.call(
          String(request.tool),
          request.args as StarlarkJson,
        );
        return { kind, reply: 'value', value: output };
      } catch (error) {
        if (error instanceof StarlarkToolFailure) {
          return { kind, reply: 'tool_error', error: error.message };
        }
        return { kind, reply: 'fatal', error: messageOf(error) };
      }
    }
    const object = request.object as StarlarkJson;
    const hostOptions = request.options as StarlarkJson;
    if (kind === 'object_read') {
      try {
        const page = await options.objectRead(object, hostOptions);
        return { kind, reply: 'value', value: page };
      } catch (error) {
        return {
          kind,
          reply: 'fatal',
          error: `ptc_run: object_read failed: ${messageOf(error)}`,
        };
      }
    }
    try {
      const result = await options.objectWrite(object, hostOptions);
      return { kind, reply: 'value', value: result };
    } catch (error) {
      return {
        kind,
        reply: 'fatal',
        error: `ptc_run: object_write failed: ${messageOf(error)}`,
      };
    }
  } catch (error) {
    return { kind, reply: 'fatal', error: messageOf(error) };
  }
}

export const starlark: NativeStarlark = {
  async evaluate(script: string, options: StarlarkEvaluateOptions): Promise<StarlarkJson> {
    const replay: ReplayEntry[] = [];
    for (;;) {
      if (options.signal.aborted) {
        throw new Error('ptc_run script error: Evaluation cancelled');
      }
      const run = await runWasm({
        engine: 'starlark',
        script,
        limits: options.limits,
        deadline_ms: options.deadlineMs,
        replay,
      }, { signal: options.signal }).catch((error: unknown) => {
        if (error instanceof WasmCancelledError) throw new Error('ptc_run script error: Evaluation cancelled');
        throw error;
      });
      let response: Record<string, unknown>;
      try {
        response = run.response;
      } finally {
        await removeRun(run);
      }
      if (response.type === 'result') return response.value as StarlarkJson;
      if (response.type === 'error') throw new Error(String(response.message));
      if (response.type !== 'host_call') {
        throw new Error(`f7-native-wasm returned an unknown starlark response: ${String(response.type)}`);
      }
      const index = Number(response.index);
      const kind = String(response.kind) as HostKind;
      if (index !== replay.length) {
        throw new Error(
          `ptc_run: host bridge replay mismatch at call ${index} (expected ${replay.length})`,
        );
      }
      replay.push(await withCancellation(executeHost(kind, response.request as Record<string, unknown>, options), options.signal));
    }
  },
};

async function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new Error('ptc_run script error: Evaluation cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', cancel); }
}
