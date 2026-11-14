import { describe, expect, it } from 'vitest';
import type { StarlarkEvaluateOptions, StarlarkJson } from '../starlark/api.ts';
import { StarlarkToolFailure } from '../starlark/api.ts';
import { starlark } from '../starlark/index.ts';

const limits = { max_callstack_size: 256, max_heap_bytes: 32 * 1024 * 1024, max_tick_count: 10_000_000 };

function options(overrides: Partial<StarlarkEvaluateOptions> = {}): StarlarkEvaluateOptions {
  return {
    limits,
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 30_000,
    call: async () => null,
    objectRead: async () => null,
    objectWrite: async () => null,
    ...overrides,
  };
}

function evaluate(script: string, overrides: Partial<StarlarkEvaluateOptions> = {}): Promise<StarlarkJson> {
  return starlark.evaluate(script, options(overrides));
}

/**
 * Rust oracle: `ptc_runtime.rs` (`run_ptc_script_with_limits` + `ptc_globals`).
 * The engine is the same `starlark 0.14.2` crate, so these tests cover the
 * dialect/limits and the replay bridge rather than re-implementing Starlark.
 */
describe('nativeStarlark (starlark 0.14.2 / ptc_runtime.rs)', () => {
  it('script_top_level_loop_and_dict_result: runs top-level statements with JSON and StructType globals', async () => {
    const result = await evaluate(`
s = struct(kind = "note", n = 2)
{"a": 1 + 2, "b": [x * x for x in range(3)], "s": s.kind, "n": s.n}
`);
    expect(result).toEqual({ a: 3, b: [0, 1, 4], s: 'note', n: 2 });
  });

  it('script_final_expression_is_result: a trailing assignment yields None', async () => {
    expect(await evaluate('x = 1')).toBeNull();
  });

  it('call_allowed_tool_returns_envelope: replays host calls once each and wraps outputs in the Rust envelope', async () => {
    const calls: Array<{ tool: string; args: StarlarkJson }> = [];
    const result = await evaluate(`
a = call("note_append", {"text": "one"})
b = call("builtin-note_append", '{"text": "two"}')
{"a": a, "b": b}
`, {
      call: async (tool, args) => {
        calls.push({ tool, args });
        return { done: calls.length };
      },
    });
    expect(calls).toEqual([
      { tool: 'builtin-note_append', args: { text: 'one' } },
      { tool: 'builtin-note_append', args: { text: 'two' } },
    ]);
    expect(result).toEqual({
      a: { ok: true, output: { done: 1 } },
      b: { ok: true, output: { done: 2 } },
    });
  });

  it('tool_failure_returns_error_envelope_without_aborting: StarlarkToolFailure becomes an envelope the script can inspect', async () => {
    const result = await evaluate(`
first = call("flaky", {})
second = call("flaky", {})
{"first": first, "second": second, "continued": True}
`, {
      call: async () => {
        throw new StarlarkToolFailure('tool is down');
      },
    });
    expect(result).toEqual({
      first: { ok: false, error: 'tool is down' },
      second: { ok: false, error: 'tool is down' },
      continued: true,
    });
  });

  it('call_denied_tool_is_hard_error: aborts on non-tool callback errors (policy / budget / internal failures)', async () => {
    await expect(evaluate('call("secret_tool", {})', {
      call: async () => {
        throw new Error('ptc_run: tool is not in the PTC allowlist (fail-closed)');
      },
    })).rejects.toThrow(/ptc_run: tool is not in the PTC allowlist/);
  });

  it('call_self_recursion_is_hard_error: rejects recursive ptc_run calls inside the interpreter', async () => {
    await expect(evaluate('call("ptc_run", {})')).rejects.toThrow(
      /ptc_run cannot invoke itself \(recursive call\)/,
    );
  });

  it('call_accepts_json_string_args: parses JSON strings and rejects invalid JSON with the Rust message', async () => {
    await expect(evaluate('call("x", "{not json}")')).rejects.toThrow(
      /ptc_run: call args string is not valid JSON:/,
    );
  });

  it('object_read_accepts_materialized_handle_dict_camel_case / object_write_creates_handle_and_records_read_lineage: passes defaults to the host', async () => {
    const reads: Array<{ object: StarlarkJson; options: StarlarkJson }> = [];
    const writes: Array<{ object: StarlarkJson; options: StarlarkJson }> = [];
    const result = await evaluate(`
handle = {"locator": {"root_id": "r", "relative_path": "a.txt"}, "capabilities": {"readable": True}}
page = object_read(handle)
written = object_write({"root_id": "r", "relative_path": "b.txt"}, "hello")
{"page": page, "written": written}
`, {
      objectRead: async (object, opts) => {
        reads.push({ object, options: opts });
        return { content: 'hi' };
      },
      objectWrite: async (object, opts) => {
        writes.push({ object, options: opts });
        return { written_bytes: 5 };
      },
    });
    expect(reads).toEqual([{
      object: { locator: { root_id: 'r', relative_path: 'a.txt' }, capabilities: { readable: true } },
      options: { offset: 0, limit: 8192 },
    }]);
    expect(writes).toEqual([{
      object: { root_id: 'r', relative_path: 'b.txt' },
      options: { content: 'hello', offset: null, expected_sha256: null, encoding: 'utf-8' },
    }]);
    expect(result).toEqual({ page: { content: 'hi' }, written: { written_bytes: 5 } });
  });

  it('wraps object store failures as fatal script errors', async () => {
    await expect(evaluate('object_read({"root_id": "r", "relative_path": "x"})', {
      objectRead: async () => {
        throw new Error('no such object');
      },
    })).rejects.toThrow(/ptc_run: object_read failed: no such object/);
  });

  it('load_statement_is_disabled: disables load() in the PTC dialect', async () => {
    await expect(evaluate('load("x.star", "y")')).rejects.toThrow(/ptc_run script parse error:/);
    await expect(evaluate('load("x.star", "y")')).rejects.toThrow(/`load` is not allowed/);
  });

  it('tick_limit_interrupts_infinite_loop / callstack_limit_interrupts_recursion: enforces the heap and tick limits from ptc_runtime.rs', async () => {
    await expect(evaluate(`
def f(n):
  return f(n + 1)
f(0)
`, { limits: { ...limits, max_callstack_size: 16 } })).rejects.toThrow(/call stack overflow/);
    await expect(evaluate('s = "x" * 50000000\nlen(s)', {
      limits: { ...limits, max_heap_bytes: 1024 * 1024 },
    })).rejects.toThrow(/Heap memory limit of 1048576 bytes exceeded/);
    await expect(evaluate('for i in range(100000):\n  x = i\n', {
      limits: { ...limits, max_tick_count: 1000 },
    })).rejects.toThrow(/Execution duration limit of 1000 ticks has been exceeded/);
  });

  it('cancellation_interrupts_blocked_call: reports deadline cancellation with the interpreter error text', async () => {
    await expect(evaluate('1', { deadlineMs: Date.now() - 1 })).rejects.toThrow(
      'ptc_run script error: Evaluation cancelled',
    );
  });

  it('cancellation_interrupts_blocked_call: rejects an already-aborted signal before starting the engine', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(evaluate('1', { signal: controller.signal })).rejects.toThrow(
      'ptc_run script error: Evaluation cancelled',
    );
  });

  it('rejects results that are not JSON-representable', async () => {
    await expect(evaluate('{"f": len}')).rejects.toThrow(
      /ptc_run script result is not JSON-representable:/,
    );
  });
});
