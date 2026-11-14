/**
 * The execute skeleton shared by most Rust executors: start event → operation → end/error event →
 * `ToolResultInfo::success|failure` → `save_tool_block` (a save failure is only logged).
 */
import type { ExecutionContext, ToolCall, ToolResultInfo } from '../../chat/api.ts';

const errorText = (error: unknown): string => typeof error === 'string' ? error
  : error instanceof Error ? error.message : String(error);

export async function runStandardTool(call: ToolCall, ctx: ExecutionContext, executorName: string,
  operation: () => unknown, warn: (message: string) => void): Promise<ToolResultInfo> {
  const started = performance.now();
  ctx.emitToolCallStart(call.name, call.arguments, call.id);
  let output: unknown;
  let error: string | null = null;
  try { output = await operation(); }
  catch (cause) { error = errorText(cause); }
  const durationMs = Math.trunc(performance.now() - started);
  let result: ToolResultInfo;
  if (error === null) {
    ctx.emitToolCallEnd({ result: output, durationMs });
    result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output,
      success: true, durationMs };
  } else {
    ctx.emitToolCallError(error);
    result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output: null,
      success: false, error, durationMs };
  }
  try { ctx.saveToolBlock(result); }
  catch (cause) { warn(`[${executorName}] Failed to save tool block: ${errorText(cause)}`); }
  return result;
}
