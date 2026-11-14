/**
 * Generic tool executor, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/general_executor.rs`.
 *
 * Handles every non-Canvas tool through the MCP / legacy `ToolRegistry` carried by the
 * execution context. It is the fixed tail of the roster: specific executors win first.
 */
import type { ChatExecutionContext, ToolCall, ToolResultInfo } from '../../../chat/api.ts';
import type { JsonValue, ToolContext } from '../../../mcp/api.ts';
import { redactToolArgumentsForDisplay } from '../../../agent-workspace/portable.ts';
import { mcpOutputMaterialization } from './mcp-materialization-port.ts';
import {
  isCanvasTool, isExternalMcpToolName, isHighRiskExternalMcpTool,
} from './naming.ts';

export type ToolSensitivity = 'low' | 'medium' | 'high';

const LOW_RISK_TOOLS: readonly string[] = ['web_search'];

const HIGH_RISK_TOOLS: readonly string[] = [
  'mcp_shell_execute',
  'mcp_file_write',
  'mcp_file_delete',
];

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function raceWithCancellation<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('工具调用已取消'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(new Error('工具调用已取消')); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      cause => { signal.removeEventListener('abort', onAbort); reject(cause); },
    );
  });
}

export class GeneralToolExecutor {
  canHandle(toolName: string): boolean {
    return !isCanvasTool(toolName);
  }

  /** general_executor.rs:62–190. Timeouts and cancellation stay with the registry. */
  async execute(call: ToolCall, ctx: ChatExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    const log = ctx.services.logger;
    // External MCP command tools keep raw arguments for execution, never for events/persistence.
    const audited = redactToolArgumentsForDisplay(call.name, call.arguments as JsonValue);
    log.debug(`[GeneralToolExecutor] Executing tool: name=${call.name}, id=${call.id}`);
    ctx.emitToolCallStart(call.name, audited, call.id);
    const save = (result: ToolResultInfo, what: string): ToolResultInfo => {
      try { ctx.saveToolBlock(result); }
      catch (cause) { log.warn(`[GeneralToolExecutor] Failed to save ${what}: ${errorText(cause)}`); }
      return result;
    };
    const cancelSignal = ctx.cancellation_token ?? null;
    if (cancelSignal?.aborted || ctx.isCancelled()) {
      const message = '工具调用已取消';
      ctx.emitToolCallError(message);
      return save({ toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: audited,
        output: null, success: false, error: message, durationMs: Math.trunc(performance.now() - started) }, 'tool block');
    }
    const window = typeof ctx.tryWindow === 'function' ? ctx.tryWindow() : ctx.windowRef();
    const toolContext: ToolContext = {
      supports_tools: true, mcp_client: null, stream_event: null, stage: 'tool_call', memory_enabled: null,
      window, signal: cancelSignal,
    };
    let ok: boolean;
    let data: JsonValue | null;
    let error: string | null;
    let usage: JsonValue | null;
    try {
      [ok, data, error, usage] = await raceWithCancellation(
        ctx.tool_registry.callTool(call.name, call.arguments as JsonValue, toolContext),
        cancelSignal,
      );
    } catch (cause) {
      const message = errorText(cause);
      ctx.emitToolCallError(message);
      return save({ toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: audited,
        output: null, success: false, error: message, durationMs: Math.trunc(performance.now() - started) }, 'tool block');
    }
    const durationMs = Math.trunc(performance.now() - started);
    if (!ok) {
      const message = error ?? 'Tool call failed';
      ctx.emitToolCallError(message);
      log.warn(`[GeneralToolExecutor] Tool ${call.name} failed: ${message} (${durationMs}ms)`);
      return save({ toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: audited,
        output: null, success: false, error: message, durationMs }, 'tool block');
    }
    let output: unknown = data ?? null;
    if (isExternalMcpToolName(call.name)) {
      try {
        output = await mcpOutputMaterialization().materialize(output, {
          dataDir: ctx.services.app.dataDir, sessionId: ctx.session_id, toolName: call.name, usage,
        });
      } catch (cause) {
        const message = errorText(cause);
        ctx.emitToolCallError(message);
        return save({ toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: audited,
          output: null, success: false, error: message, durationMs }, 'MCP materialization error block');
      }
    }
    ctx.emitToolCallEnd({ result: output, durationMs });
    log.debug(`[GeneralToolExecutor] Tool ${call.name} completed successfully in ${durationMs}ms`);
    return save({ toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: audited,
      output, success: true, durationMs }, 'tool block');
  }

  sensitivityLevel(toolName: string): ToolSensitivity {
    // Default to Medium so the approval gate cannot be bypassed by falling
    // through the generic executor.
    if (HIGH_RISK_TOOLS.includes(toolName) || isHighRiskExternalMcpTool(toolName)) {
      return 'high';
    }
    // An external server controls the implementation behind its advertised
    // name; it must not inherit a local low-risk label.
    if (isExternalMcpToolName(toolName)) return 'medium';
    if (LOW_RISK_TOOLS.includes(toolName)) return 'low';
    return 'medium';
  }

  name(): string {
    return 'GeneralToolExecutor';
  }
}
