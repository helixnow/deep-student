/** role_pack_executor.rs:161–245 `RolePackExecutor` (versioned role packs: list / get / validate). */
import type { ExecutionContext, ToolCall, ToolConcurrency, ToolResultInfo, ToolSensitivity } from '../../chat/api.ts';
import { ROLE_PACK_EXECUTOR_NAME, canHandleRolePackTool, executeRolePackRead } from './role-packs.ts';
import { runStandardTool } from './standard-tool.ts';

export class RolePackExecutor {
  private readonly warn: (message: string) => void;
  constructor(warn: (message: string) => void) { this.warn = warn; }

  canHandle(toolName: string): boolean { return canHandleRolePackTool(toolName); }
  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    return runStandardTool(call, ctx, ROLE_PACK_EXECUTOR_NAME,
      () => executeRolePackRead(call.name, call.arguments, ctx.session_id, ctx.message_id), this.warn);
  }
  sensitivityLevel(_toolName: string): ToolSensitivity { return 'low'; }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'read_only'; }
  name(): string { return ROLE_PACK_EXECUTOR_NAME; }
}
