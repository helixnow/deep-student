// chatanki_executor.rs:11863–12016 result helpers shared by every tool.
import type { AppError } from '../../../platform/errors/api.ts';
import type { ToolCall, ToolExecutionContext, ToolResultInfo } from '../api.ts';
import { errorText, toolResult } from './execution.ts';
import { humanizeChatAnkiError } from './executor-helpers.ts';

export { publishedAppError } from './execution.ts';

/** chatanki_executor.rs:1873–1883: log the call, then start the UI block. */
export function beginChatAnkiToolCall(call: ToolCall, ctx: ToolExecutionContext): void {
  ctx.info?.(`[ChatAnkiToolExecutor] execute: tool_name=${call.name},`
    + ` tool_call_id=${call.id}, session_id=${ctx.sessionId},`
    + ` message_id=${ctx.messageId}`);
  ctx.emitToolCallStart(call.name, call.arguments, call.id);
}

export function finishChatAnkiSuccess(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number, output: unknown,
): ToolResultInfo {
  const durationMs = Math.floor(performance.now() - startedAt);
  ctx.emitToolCallEnd({ result: output, durationMs });
  const result = toolResult(call, ctx, durationMs, output);
  try { ctx.saveToolBlock(result); }
  catch (caught) { ctx.warn(`[ChatAnkiToolExecutor] Failed to persist tool block: ${errorText(caught)}`); }
  return result;
}

export function finishChatAnkiFailure(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number, rawError: string,
): ToolResultInfo {
  const durationMs = Math.floor(performance.now() - startedAt);
  const error = humanizeChatAnkiError(rawError);
  ctx.emitToolCallError(error);
  const result = toolResult(call, ctx, durationMs, null, error);
  try { ctx.saveToolBlock(result); }
  catch (caught) { ctx.warn(`[ChatAnkiToolExecutor] Failed to persist tool block: ${errorText(caught)}`); }
  return result;
}

/**
 * Handlers that build `ToolResultInfo::failure` inline instead of calling
 * `finish_chatanki_failure`: the error text is not humanized.
 */
export function finishChatAnkiInlineFailure(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number, error: string, output: unknown = null,
): ToolResultInfo {
  const durationMs = Math.floor(performance.now() - startedAt);
  ctx.emitToolCallError(error);
  const result = toolResult(call, ctx, durationMs, null, error);
  result.output = output;
  try { ctx.saveToolBlock(result); }
  catch (caught) { ctx.warn(`[ChatAnkiToolExecutor] Failed to persist tool block: ${errorText(caught)}`); }
  return result;
}

/**
 * Rust `?` inside a handler: `execute` returns `Err(humanize_chatanki_error(e))`
 * and the tool loop reports it (no saved tool block).
 */
export function chatAnkiHandlerError(message: string): Error {
  return new Error(humanizeChatAnkiError(message));
}

function appErrorCode(details: unknown): string | null {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return null;
  const code = (details as Record<string, unknown>).errorCode;
  return typeof code === 'string' ? code : null;
}

/**
 * chatanki_executor.rs:11983–12016 `finish_chatanki_app_failure`: keep the full
 * structured AppError in `output.error` and prefix the emitted text with the
 * details `errorCode` when present.
 */
export function finishChatAnkiAppFailure(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number, error: AppError,
): ToolResultInfo {
  const durationMs = Math.floor(performance.now() - startedAt);
  const code = appErrorCode(error.details);
  const errorTextValue = code === null ? error.message : `[${code}] ${error.message}`;
  ctx.emitToolCallError(errorTextValue);
  const result = toolResult(call, ctx, durationMs, null, errorTextValue);
  result.output = { error };
  try { ctx.saveToolBlock(result); }
  catch (caught) { ctx.warn(`[ChatAnkiToolExecutor] Failed to persist tool block: ${errorText(caught)}`); }
  return result;
}
