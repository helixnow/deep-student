/** attempt_completion.rs:196–329 `AttemptCompletionExecutor`. */
import type { ExecutionContext, ToolCall, ToolResultInfo, ToolSensitivity } from '../../chat/api.ts';
import {
  ATTEMPT_COMPLETION_TOOL_NAME, attemptCompletionSchema, executeAttemptCompletion, isAttemptCompletion,
  parseAttemptCompletionParams,
} from './attempt-completion.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

export const ATTEMPT_COMPLETION_EXECUTOR_NAME = 'AttemptCompletionExecutor';

type Warn = (message: string) => void;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class AttemptCompletionExecutor {
  private readonly warn: Warn;
  private readonly info: Warn;
  constructor(log: { warn: Warn; info: Warn }) { this.warn = log.warn; this.info = log.info; }

  canHandle(toolName: string): boolean { return isAttemptCompletion(toolName); }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart(ATTEMPT_COMPLETION_TOOL_NAME, call.arguments, call.id);
    let params;
    try { params = parseAttemptCompletionParams(call.arguments); }
    catch (cause) {
      const error = message(cause);
      ctx.emitToolCallError(error);
      const failed: ToolResultInfo = { toolCallId: call.id, blockId: ctx.block_id, toolName: ATTEMPT_COMPLETION_TOOL_NAME,
        input: call.arguments, output: null, success: false, error, durationMs: elapsed(started) };
      this.save(ctx, failed);
      return failed;
    }
    const result = executeAttemptCompletion(params);
    const durationMs = elapsed(started);
    // `task_completed` is the flag tool_loop.rs:2179 reads to stop the recursive loop.
    const output = { completed: result.completed, result: result.result, command: result.command, task_completed: true };
    ctx.emitToolCallEnd({ result: output, durationMs });
    this.info(`[AttemptCompletionExecutor] Task completed: result_len=${utf8ByteLength(result.result)}, command=${result.command === null ? 'None' : `Some(${JSON.stringify(result.command)})`}`);
    const completed: ToolResultInfo = { toolCallId: call.id, blockId: ctx.block_id, toolName: ATTEMPT_COMPLETION_TOOL_NAME,
      input: call.arguments, output, success: true, durationMs };
    this.save(ctx, completed);
    return completed;
  }

  sensitivityLevel(_toolName: string): ToolSensitivity { return 'low'; }
  name(): string { return ATTEMPT_COMPLETION_EXECUTOR_NAME; }
  /** registry.rs:138–148: the schema tool_loop.rs:922–941 auto-injects in Agent mode. */
  schemaTools(): { id: string; schema: unknown }[] {
    return [{ id: ATTEMPT_COMPLETION_TOOL_NAME, schema: attemptCompletionSchema() }];
  }

  private save(ctx: ExecutionContext, result: ToolResultInfo): void {
    try { ctx.saveToolBlock(result); }
    catch (cause) { this.warn(`[AttemptCompletionExecutor] Failed to save tool block: ${message(cause)}`); }
  }
}

function elapsed(started: number): number { return Math.trunc(performance.now() - started); }
