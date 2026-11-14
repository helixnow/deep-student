/**
 * Shared shell of the Rust `ToolExecutor::execute` bodies in
 * `src-tauri/src/chat_v2/tools/{review,essay_grading}_executor.rs`:
 * emit start → dispatch → emit end/error → persist the tool block → return a
 * `ToolResultInfo` (failures are results, never thrown).
 */
import type { ExecutionContext, ToolCall, ToolResultInfo } from '../../chat/api.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';
import { errorText } from './errors.ts';

export interface ToolLog {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentToolLog: ToolLog = { debug: () => undefined, warn: () => undefined, error: () => undefined };

export function toolErrorText(error: unknown): string {
  return errorText(error);
}

/** Rust `ToolResultInfo::success` / `failure` (failure output is `Value::Null`). */
export function toolResultInfo(call: ToolCall, ctx: ExecutionContext, durationMs: number,
  output: unknown, error: string | null): ToolResultInfo {
  return {
    toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
    output: error === null ? output : null, success: error === null,
    ...(error === null ? {} : { error }), durationMs,
  };
}

export async function runToolWithEvents(executorName: string, toolName: string, call: ToolCall,
  ctx: ExecutionContext, log: ToolLog, run: () => Promise<unknown>): Promise<ToolResultInfo> {
  const started = performance.now();
  log.debug(`[${executorName}] Executing tool: ${toolName}`);
  ctx.emitToolCallStart(call.name, call.arguments, call.id);
  let output: unknown = null;
  let failure: string | null = null;
  try { output = await run(); }
  catch (error) { failure = toolErrorText(error); }
  const durationMs = Math.floor(performance.now() - started);
  if (failure === null) ctx.emitToolCallEnd({ result: output, durationMs });
  else {
    log.error(`[${executorName}] Tool ${toolName} failed: ${failure}`);
    ctx.emitToolCallError(failure);
  }
  const result = toolResultInfo(call, ctx, durationMs, output, failure);
  try { ctx.saveToolBlock(result); }
  catch (error) { log.warn(`[${executorName}] Failed to save tool block: ${toolErrorText(error)}`); }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function argsObject(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {};
}

/** serde_json `Value::as_str`. */
export function asStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** serde_json `Value::as_bool`. */
export function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** serde_json `Value::as_u64` (non-negative integers only). */
export function asU64(value: unknown): number | null {
  if (typeof value === 'bigint') return value >= 0n ? Number(value) : null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** serde_json `Value::as_i64`. */
export function asI64(value: unknown): number | null {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** Rust `value as u32` on a u64 (two's-complement truncation). */
export function u64AsU32(value: number): number {
  return Number(BigInt(Math.trunc(value)) & 0xffff_ffffn);
}

/** Rust `Vec<String>::sort()` order: byte-wise UTF-8, not UTF-16 code units. */
export function compareRustStrings(left: string, right: string): number {
  return compareUtf8(left, right);
}
