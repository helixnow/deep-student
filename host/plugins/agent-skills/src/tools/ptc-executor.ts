/**
 * `PtcExecutor` — `builtin-ptc_run` programmatic tool composition, ported from
 * `chat_v2/tools/ptc_executor.rs`.
 *
 * A model-supplied Starlark script calls `call(tool, args)`; every call goes
 * back through the central admitted dispatcher with a child context that keeps
 * the parent session (so tree budgets still see it) but never inherits shell
 * approval. Budgets, trace, object materialization and the result envelope are
 * owned here; the interpreter/policy live in `ptc-runtime.ts`.
 */
import type { AgentToolCall, AgentToolResultInfo } from '../../../../kernel/agent-api.ts';
import type { NativeStarlark } from '../../../../platform/native/starlark/api.ts';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MAX_CALLS, DEFAULT_TIMEOUT_SECS, INLINE_RESULT_MAX_CHARS, MAX_CALLS_LIMIT,
  MAX_SCRIPT_BYTES, MAX_TIMEOUT_SECS, RESULT_PREVIEW_CHARS, PtcBrokerState,
  runPtcScript, type PtcLogger, type PtcScriptOutcome, type PtcTraceEntry,
  type PtcDescriptorPolicy,
} from './ptc-runtime.ts';
import { derivedEdge, managedLocator, TaskObjectHandleBuilder } from './task-objects.ts';

export interface PtcArgs {
  script: string;
  max_calls: number;
  timeout_secs: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `parse_ptc_args`: u64 semantics, clamp/warn out-of-range budgets. */
export function parsePtcArgs(argumentsValue: unknown, logger: PtcLogger = {}): PtcArgs {
  const args = typeof argumentsValue === 'object' && argumentsValue !== null
    ? argumentsValue as Record<string, unknown> : {};
  const rawScript = args.script;
  if (typeof rawScript !== 'string') {
    throw new Error("ptc_run requires a 'script' string argument");
  }
  if (rawScript.trim() === '') throw new Error("ptc_run 'script' must not be empty");
  const scriptBytes = Buffer.byteLength(rawScript, 'utf8');
  if (scriptBytes > MAX_SCRIPT_BYTES) {
    throw new Error(
      `ptc_run script too large: ${scriptBytes} bytes (max ${MAX_SCRIPT_BYTES} bytes)`,
    );
  }

  const rawCalls = args.max_calls;
  let maxCalls = DEFAULT_MAX_CALLS;
  if (typeof rawCalls === 'number' && Number.isInteger(rawCalls) && rawCalls >= 0) {
    if (rawCalls === 0) {
      logger.warn?.(`[Ptc] max_calls=0 out of range, using default ${DEFAULT_MAX_CALLS}`);
    } else if (rawCalls > MAX_CALLS_LIMIT) {
      logger.warn?.(`[Ptc] max_calls=${rawCalls} exceeds limit, clamped to ${MAX_CALLS_LIMIT}`);
      maxCalls = MAX_CALLS_LIMIT;
    } else {
      maxCalls = rawCalls;
    }
  }

  const rawTimeout = args.timeout_secs;
  let timeoutSecs = DEFAULT_TIMEOUT_SECS;
  if (typeof rawTimeout === 'number' && Number.isInteger(rawTimeout) && rawTimeout > 0) {
    if (rawTimeout > MAX_TIMEOUT_SECS) {
      logger.warn?.(`[Ptc] timeout_secs=${rawTimeout} exceeds limit, clamped to ${MAX_TIMEOUT_SECS}`);
      timeoutSecs = MAX_TIMEOUT_SECS;
    } else {
      timeoutSecs = rawTimeout;
    }
  }
  return { script: rawScript, max_calls: maxCalls, timeout_secs: timeoutSecs };
}

export interface PtcSubContext {
  sessionId: string;
  messageId: string;
  blockId: string;
  toolCallId: string;
  variantId?: string | null;
  roundId?: string | null;
  skillStateVersion?: number | null;
  artifactRoot?: string | null;
  cancel: AbortSignal;
  emitToolCallStart?: (name: string, args: unknown, callId: string | null) => void;
  emitToolCallEnd?: (payload: unknown) => void;
  emitToolCallError?: (error: string) => void;
  saveToolBlock?: (result: AgentToolResultInfo) => void;
  logger?: PtcLogger;
}

export interface PtcAdmittedDispatcher {
  dispatchWithAdmission(
    call: AgentToolCall,
    ctx: PtcSubContext,
  ): Promise<AgentToolResultInfo>;
}

export interface PtcExecutionContext extends PtcSubContext {
  /** `ExecutionContext::admitted_tool_dispatcher()`; optional to model the `None` branch. */
  dispatcher?: PtcAdmittedDispatcher;
}

export class PtcSubContextTemplate {
  private readonly parent: PtcExecutionContext;

  private constructor(parent: PtcExecutionContext) {
    this.parent = parent;
  }

  static fromContext(ctx: PtcExecutionContext): PtcSubContextTemplate {
    return new PtcSubContextTemplate(ctx);
  }

  build(seq: number, cancel: AbortSignal): PtcSubContext {
    return {
      sessionId: this.parent.sessionId,
      messageId: this.parent.messageId,
      blockId: `${this.parent.blockId}-ptc-${seq}`,
      toolCallId: this.parent.toolCallId,
      variantId: this.parent.variantId,
      roundId: this.parent.roundId,
      skillStateVersion: this.parent.skillStateVersion,
      artifactRoot: this.parent.artifactRoot,
      cancel,
      emitToolCallStart: this.parent.emitToolCallStart,
      emitToolCallEnd: this.parent.emitToolCallEnd,
      emitToolCallError: this.parent.emitToolCallError,
      saveToolBlock: this.parent.saveToolBlock,
      logger: this.parent.logger,
    };
  }
}

export interface MaterializedResult {
  file_name: string;
  relative_path: string;
  sha256: string;
  size_bytes: number;
}

/** Atomic materialization of a large return value under `<root>/ptc`. */
export function materializeResultToDir(
  ptcDir: string,
  callId: string,
  payload: string,
): MaterializedResult {
  try { mkdirSync(ptcDir, { recursive: true }); }
  catch (error) { throw new Error(`failed to create ptc artifact directory: ${errorText(error)}`); }
  const safeId = Array.from(callId)
    .map(ch => (/^[A-Za-z0-9_-]$/.test(ch) ? ch : '_'))
    .slice(0, 64)
    .join('');
  const fileName = `ptc-${safeId === '' ? 'run' : safeId}-${Date.now()}.json`;
  const finalPath = path.join(ptcDir, fileName);
  const tmpPath = path.join(ptcDir, `${fileName}.tmp`);
  const bytes = Buffer.from(payload, 'utf8');
  try {
    const fd = openSync(tmpPath, 'w');
    try { writeSync(fd, bytes); fsyncSync(fd); }
    finally { closeSync(fd); }
  } catch (error) {
    throw new Error(`failed to write ptc result artifact: ${errorText(error)}`);
  }
  try { renameSync(tmpPath, finalPath); }
  catch (error) {
    removeQuietly(tmpPath);
    throw new Error(`failed to finalize ptc result artifact: ${errorText(error)}`);
  }
  return {
    relative_path: `ptc/${fileName}`,
    file_name: fileName,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.length,
  };
}

function removeQuietly(target: string): void {
  try { rmSync(target, { force: true }); }
  catch (error) { if (!(error instanceof Error)) throw error; }
}

export function ptcResultHandle(materialized: MaterializedResult) {
  return new TaskObjectHandleBuilder(
    `ptc-result:${materialized.sha256}`,
    'artifact',
    materialized.file_name,
    'deep-student-ptc',
  )
    .tool('builtin-ptc_run')
    .mediaType('application/json')
    .sizeBytes(materialized.size_bytes)
    .sha256(materialized.sha256)
    .locator(managedLocator('artifacts', materialized.relative_path))
    .capabilities({
      readable: true,
      materializable: true,
      writable: false,
      shareable: false,
      sendable: false,
      deletable: true,
    })
    .derivedEdges([])
    .build();
}

export function writesSummaryOf(trace: readonly PtcTraceEntry[]): Record<string, unknown>[] | undefined {
  const writes = trace.filter(entry => entry.side_effect).map(entry => ({
    seq: entry.seq,
    tool: entry.tool,
    ok: entry.ok,
    args_hash: entry.args_hash,
    ...(entry.locator === undefined ? {} : { locator: entry.locator }),
    ...(entry.written_sha256 === undefined ? {} : { written_sha256: entry.written_sha256 }),
  }));
  return writes.length === 0 ? undefined : writes;
}

export interface PtcBuildContext {
  artifactRoot?: string | null;
  logger?: PtcLogger;
}

function previewOf(serialized: string): string {
  return Array.from(serialized).slice(0, RESULT_PREVIEW_CHARS).join('');
}

/** Success envelope: inline ≤4KB, otherwise materialize with a 2KB preview. */
export function buildSuccessOutput(
  ctx: PtcBuildContext,
  callId: string,
  value: unknown,
  trace: readonly PtcTraceEntry[],
  callsUsed: number,
  durationMs: number,
): Record<string, unknown> {
  const serialized = JSON.stringify(value, null, 2);
  const resultChars = Array.from(serialized).length;
  const output: Record<string, unknown> = {
    status: 'ok',
    calls_used: callsUsed,
    duration_ms: durationMs,
    trace,
  };
  const writes = writesSummaryOf(trace);
  if (writes !== undefined) output.writes_summary = writes;
  if (resultChars <= INLINE_RESULT_MAX_CHARS) {
    output.result = value;
    output.result_materialized = false;
    return output;
  }
  try {
    if (ctx.artifactRoot === undefined || ctx.artifactRoot === null || ctx.artifactRoot === '') {
      throw new Error('no artifacts root (windowless context)');
    }
    const materialized = materializeResultToDir(path.join(ctx.artifactRoot, 'ptc'), callId, serialized);
    const handle = ptcResultHandle(materialized);
    output.result_materialized = true;
    output.object_handle = handle;
    output.result_bytes = materialized.size_bytes;
    output.result_chars = resultChars;
    output.preview = previewOf(serialized);
    output.materialized_note = 'Full result materialized to the session artifacts root; '
      + 'page it back with object_read(object_handle or '
      + '{root_id, relative_path}, offset=..., limit=...) inside a '
      + 'follow-up ptc_run script.';
  } catch (error) {
    const message = errorText(error);
    ctx.logger?.warn?.(`[Ptc] materialization failed (${message}); falling back to truncated preview`);
    output.result_materialized = false;
    output.result_truncated = true;
    output.result_chars = resultChars;
    output.preview = previewOf(serialized);
    output.materialize_error = message;
  }
  return output;
}

export function buildFailureOutput(
  status: string,
  error: string,
  trace: readonly PtcTraceEntry[],
  callsUsed: number,
  durationMs: number,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    status,
    error,
    calls_used: callsUsed,
    duration_ms: durationMs,
    trace,
  };
  const writes = writesSummaryOf(trace);
  if (writes !== undefined) output.writes_summary = writes;
  return output;
}

export interface PtcExecutorOptions {
  logger?: PtcLogger;
  descriptors?: PtcDescriptorPolicy;
  /**
   * `nativeStarlark` service resolved from the Host Context. A getter keeps
   * profile replacement observable per execution instead of freezing the
   * implementation at plugin apply time.
   */
  nativeStarlark: NativeStarlark | (() => NativeStarlark);
}

/** `PtcExecutor` — thin async shell around `PtcBrokerState` + F7 starlark. */
export class PtcExecutor {
  private readonly logger: PtcLogger;
  private readonly descriptors: PtcDescriptorPolicy | undefined;
  private readonly nativeStarlark: NativeStarlark | (() => NativeStarlark);

  constructor(options: PtcExecutorOptions) {
    this.logger = options.logger ?? {};
    this.descriptors = options.descriptors;
    this.nativeStarlark = options.nativeStarlark;
  }

  private resolveNativeStarlark(): NativeStarlark {
    const service = typeof this.nativeStarlark === 'function'
      ? this.nativeStarlark() : this.nativeStarlark;
    if (service === undefined || service === null) {
      throw new Error('ptc_run requires the nativeStarlark service');
    }
    return service;
  }

  canHandle(toolName: string): boolean {
    return toolName === 'builtin-ptc_run' || toolName === 'ptc_run';
  }

  sensitivityLevel(_toolName: string): 'medium' { return 'medium'; }
  name(): string { return 'PtcExecutor'; }
  resultCharBudget(_toolName: string): null { return null; }
  concurrencyClass(_toolName: string): 'serial' { return 'serial'; }

  /** `ToolExecutor::execute` (the lane's PTC-specific context shape). */
  async execute(call: AgentToolCall, ctx: PtcExecutionContext): Promise<AgentToolResultInfo> {
    const startedAt = Date.now();
    ctx.emitToolCallStart?.(call.name, call.arguments, call.id);
    let args: PtcArgs;
    try {
      args = parsePtcArgs(call.arguments, ctx.logger ?? this.logger);
    } catch (error) {
      const message = errorText(error);
      ctx.emitToolCallError?.(message);
      throw error;
    }
    const dispatcher = ctx.dispatcher;
    if (dispatcher === undefined) {
      const message = 'ptc_run requires the central admitted tool dispatcher';
      ctx.emitToolCallError?.(message);
      throw new Error(message);
    }

    const nativeStarlark = this.resolveNativeStarlark();
    const scriptController = new AbortController();
    const abortScript = () => scriptController.abort();
    if (ctx.cancel.aborted) scriptController.abort();
    else ctx.cancel.addEventListener('abort', abortScript, { once: true });
    const deadlineMs = startedAt + args.timeout_secs * 1000;

    const template = PtcSubContextTemplate.fromContext(ctx);
    const dispatch = async (seq: number, tool: string, argsValue: unknown) => {
      // Sub-calls have no independent cancellation source; share the script
      // signal instead of retaining one abort listener per completed call.
      const subCtx = template.build(seq, scriptController.signal);
      const subCall: AgentToolCall = {
        id: `${ctx.blockId}-ptc-call-${seq}`,
        name: tool,
        arguments: argsValue,
      };
      try {
        const result = await dispatcher.dispatchWithAdmission(subCall, subCtx);
        if (!result.success) {
          try { subCtx.saveToolBlock?.(result); }
          catch (saveError) {
            (ctx.logger ?? this.logger).warn?.(`[Ptc] Failed to save admitted sub-tool result: ${errorText(saveError)}`);
          }
        }
        if (result.success) return { ok: true, output: result.output };
        return { ok: false, error: result.error ?? 'sub-tool returned failure' };
      } catch (error) {
        const message = errorText(error);
        const failure: AgentToolResultInfo = {
          toolCallId: subCall.id,
          blockId: subCtx.blockId,
          toolName: tool,
          input: argsValue,
          output: null,
          success: false,
          error: message,
          durationMs: 0,
        };
        subCtx.emitToolCallError?.(message);
        try { subCtx.saveToolBlock?.(failure); }
        catch (saveError) {
          (ctx.logger ?? this.logger).warn?.(`[Ptc] Failed to save rejected sub-tool result: ${errorText(saveError)}`);
        }
        return { ok: false, error: message };
      }
    };

    const broker = new PtcBrokerState({
      maxCalls: args.max_calls,
      signal: scriptController.signal,
      deadlineMs,
      artifactRoot: ctx.artifactRoot ?? null,
      dispatch,
      logger: ctx.logger ?? this.logger,
      descriptors: this.descriptors,
      nativeStarlark,
    });
    let outcome: PtcScriptOutcome;
    try {
      outcome = await runPtcScript(args.script, broker);
    } catch (error) {
      outcome = { ok: false, error: errorText(error) };
    } finally {
      ctx.cancel.removeEventListener('abort', abortScript);
    }
    // F7 observes the same absolute deadline; normalise the wall-clock status here.
    let timedOut = false;
    if (!outcome.ok && Date.now() >= deadlineMs) {
      timedOut = true;
      outcome = {
        ok: false,
        error: `ptc_run timed out after ${args.timeout_secs}s (wall-clock)`,
      };
    }
    if (!outcome.ok && (timedOut || ctx.cancel.aborted || scriptController.signal.aborted)) {
      // Rust cancels the script token after a timeout/cancel so in-flight
      // sub-dispatches observe the child cancellation too.
      scriptController.abort();
    }
    const durationMs = Date.now() - startedAt;
    const trace = [...broker.trace];
    const callsUsed = broker.callsUsed;

    if (outcome.ok === true) {
      const output = buildSuccessOutput(
        { artifactRoot: ctx.artifactRoot, logger: ctx.logger ?? this.logger },
        call.id,
        outcome.value,
        trace,
        callsUsed,
        durationMs,
      );
      ctx.emitToolCallEnd?.({ result: output, durationMs });
      this.logger.info?.(`[Ptc] Script completed: ${callsUsed} call(s), ${durationMs}ms`);
      return {
        toolCallId: call.id,
        blockId: ctx.blockId,
        toolName: call.name,
        input: call.arguments,
        output,
        success: true,
        durationMs,
      };
    }

    const status = timedOut ? 'timeout' : 'error';
    const output = buildFailureOutput(status, outcome.error, trace, callsUsed, durationMs);
    ctx.emitToolCallError?.(outcome.error);
    this.logger.warn?.(
      `[Ptc] Script ${status}: ${outcome.error} (${callsUsed} call(s), ${durationMs}ms)`,
    );
    return {
      toolCallId: call.id,
      blockId: ctx.blockId,
      toolName: call.name,
      input: call.arguments,
      output,
      success: false,
      error: outcome.error,
      durationMs,
    };
  }
}

// Keep the lineage helper referenced so the PTC write path and result handles
// share the same observable edge shape.
export { derivedEdge };
