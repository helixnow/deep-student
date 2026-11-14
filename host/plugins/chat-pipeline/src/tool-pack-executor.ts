/**
 * tool_pack_executor.rs: `builtin-tool_pack` runs up to 20 built-in sub-tools (10 at a time)
 * through the central admitted dispatcher and aggregates them into one pack result.
 * Every child re-enters admission with a fresh context (parent session_id kept for the
 * G08 tree budget; shell approval never inherited), so this executor adds no second
 * budget or approval check.
 */
import type { ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../chat/api.ts';
import {
  DEFAULT_PACK_TIMEOUT_SECS, MAX_CONCURRENCY, MAX_SUB_TOOLS, TOOL_PACK_EXECUTOR_NAME, canHandleToolPack,
} from '../../agent-orchestration/portable.ts';

const CANCEL_GRACE_PERIOD_MS = 3_000;
const MAX_FAILURE_SAMPLE_CHARS = 300;
const CANCELLED_ERROR = 'Tool execution was cancelled';

/** The two `ToolExecutorRegistry` reads tool_pack needs (Rust holds a `Weak` to it). */
export interface ToolPackRegistry {
  hasSpecificExecutor(toolName: string): boolean;
  isNoTimeoutTool(toolName: string): boolean;
}

export interface ToolPackLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ToolPackExecutorOptions {
  registry: () => ToolPackRegistry | null;
  log: ToolPackLogger;
  cancelGraceMs?: number;
}

interface SubTool { name: string; args: unknown; index: number }

type ScopedContext = ExecutionContext & { scopedWithCancellationToken?(token: AbortSignal): ExecutionContext };

/** tool_pack_executor.rs:66 `create_sub_context`. */
export function createToolPackSubContext(parent: ExecutionContext, blockId: string, token: AbortSignal): ExecutionContext {
  const scoped = parent as ScopedContext;
  let child: ExecutionContext;
  if (typeof scoped.scopedWithCancellationToken === 'function') {
    child = scoped.scopedWithCancellationToken(token);
  } else {
    child = Object.create(Object.getPrototypeOf(parent)) as ExecutionContext;
    Object.assign(child, parent);
  }
  Object.assign(child, {
    block_id: blockId,
    cancellation_token: token,
    shell_guard_approved: false,
    shell_authority_admission: null,
    admitted_tool_dispatcher: parent.admitted_tool_dispatcher,
  });
  return child;
}

function failure(callId: string, blockId: string, toolName: string, input: unknown, error: string, durationMs: number): ToolResultInfo {
  return { toolCallId: callId, blockId, toolName, input, output: null, success: false, error, durationMs };
}

function cancelled(callId: string, blockId: string, toolName: string, input: unknown, durationMs: number): ToolResultInfo {
  return failure(callId, blockId, toolName, input, CANCELLED_ERROR, durationMs);
}

/** tool_pack_executor.rs:112 `finalize_synthetic_sub_result`. */
function finalizeSynthetic(ctx: ExecutionContext, result: ToolResultInfo, emitStart: boolean, log: ToolPackLogger): void {
  if (emitStart) ctx.emitToolCallStart(result.toolName, result.input, result.toolCallId ?? null);
  if (result.error != null) ctx.emitToolCallError(result.error);
  else ctx.emitToolCallEnd({ result: result.output, durationMs: result.durationMs ?? 0 });
  try { ctx.saveToolBlock(result); }
  catch (error) { log.warn(`[ToolPack] Failed to save synthetic sub-tool result: ${errorText(error)}`); }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** serde_json `Value::as_u64`. */
function asU64(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Semaphore {
  private permits: number;
  private readonly waiters: (() => void)[] = [];
  constructor(permits: number) { this.permits = permits; }
  /** Resolves true with a permit, or false if `signal` aborts first. */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.permits > 0) { this.permits -= 1; return Promise.resolve(true); }
    return new Promise(resolve => {
      const grant = () => { signal.removeEventListener('abort', onAbort); resolve(true); };
      const onAbort = () => {
        const at = this.waiters.indexOf(grant);
        if (at >= 0) this.waiters.splice(at, 1);
        resolve(false);
      };
      this.waiters.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  release(): void {
    const next = this.waiters.shift();
    if (next === undefined) this.permits += 1;
    else next();
  }
}

export class ToolPackExecutor implements ToolExecutor {
  private readonly registry: () => ToolPackRegistry | null;
  private readonly log: ToolPackLogger;
  private readonly graceMs: number;

  constructor(options: ToolPackExecutorOptions) {
    this.registry = options.registry;
    this.log = options.log;
    this.graceMs = options.cancelGraceMs ?? CANCEL_GRACE_PERIOD_MS;
  }

  name(): string { return TOOL_PACK_EXECUTOR_NAME; }
  canHandle(toolName: string): boolean { return canHandleToolPack(toolName); }
  sensitivityLevel(): 'low' { return 'low'; }
  managesCancellation(): boolean { return true; }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const start = Date.now();
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    const fail = (message: string): never => {
      ctx.emitToolCallError(message);
      throw new Error(message);
    };

    const registry = this.registry();
    if (registry === null) fail('ToolExecutorRegistry has been dropped');
    const dispatcher = ctx.admitted_tool_dispatcher;
    if (dispatcher === null) fail('tool_pack requires the central admitted tool dispatcher');
    const args = isObject(call.arguments) ? call.arguments : {};
    const tools = Array.isArray(args.tools) ? args.tools as unknown[] : fail("tool_pack requires a 'tools' array in arguments");

    const requestedTimeout = asU64(args.timeout);
    let packTimeoutSecs = DEFAULT_PACK_TIMEOUT_SECS;
    if (requestedTimeout !== null) {
      if (requestedTimeout >= 1 && requestedTimeout <= 600) packTimeoutSecs = requestedTimeout;
      else this.log.warn(`[ToolPack] timeout value ${requestedTimeout} out of range, using default ${DEFAULT_PACK_TIMEOUT_SECS}s`);
    }

    if (tools.length === 0) fail('tool_pack requires at least 1 sub-tool');
    if (tools.length > MAX_SUB_TOOLS) fail(`tool_pack supports at most ${MAX_SUB_TOOLS} sub-tools, got ${tools.length}`);

    const subTools: SubTool[] = [];
    tools.forEach((tool, index) => {
      const name = isObject(tool) && typeof tool.name === 'string' ? tool.name : fail(`sub-tool ${index} missing 'name' field`);
      const subArgs = isObject(tool) && Object.hasOwn(tool, 'args') ? tool.args : {};
      if (canHandleToolPack(name)) fail('tool_pack cannot invoke itself (recursive call)');
      let effective: string;
      if (registry!.hasSpecificExecutor(name)) effective = name;
      else if (name.startsWith('builtin-')) effective = fail(`tool '${name}' not found in tool registry`);
      else {
        const prefixed = `builtin-${name}`;
        effective = registry!.hasSpecificExecutor(prefixed) ? prefixed : fail(`tool '${name}' not found in tool registry`);
      }
      if (registry!.isNoTimeoutTool(effective)) fail(`tool_pack cannot execute blocking/no-timeout tool '${effective}'`);
      subTools.push({ name: effective, args: subArgs, index });
    });

    const child = new AbortController();
    const parentToken = ctx.cancellation_token;
    const linkParent = () => child.abort();
    if (parentToken !== null) {
      if (parentToken.aborted) child.abort();
      else parentToken.addEventListener('abort', linkParent, { once: true });
    }
    const token = child.signal;
    const total = subTools.length;
    const semaphore = new Semaphore(MAX_CONCURRENCY);
    const blockIdFor = (index: number) => `${ctx.block_id}-tool_pack-${index}`;
    const callIdFor = (index: number) => `${ctx.block_id}-tp-${index}`;
    const completed = new Map<number, ToolResultInfo>();
    let notify: () => void = () => {};
    const progress = () => new Promise<void>(resolve => { notify = resolve; });
    let next = progress();

    const runSub = async (sub: SubTool): Promise<ToolResultInfo> => {
      const subStart = Date.now();
      const callId = callIdFor(sub.index), blockId = blockIdFor(sub.index);
      const subCtx = createToolPackSubContext(ctx, blockId, token);
      if (token.aborted) {
        const result = cancelled(callId, blockId, sub.name, sub.args, 0);
        finalizeSynthetic(subCtx, result, true, this.log);
        return result;
      }
      if (!await semaphore.acquire(token)) {
        const result = cancelled(callId, blockId, sub.name, sub.args, 0);
        finalizeSynthetic(subCtx, result, true, this.log);
        return result;
      }
      try {
        const result = await dispatcher!.dispatchWithAdmission({ id: callId, name: sub.name, arguments: sub.args }, subCtx);
        if (!result.success) {
          try { subCtx.saveToolBlock(result); }
          catch (error) { this.log.warn(`[ToolPack] Failed to save admitted sub-tool result: ${errorText(error)}`); }
        }
        return result;
      } catch (error) {
        const result = failure(callId, blockId, sub.name, sub.args, errorText(error), Date.now() - subStart);
        finalizeSynthetic(subCtx, result, false, this.log);
        return result;
      } finally {
        semaphore.release();
      }
    };

    for (const sub of subTools) {
      void runSub(sub).then(result => {
        completed.set(sub.index, result);
        const wake = notify;
        next = progress();
        wake();
      });
    }

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>(resolve => { deadlineTimer = setTimeout(() => resolve('timeout'), packTimeoutSecs * 1000); });
    const cancelledSignal = new Promise<'cancelled'>(resolve => {
      if (token.aborted) resolve('cancelled');
      else token.addEventListener('abort', () => resolve('cancelled'), { once: true });
    });
    const allDone = async (): Promise<'done'> => {
      while (completed.size < total) await next;
      return 'done';
    };
    const drain = async () => {
      while (completed.size < total) {
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([next.then(() => 'progress' as const),
          new Promise<'grace'>(resolve => { graceTimer = setTimeout(() => resolve('grace'), this.graceMs); })]);
        clearTimeout(graceTimer);
        if (outcome === 'grace') break;
      }
    };

    const outcome = await Promise.race([allDone(), deadline, cancelledSignal]);
    clearTimeout(deadlineTimer);
    parentToken?.removeEventListener('abort', linkParent);
    const results = new Map(completed);
    if (outcome === 'timeout') {
      this.log.warn(`[ToolPack] Pack timeout after ${packTimeoutSecs}s, cancelling ${total - completed.size} remaining sub-tools`);
      child.abort();
      await drain();
      for (const [index, result] of completed) results.set(index, result);
      for (const sub of subTools) {
        if (results.has(sub.index)) continue;
        const result = failure(callIdFor(sub.index), blockIdFor(sub.index), sub.name, sub.args,
          'tool_pack timeout: sub-tool did not complete within grace period', packTimeoutSecs * 1000);
        finalizeSynthetic(createToolPackSubContext(ctx, blockIdFor(sub.index), token), result, true, this.log);
        results.set(sub.index, result);
      }
    } else if (outcome === 'cancelled') {
      this.log.info('[ToolPack] Pack cancelled, draining completed sub-tools');
      await drain();
      for (const [index, result] of completed) results.set(index, result);
      for (const sub of subTools) {
        if (results.has(sub.index)) continue;
        const result = cancelled(callIdFor(sub.index), blockIdFor(sub.index), sub.name, sub.args, Date.now() - start);
        finalizeSynthetic(createToolPackSubContext(ctx, blockIdFor(sub.index), token), result, true, this.log);
        results.set(sub.index, result);
      }
    }

    const ordered = [...results.entries()].sort(([a], [b]) => a - b);
    const totalMs = Date.now() - start;
    const succeeded = ordered.filter(([, result]) => result.success).length;
    const failed = ordered.length - succeeded;
    const status = succeeded === 0 ? 'all_failed' : failed > 0 ? 'partial' : 'ok';
    const output = {
      total_ms: totalMs,
      succeeded,
      failed,
      status,
      results: ordered.map(([index, result]) => ({
        index,
        tool_call_id: result.toolCallId ?? null,
        tool_name: result.toolName,
        success: result.success,
        output: result.output ?? null,
        error: result.error ?? null,
        duration_ms: result.durationMs ?? null,
        block_id: result.blockId ?? null,
      })),
    };

    if (succeeded === 0) {
      const samples = ordered
        .filter(([, result]) => result.error != null)
        .slice(0, 3)
        .map(([, result]) => `${result.toolName}: ${Array.from(result.error!).slice(0, MAX_FAILURE_SAMPLE_CHARS).join('')}`);
      const summary = `tool_pack 全部 ${total} 个子工具执行失败 / all ${total} sub-tool(s) failed. Sample failures: ${samples.join(' | ')}`;
      ctx.emitToolCallError(summary);
      this.log.warn(`[ToolPack] All ${total} sub-tools failed, ${totalMs}ms total`);
      return { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output, success: false, error: summary, durationMs: totalMs };
    }

    ctx.emitToolCallEnd({ result: output, durationMs: totalMs });
    this.log.info(`[ToolPack] Completed: ${succeeded}/${total} succeeded (${status}), ${totalMs}ms total`);
    return { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
      output, success: true, durationMs: totalMs };
  }
}
