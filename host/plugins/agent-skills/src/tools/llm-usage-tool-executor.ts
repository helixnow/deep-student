/** llm_usage_executor.rs:699–764 `LlmUsageToolExecutor::execute` over the F3 `llm_usage` database. */
import type { ExecutionContext, ToolCall, ToolResultInfo } from '../../../chat/api.ts';
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import { LlmUsageToolExecutor } from './llm-usage-executor.ts';

const errorText = (error: unknown): string => typeof error === 'string' ? error
  : error instanceof Error ? error.message : String(error);
const unavailable = (message: string) => JSON.stringify({ code: 'USAGE_DATABASE_UNAVAILABLE', message,
  hint: 'Retry after application data initialization completes.', retryable: true });

export class LlmUsageToolRuntimeExecutor extends LlmUsageToolExecutor {
  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    const log = ctx.services.logger;
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let output: Record<string, unknown> | undefined;
    let error: string | undefined;
    const storage = ctx.services.get('storage');
    if (storage === undefined) error = unavailable('The LLM usage database is not initialized.');
    else {
      let conn: SqlExecutor | undefined;
      try { conn = storage.database('llm_usage'); }
      catch (cause) {
        log.error(`[LlmUsageToolExecutor] Connection failed: ${errorText(cause)}`);
        error = unavailable('The LLM usage database is unavailable.');
      }
      if (conn !== undefined) {
        try { output = this.executeQuery(conn, call.arguments, { error: message => log.error(message) }); }
        catch (cause) { error = errorText(cause); }
      }
    }
    const durationMs = Math.trunc(performance.now() - started);
    let result: ToolResultInfo;
    if (output !== undefined) {
      ctx.emitToolCallEnd({ result: output, durationMs });
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output,
        success: true, durationMs };
    } else {
      ctx.emitToolCallError(error!);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output: null,
        success: false, error: error!, durationMs };
    }
    try { ctx.saveToolBlock(result); }
    catch (cause) { log.warn(`[LlmUsageToolExecutor] Failed to persist tool block: ${errorText(cause)}`); }
    return result;
  }
}
