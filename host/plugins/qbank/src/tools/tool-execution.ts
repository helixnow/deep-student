/**
 * Shell of `QBankExecutor::execute` (qbank_executor.rs:5457-5572): emit start → dispatch →
 * emit end/error → persist the tool block. Failures become `ToolResultInfo::failure` with the
 * localized error text; they are never thrown to the registry.
 */
import type { ExecutionContext, ToolCall, ToolResultInfo } from '../../../chat/api.ts';
import { errorText } from './qbank-tool-args.ts';

export interface ToolLog {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export async function runToolWithEvents(executorName: string, toolName: string, call: ToolCall,
  ctx: ExecutionContext, log: ToolLog, run: () => Promise<unknown>,
  mapError: (error: string) => string): Promise<ToolResultInfo> {
  const started = performance.now();
  log.debug(`[${executorName}] Executing tool: ${toolName}`);
  ctx.emitToolCallStart(call.name, call.arguments, call.id);
  let output: unknown = null;
  let failure: string | null = null;
  try { output = await run(); }
  catch (error) { failure = mapError(errorText(error)); }
  const durationMs = Math.floor(performance.now() - started);
  if (failure === null) {
    log.debug(`[${executorName}] Tool ${toolName} completed in ${durationMs}ms`);
    ctx.emitToolCallEnd({ result: output, durationMs });
  } else {
    log.error(`[${executorName}] Tool ${toolName} failed: ${failure}`);
    ctx.emitToolCallError(failure);
  }
  const result: ToolResultInfo = {
    toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
    output: failure === null ? output : null, success: failure === null,
    ...(failure === null ? {} : { error: failure }), durationMs,
  };
  try { ctx.saveToolBlock(result); }
  catch (error) { log.warn(`[${executorName}] Failed to save tool block: ${errorText(error)}`); }
  return result;
}

/** `tokio::sync::Mutex<()>` (QBANK_WRITE_LOCK): FIFO serialization of write tools. */
export class WriteLock {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
