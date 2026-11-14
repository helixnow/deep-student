/**
 * The execute skeleton every `src/chat_v2/tools/*_executor.rs` in this lane shares:
 * `emit_tool_call_start` → body → `emit_tool_call_end({result, durationMs})` or
 * `emit_tool_call_error`, then `save_tool_block` (a failed save only warns).
 * A body error is the Rust `Err(String)` and becomes a `success=false` result
 * with `output: null` (`ToolResultInfo::failure`).
 */
import type { ChatExecutionContext, ToolCall, ToolResultInfo } from '../../../chat/api.ts';
import { errorDisplay as errorText } from '../../../../platform/errors/api.ts';
import { utf8ByteLength } from '../../../../platform/util/portable.ts';

/** The part of the L04 execution context these executors read. */
export type MediaToolContext = Pick<ChatExecutionContext,
  'session_id' | 'block_id' | 'vfs_db' | 'skill_package_roots' | 'cancellation_token'
  | 'emitToolCallStart' | 'emitToolCallEnd' | 'emitToolCallError' | 'saveToolBlock'>;

export interface ToolLogger {
  warn(message: string): void;
  debug(message: string): void;
}

export { errorText };

export async function runToolCall(
  executorName: string,
  call: ToolCall,
  context: MediaToolContext,
  log: ToolLogger,
  body: () => Promise<unknown>,
): Promise<ToolResultInfo> {
  const started = performance.now();
  context.emitToolCallStart(call.name, call.arguments, call.id);
  let output: unknown;
  let error: string | undefined;
  try { output = await body(); }
  catch (cause) { error = errorText(cause); }
  const durationMs = Math.trunc(performance.now() - started);
  let result: ToolResultInfo;
  if (error === undefined) {
    context.emitToolCallEnd({ result: output, durationMs });
    result = {
      toolCallId: call.id, blockId: context.block_id, toolName: call.name,
      input: call.arguments, output, success: true, durationMs,
    };
  } else {
    context.emitToolCallError(error);
    result = {
      toolCallId: call.id, blockId: context.block_id, toolName: call.name,
      input: call.arguments, output: null, success: false, error, durationMs,
    };
  }
  try { context.saveToolBlock(result); }
  catch (cause) { log.warn(`[${executorName}] Failed to save tool block: ${errorText(cause)}`); }
  return result;
}

/** `call.arguments.get(..)` on a non-object yields `None` for every key. */
export function argumentsOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** `a.get(x).or_else(|| b.get(y))`: only an absent key falls through; `null` is a hit. */
export function firstPresent(...values: unknown[]): unknown {
  return values.find(value => value !== undefined);
}

/** `.get(key).and_then(Value::as_str)`. */
export function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

/** `.get(key).and_then(|v| v.as_str()).ok_or(message)?`. */
export function requiredStringArg(args: Record<string, unknown>, key: string, message: string): string {
  const value = stringArg(args, key);
  if (value === null) throw new Error(message);
  return value;
}

/** `{find, replace}` pairs, with the Rust per-item error texts. */
export function replacementPairs(args: Record<string, unknown>): Array<[string, string]> {
  const value = args.replacements;
  if (!Array.isArray(value)) throw new Error("Missing 'replacements' parameter (array of {find, replace})");
  return value.map(item => {
    const entry = argumentsOf(item);
    const find = stringArg(entry, 'find');
    if (find === null) throw new Error("Each replacement must have a 'find' field");
    const replace = stringArg(entry, 'replace');
    if (replace === null) throw new Error("Each replacement must have a 'replace' field");
    return [find, replace];
  });
}

/** `str.len()` for Rust strings. */
export function utf8Length(value: string): number {
  return utf8ByteLength(value);
}
