/** ToolPackExecutor constants and admission gate (tool_pack_executor.rs:41–52, 141–171). */

export const MAX_SUB_TOOLS = 20;
export const MAX_CONCURRENCY = 10;
export const DEFAULT_PACK_TIMEOUT_SECS = 300;
export const CANCEL_GRACE_PERIOD_SECS = 3;
export const MAX_FAILURE_SAMPLE_CHARS = 300;
export const TOOL_PACK_EXECUTOR_NAME = 'ToolPackExecutor';
export const TOOL_PACK_TOOL_NAME = 'tool_pack';

export function canHandleToolPack(toolName: string): boolean {
  return toolName === 'builtin-tool_pack' || toolName === TOOL_PACK_TOOL_NAME;
}

/** tool_pack_executor.rs:160–171: pack execution requires the central dispatcher. */
export function assertCentralDispatcherAvailable(available: boolean): void {
  if (available) return;
  throw new Error('tool_pack requires the central admitted tool dispatcher');
}

/**
 * tool_pack_executor.rs:66–110 `create_sub_context`：子上下文继承父 session_id
 * （G08 任务树预算按 session 归集），只替换 blockId/取消令牌，并清空 shell 审批
 * （审批绑定单条顶层命令，不得被 pack 子调用继承）。
 */
export interface ToolPackContext {
  sessionId: string;
  messageId: string;
  blockId: string;
  variantId?: string | null;
  roundId?: string | null;
  toolCallId?: string | null;
  canvasNoteId?: string | null;
  shellGuardApproved?: boolean;
  shellAuthorityAdmission?: unknown;
  cancellationToken?: AbortSignal | null;
  [key: string]: unknown;
}

export function createSubContext(
  parent: ToolPackContext, blockId: string, cancellationToken: AbortSignal | null = null,
): ToolPackContext {
  return {
    ...parent,
    blockId,
    cancellationToken,
    shellGuardApproved: false,
    shellAuthorityAdmission: null,
  };
}
