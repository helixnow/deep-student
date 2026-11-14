import { CommandError } from '../../../kernel/api.ts';
import { isAppErrorValue, type AppError } from '../../../platform/errors/api.ts';
import type { ToolCall, ToolExecutionContext, ToolResultInfo } from '../api.ts';

// dstu-core/src/tool_names.rs:26: strip only one namespace, builtin first.
export function stripToolNamespace(name: string): string {
  if (name.startsWith('builtin-')) return name.slice(8);
  if (name.startsWith('mcp_')) return name.slice(4);
  return name;
}

/**
 * L15 throws `CommandError(AppError)` (`review/src/errors.ts`). Accept the
 * published protocol without depending on its private class identity.
 */
export function publishedAppError(caught: unknown): AppError | null {
  const value = caught instanceof CommandError
    ? caught.value
    : caught !== null && typeof caught === 'object' && 'value' in caught
      ? (caught as { value: unknown }).value
      : null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.error_type !== 'string' || typeof record.message !== 'string') return null;
  return value as AppError;
}

/**
 * The Rust error's `Display`. `AppError` displays its `message` (dstu-core models.rs:1038–1041);
 * L16 throws bare AppError values and L15 `CommandError(AppError)`, whose own `message` is JSON.
 */
export function errorText(error: unknown): string {
  if (isAppErrorValue(error)) return error.message;
  const published = publishedAppError(error);
  if (published !== null) return published.message;
  return error instanceof Error ? error.message : String(error);
}

export function toolResult(
  call: ToolCall, ctx: ToolExecutionContext, durationMs: number, output: unknown, error?: string,
): ToolResultInfo {
  return {
    toolCallId: call.id, blockId: ctx.blockId, toolName: call.name, input: call.arguments,
    output: error === undefined ? output : null, success: error === undefined,
    ...(error === undefined ? {} : { error }), durationMs,
  };
}
