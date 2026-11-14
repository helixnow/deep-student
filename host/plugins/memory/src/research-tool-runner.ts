/**
 * Shared `execute` envelope of the Rust research executors
 * (knowledge / learning_overview / academic_search / paper_save): emit the
 * generic `tool_call` start, run the body, emit end `{result, durationMs}` or
 * the error, and optionally persist the tool block (`save_tool_block` failures
 * only warn). Body errors become `ToolResultInfo::failure`; `Ok` payloads are
 * successes regardless of their own `success` field.
 */
import type { ExecutionContext, ToolCall, ToolResultInfo } from '../../chat/api.ts';

export interface ResearchToolLog {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export function toolErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function argsObject(call: ToolCall): Record<string, unknown> {
  return call.arguments !== null && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
    ? call.arguments as Record<string, unknown> : {};
}

export interface RunToolOptions {
  readonly log: ResearchToolLog;
  readonly executorName: string;
  readonly saveBlock: boolean;
  /** Maps the body error before it reaches the emitter and the result (e.g. localisation). */
  readonly mapError?: (error: string) => string;
}

export async function runResearchTool(call: ToolCall, ctx: ExecutionContext,
  body: () => Promise<unknown>, options: RunToolOptions): Promise<ToolResultInfo> {
  const started = performance.now();
  ctx.emitToolCallStart(call.name, call.arguments, call.id);
  let output: unknown;
  let failure: string | null = null;
  try { output = await body(); }
  catch (error) { failure = toolErrorText(error); }
  const durationMs = Math.floor(performance.now() - started);
  const base = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, durationMs };
  let result: ToolResultInfo;
  if (failure !== null) {
    const error = options.mapError === undefined ? failure : options.mapError(failure);
    ctx.emitToolCallError(error);
    result = { ...base, output: null, success: false, error };
  } else {
    ctx.emitToolCallEnd({ result: output, durationMs });
    result = { ...base, output, success: true };
  }
  if (options.saveBlock) {
    try { ctx.saveToolBlock(result); }
    catch (error) { options.log.warn(`[${options.executorName}] Failed to persist tool block: ${toolErrorText(error)}`); }
  }
  return result;
}
