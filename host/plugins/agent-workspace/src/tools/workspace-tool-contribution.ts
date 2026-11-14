/**
 * W02: L07 contribution for workspace_executor.rs — L04 ExecutionContext + the L04 `chatWorkerRuntime`
 * service (ChatV2State/Pipeline/Database seams of workspace_executor.rs:335-364) -> WorkspaceToolExecutor.
 */
import type { ChatWorkerRuntimeService, ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../../chat/api.ts';
import type { JsonValue } from '../../api.ts';
import type { WorkspaceCoordinator } from '../workspace/coordinator.ts';
import { WORKSPACE_WORKER_READY_EVENT, WorkspaceToolExecutor } from './workspace-executor.ts';
import type { ToolSensitivity } from './shared.ts';

export class WorkspaceToolContribution implements ToolExecutor {
  private readonly coordinator: WorkspaceCoordinator;
  private readonly workerRuntime: () => ChatWorkerRuntimeService | undefined;
  private readonly probe: WorkspaceToolExecutor;

  constructor(coordinator: WorkspaceCoordinator, workerRuntime: () => ChatWorkerRuntimeService | undefined) {
    this.coordinator = coordinator;
    this.workerRuntime = workerRuntime;
    this.probe = new WorkspaceToolExecutor(coordinator, { sessionId: '' });
  }

  name(): string { return this.probe.name(); }
  canHandle(name: string): boolean { return this.probe.canHandle(name); }
  sensitivityLevel(name: string): ToolSensitivity { return this.probe.sensitivityLevel(name); }

  execute(call: ToolCall, context: ExecutionContext): Promise<ToolResultInfo> {
    const runtime = this.workerRuntime();
    const logger = context.services.logger;
    const executor = new WorkspaceToolExecutor(this.coordinator, {
      sessionId: context.session_id,
      blockId: context.block_id,
      // Rust `ctx.chat_v2_db`: absent in contexts built without the chat database.
      chatV2Db: context.chat_v2_db === null ? null : runtime?.sessionStore ?? null,
      runWorkspaceAgentBackend: async request => {
        const window = context.windowRef();
        if (runtime === undefined) throw new Error('ChatV2State not available for worker runtime');
        if (!runtime.isRunAvailable()) throw new Error('ChatV2Pipeline not available for worker runtime');
        const run = await runtime.runWorkspaceAgentBackend({
          workspace_id: request.workspaceId, agent_session_id: request.agentSessionId,
          requester_session_id: request.requesterSessionId, reminder: request.reminder,
        }, window);
        return { messageId: run.message_id };
      },
      skillContents: context.skill_contents === null ? null : new Map(Object.entries(context.skill_contents)),
      emitToolCallStart: (name, args, id) => context.emitToolCallStart(name, args, id),
      emitToolCallEnd: payload => context.emitToolCallEnd(payload),
      emitToolCallError: error => context.emitToolCallError(error),
      saveToolBlock: result => context.saveToolBlock(result),
      emitWorkerReady: event => { context.windowRef(); context.services.backendEvents.emit(WORKSPACE_WORKER_READY_EVENT, event); },
      warn: message => logger.warn(message),
      info: message => logger.info(message),
    });
    return executor.execute({ ...call, arguments: call.arguments as JsonValue });
  }
}
