import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { starlark } from '../../../platform/native/starlark/index.ts';
import type { AgentToolCall, AgentToolResultInfo } from '../../../kernel/agent-api.ts';
import {
  DEFAULT_MAX_CALLS, DEFAULT_TIMEOUT_SECS, INLINE_RESULT_MAX_CHARS, MAX_CALLS_LIMIT,
  MAX_SCRIPT_BYTES, MAX_TIMEOUT_SECS, RESULT_PREVIEW_CHARS, type PtcTraceEntry,
} from '../src/tools/ptc-runtime.ts';
import {
  PtcExecutor, PtcSubContextTemplate, materializeResultToDir, parsePtcArgs, ptcResultHandle,
  writesSummaryOf, type PtcAdmittedDispatcher, type PtcExecutionContext, type PtcSubContext,
} from '../src/tools/ptc-executor.ts';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ptc-executor-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type StubMode = 'echo' | 'reject' | 'slow';

/** Rust tests' `StubDispatcher`: echo success / admission rejection / slow response. */
class StubDispatcher implements PtcAdmittedDispatcher {
  private readonly mode: StubMode;

  constructor(mode: StubMode) { this.mode = mode; }

  async dispatchWithAdmission(call: AgentToolCall, _ctx: PtcSubContext): Promise<AgentToolResultInfo> {
    if (this.mode === 'echo') {
      return {
        toolCallId: call.id,
        toolName: call.name,
        input: call.arguments,
        output: { echo: call.arguments },
        success: true,
        durationMs: 1,
      };
    }
    if (this.mode === 'reject') {
      throw new Error(`AUTHORITY_BLOCKED: tool '${call.name}' requires approval`);
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
    return {
      toolCallId: call.id,
      toolName: call.name,
      input: call.arguments,
      output: { late: true },
      success: true,
      durationMs: 5000,
    };
  }
}

function testContext(mode?: StubMode): PtcExecutionContext {
  return {
    sessionId: 'session',
    messageId: 'message',
    blockId: 'block',
    toolCallId: 'call',
    cancel: new AbortController().signal,
    ...(mode === undefined ? {} : { dispatcher: new StubDispatcher(mode) }),
  };
}

function ptcCall(script: string, extra: Record<string, unknown> = {}): AgentToolCall {
  return {
    id: 'ptc-1',
    name: 'builtin-ptc_run',
    arguments: { script, ...extra },
  };
}

function failureError(result: AgentToolResultInfo): string {
  expect(result.success).toBe(false);
  return result.error ?? '';
}

function traceOf(result: AgentToolResultInfo): PtcTraceEntry[] {
  const output = result.output as Record<string, unknown>;
  return output.trace as PtcTraceEntry[];
}

function numericField(result: AgentToolResultInfo, key: string): number {
  const output = result.output as Record<string, unknown>;
  return Number(output[key]);
}

describe('ptc_executor.rs', () => {
  it('parse_args_defaults_and_clamps', () => {
    const defaults = parsePtcArgs({ script: '1' });
    expect(defaults.max_calls).toBe(DEFAULT_MAX_CALLS);
    expect(defaults.timeout_secs).toBe(DEFAULT_TIMEOUT_SECS);

    const clamped = parsePtcArgs({ script: '1', max_calls: 99999, timeout_secs: 99999 });
    expect(clamped.max_calls).toBe(MAX_CALLS_LIMIT);
    expect(clamped.timeout_secs).toBe(MAX_TIMEOUT_SECS);

    const explicit = parsePtcArgs({ script: '1', max_calls: 7, timeout_secs: 5 });
    expect(explicit.max_calls).toBe(7);
    expect(explicit.timeout_secs).toBe(5);
  });

  it('writes_summary_includes_only_side_effects', () => {
    const trace: PtcTraceEntry[] = [
      {
        seq: 0,
        tool: 'builtin-rag_search',
        args_hash: 'sha256:read',
        duration_ms: 1,
        result_bytes: 10,
        ok: true,
      },
      {
        seq: 1,
        tool: 'object_write',
        args_hash: 'sha256:write',
        duration_ms: 2,
        result_bytes: 4,
        ok: true,
        side_effect: true,
        locator: { root_id: 'artifacts', relative_path: 'out.txt' },
        written_sha256: 'abc',
      },
    ];
    const summary = writesSummaryOf(trace)!;
    expect(summary).toHaveLength(1);
    expect(summary[0]!.tool).toBe('object_write');
    expect(summary[0]!.written_sha256).toBe('abc');
    expect(writesSummaryOf(trace.slice(0, 1))).toBeUndefined();
  });

  it('parse_args_rejects_missing_empty_and_oversize_script', () => {
    expect(() => parsePtcArgs({})).toThrow(/requires a 'script' string argument/);
    expect(() => parsePtcArgs({ script: '   ' })).toThrow(/must not be empty/);
    const oversized = 'x'.repeat(MAX_SCRIPT_BYTES + 1);
    expect(() => parsePtcArgs({ script: oversized })).toThrow(/script too large/);
  });

  it('materialize_result_writes_atomically_and_hashes', async () => {
    const dir = tempDir();
    const payload = `{"data": "${'x'.repeat(5000)}"}`;
    const materialized = materializeResultToDir(dir, 'call/1:weird', payload);
    expect(materialized.relative_path.startsWith('ptc/')).toBe(true);
    expect(materialized.file_name.endsWith('.json')).toBe(true);
    expect(materialized.file_name.includes('/')).toBe(false);
    expect(materialized.file_name.includes(':')).toBe(false);
    expect(readFileSync(path.join(dir, materialized.file_name), 'utf8')).toBe(payload);
    const { createHash } = await import('node:crypto');
    expect(materialized.sha256).toBe(createHash('sha256').update(payload, 'utf8').digest('hex'));
    expect(materialized.size_bytes).toBe(Buffer.byteLength(payload, 'utf8'));
    // tmp file must not linger.
    expect(readdirSync(dir)).toHaveLength(1);

    const handle = ptcResultHandle(materialized);
    expect(handle.capabilities.readable).toBe(true);
    expect(handle.capabilities.materializable).toBe(true);
    expect(handle.capabilities.writable).toBe(false);
    expect(handle.locator?.rootId).toBe('artifacts');
  });

  it('executor_metadata', () => {
    const executor = new PtcExecutor({ nativeStarlark: starlark });
    expect(executor.canHandle('builtin-ptc_run')).toBe(true);
    expect(executor.canHandle('ptc_run')).toBe(true);
    expect(executor.canHandle('builtin-tool_pack')).toBe(false);
    expect(executor.sensitivityLevel('builtin-ptc_run')).toBe('medium');
    expect(executor.name()).toBe('PtcExecutor');
    expect(executor.resultCharBudget('builtin-ptc_run')).toBeNull();
  });

  it('sub_context_inherits_session_id_for_tree_budget', () => {
    const ctx = testContext();
    const template = PtcSubContextTemplate.fromContext(ctx);
    const sub = template.build(0, new AbortController().signal);
    expect(sub.sessionId).toBe(ctx.sessionId);
    expect(sub.blockId).toBe('block-ptc-0');
    expect(sub.toolCallId).toBe(ctx.toolCallId);
  });

  it('execute_requires_central_dispatcher', async () => {
    const executor = new PtcExecutor({ nativeStarlark: starlark });
    const ctx = testContext();
    await expect(executor.execute(ptcCall('1'), ctx))
      .rejects.toThrow(/central admitted tool dispatcher/);
  });

  it('execute_script_without_calls_inline_result', async () => {
    const executor = new PtcExecutor({ nativeStarlark: starlark });
    const result = await executor.execute(ptcCall('{"answer": 42}'), testContext('echo'));
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.status).toBe('ok');
    expect(output.result).toEqual({ answer: 42 });
    expect(output.result_materialized).toBe(false);
    expect(output.calls_used).toBe(0);
    expect(output.trace).toEqual([]);
  });

  it('execute_script_with_whitelisted_call', async () => {
    const executor = new PtcExecutor({ nativeStarlark: starlark });
    const script = `
res = call("builtin-rag_search", {"query": "q"})
{"ok": res["ok"], "echoed": res["output"]["echo"]["query"]}
`;
    const result = await executor.execute(ptcCall(script), testContext('echo'));
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).result).toEqual({ ok: true, echoed: 'q' });
    expect(numericField(result, 'calls_used')).toBe(1);
    const trace = traceOf(result);
    expect(trace).toHaveLength(1);
    expect(trace[0]!.tool).toBe('builtin-rag_search');
    expect(trace[0]!.ok).toBe(true);
    expect(trace[0]!.args_hash.startsWith('sha256:')).toBe(true);
  });

  it('execute_script_whitelist_rejection_fails_with_trace', async () => {
    const executor = new PtcExecutor({ nativeStarlark: starlark });
    const result = await executor.execute(
      ptcCall('call("builtin-local_shell_execute", {"command": "ls"})'),
      testContext('echo'),
    );
    expect(failureError(result)).toContain('allowlist');
    expect((result.output as Record<string, unknown>).status).toBe('error');
    // Rejected before any request was sent: no budget consumed, no trace entry.
    expect(numericField(result, 'calls_used')).toBe(0);
    expect(traceOf(result)).toEqual([]);
  });

  it('execute_script_budget_exhaustion_fails', async () => {
    const executor = new PtcExecutor({ nativeStarlark: starlark });
    const script = `
call("builtin-rag_search", {})
call("builtin-web_search", {})
`;
    const result = await executor.execute(
      ptcCall(script, { max_calls: 1 }), testContext('echo'),
    );
    expect(failureError(result)).toContain('budget');
    expect(numericField(result, 'calls_used')).toBe(1);
    expect(traceOf(result)).toHaveLength(1);
  });

  it('execute_admission_rejection_surfaces_in_envelope_and_trace', async () => {
    const executor = new PtcExecutor({ nativeStarlark: starlark });
    const script = `
res = call("builtin-rag_search", {})
{"ok": res["ok"], "error": res["error"]}
`;
    const result = await executor.execute(ptcCall(script), testContext('reject'));
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    const value = output.result as Record<string, unknown>;
    expect(value.ok).toBe(false);
    expect(String(value.error)).toContain('AUTHORITY_BLOCKED');
    const trace = traceOf(result);
    expect(trace).toHaveLength(1);
    expect(trace[0]!.ok).toBe(false);
  });

  it('X6-LP-0027 sub-tool save failure warns through the executor logger when ctx has none', async () => {
    const warnings: string[] = [];
    const executor = new PtcExecutor({ nativeStarlark: starlark, logger: { warn: message => warnings.push(message) } });
    const ctx: PtcExecutionContext = {
      ...testContext('reject'),
      saveToolBlock: () => { throw new Error('disk full'); },
    };
    const result = await executor.execute(ptcCall('call("builtin-rag_search", {})'), ctx);
    expect(result.success).toBe(true);
    expect(warnings).toContain('[Ptc] Failed to save rejected sub-tool result: disk full');
  });

  it('execute_wall_clock_timeout_interrupts', async () => {
    const executor = new PtcExecutor({ nativeStarlark: starlark });
    const started = Date.now();
    const result = await executor.execute(
      ptcCall('call("builtin-rag_search", {})', { timeout_secs: 1 }),
      testContext('slow'),
    );
    const elapsed = Date.now() - started;
    expect(failureError(result)).toContain('timed out after 1s');
    expect((result.output as Record<string, unknown>).status).toBe('timeout');
    expect(elapsed).toBeLessThan(8000);
    // The script thread recorded the cancellation entry while polling.
    const trace = traceOf(result);
    expect(trace).toHaveLength(1);
    expect(trace[0]!.ok).toBe(false);
  }, 15_000);

  it('execute_large_result_falls_back_to_preview_when_windowless', async () => {
    const executor = new PtcExecutor({ nativeStarlark: starlark });
    const big = 'x'.repeat(INLINE_RESULT_MAX_CHARS + 100);
    const result = await executor.execute(ptcCall(`"${big}"`), testContext('echo'));
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.result_materialized).toBe(false);
    expect(output.result_truncated).toBe(true);
    expect(output.object_handle).toBeUndefined();
    expect(Array.from(String(output.preview))).toHaveLength(RESULT_PREVIEW_CHARS);
  });

  it('execute_object_read_without_window_fails_structured', async () => {
    const executor = new PtcExecutor({ nativeStarlark: starlark });
    const result = await executor.execute(
      ptcCall('object_read({"root_id": "artifacts", "relative_path": "ptc/x.json"})'),
      testContext('echo'),
    );
    expect(failureError(result)).toContain('no artifacts root');
    expect((result.output as Record<string, unknown>).status).toBe('error');
    expect(numericField(result, 'calls_used')).toBe(1);
    const trace = traceOf(result);
    expect(trace).toHaveLength(1);
    expect(trace[0]!.tool).toBe('object_read');
    expect(trace[0]!.ok).toBe(false);
  });
});
