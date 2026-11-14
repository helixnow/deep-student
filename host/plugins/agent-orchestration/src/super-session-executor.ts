/**
 * `SuperSessionExecutor` (super_session_executor.rs:313–543): the Router's four worker tools. Dispatch and
 * message delegate to {@link SubagentExecutor.executeWithArgs}; only an active, enabled Super turn may run them.
 */
import type {
  ChatExecutionContext, ChatWorkerRuntimeService, ToolCall, ToolResultInfo, ToolSensitivity,
} from '../../chat/api.ts';
import type { JsonValue, WorkspaceCoordinator } from '../../agent-workspace/api.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { stripToolNamespace } from './automation-tool-args.ts';
import {
  buildSuperDispatchArgs, buildSuperMessageArgs, canHandleSuperSessionTool, mergeSuperAgentMetadata,
  superSessionManagesCancellation, superSessionSensitivityLevel,
} from './super-session.ts';
import {
  listWorkersCore, loadWorker, NOT_SUPER_SESSION_MESSAGE, WORKER_META_CLOSED_BY_ROUTER, workerTitle, type SuperWorkerCoordinator,
} from './super-session-exec.ts';
import { agentSuperFlag, applyTurnOverrides, type SuperSessionDeps } from './super-state.ts';
import type { SubagentExecutor } from './subagent-executor.ts';

export const SUPER_SESSION_EXECUTOR_NAME = 'SuperSessionExecutor';

type JsonObject = { [key: string]: JsonValue };

export interface SuperSessionExecutorDeps {
  coordinator: WorkspaceCoordinator;
  subagent: SubagentExecutor;
  /** Throws when chat_v2 / the workspace coordinator are unavailable (Rust `ctx.chat_v2_db` None). */
  superDeps(): SuperSessionDeps;
  workerRuntime(): ChatWorkerRuntimeService | undefined;
  log: { warn(message: string): void };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredTrimmed(raw: unknown, key: string): string {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)[key] : undefined;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') throw new Error(`${key} is required`);
  return trimmed;
}

const SENSITIVITY: Readonly<Record<ReturnType<typeof superSessionSensitivityLevel>, ToolSensitivity>> = { High: 'high', Medium: 'medium', Low: 'low' };

export class SuperSessionExecutor {
  private readonly deps: SuperSessionExecutorDeps;
  constructor(deps: SuperSessionExecutorDeps) { this.deps = deps; }

  name(): string { return SUPER_SESSION_EXECUTOR_NAME; }
  canHandle(toolName: string): boolean { return canHandleSuperSessionTool(toolName); }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return SENSITIVITY[superSessionSensitivityLevel(toolName)] ?? 'high';
  }
  managesCancellation(toolName: string): boolean { return superSessionManagesCancellation(toolName); }

  /** `resolve_super_turn`: the same probe the pipeline entry hook applies (active && enabled && !hidden). */
  private resolveSuperTurn(ctx: ChatExecutionContext): string {
    if (ctx.chat_v2_db === null) throw new Error(NOT_SUPER_SESSION_MESSAGE);
    let deps: SuperSessionDeps;
    try { deps = this.deps.superDeps(); }
    catch { throw new Error(NOT_SUPER_SESSION_MESSAGE); }
    const probe = { sessionId: ctx.session_id, workspaceId: null, options: {} } as Parameters<typeof applyTurnOverrides>[1];
    applyTurnOverrides(deps, probe, false);
    const workspaceId = probe.options?.superSession?.workspaceId ?? '';
    if (workspaceId.trim() === '') throw new Error(NOT_SUPER_SESSION_MESSAGE);
    return workspaceId;
  }

  private static requireWindow(ctx: ChatExecutionContext): void {
    if (ctx.tryWindow() === null) throw new Error('Super-agent worker dispatch requires the desktop window runtime');
  }

  private async dispatchWorker(raw: unknown, ctx: ChatExecutionContext): Promise<JsonValue> {
    const workspaceId = this.resolveSuperTurn(ctx);
    SuperSessionExecutor.requireWindow(ctx);
    const args = buildSuperDispatchArgs(raw, workspaceId, ctx.message_id);
    const result = await this.deps.subagent.executeWithArgs(args, ctx);
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
    return { ...result, worker_id: result.agent_session_id ?? null, title: args.title };
  }

  private async messageWorker(raw: unknown, ctx: ChatExecutionContext): Promise<JsonValue> {
    const workspaceId = this.resolveSuperTurn(ctx);
    SuperSessionExecutor.requireWindow(ctx);
    const { workerId, args } = buildSuperMessageArgs(raw, workspaceId);
    const agent = loadWorker(this.deps.coordinator as unknown as SuperWorkerCoordinator, workspaceId, workerId);
    // RUST-FIX(RF-W02-super-closed-worker-revival): Rust checks only `status == Closed`, which the worker run's
    // own cancelled/completed wind-down overwrites after close; the persisted closed_by_router flag survives it.
    if (agent.status === 'closed' || agentSuperFlag(agent, WORKER_META_CLOSED_BY_ROUTER)) {
      throw new Error(`Worker ${workerId} was closed; dispatch a new worker instead`);
    }
    const title = workerTitle(agent);
    const result = await this.deps.subagent.executeWithArgs(args, ctx);
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
    return { ...result, worker_id: workerId, title };
  }

  /** `close_worker_core`: cancel first; a failed cancel leaves the worker open and unmarked. */
  private async closeWorker(raw: unknown, ctx: ChatExecutionContext): Promise<JsonValue> {
    const workspaceId = this.resolveSuperTurn(ctx);
    const workerId = requiredTrimmed(raw, 'worker_id');
    const runtime = this.deps.workerRuntime();
    if (runtime === undefined) throw new Error('ChatV2State not available for Super-agent tools');
    const coordinator = this.deps.coordinator;
    const agent = loadWorker(coordinator as unknown as SuperWorkerCoordinator, workspaceId, workerId);
    const title = workerTitle(agent);
    if (agent.status === 'closed') {
      return { worker_id: workerId, workspace_id: workspaceId, title, status: 'closed', already_closed: true };
    }
    await runtime.cancelWorkspaceAgentBackend(workspaceId, workerId);
    coordinator.updateAgentStatus(workspaceId, workerId, 'closed');
    const latest = coordinator.getAgent(workspaceId, workerId)?.metadata ?? agent.metadata;
    const metadata = mergeSuperAgentMetadata(latest, [['closed_by_router', true], ['closed_at', toRfc3339()]]);
    coordinator.updateAgentMetadata(workspaceId, workerId, metadata as JsonObject);
    return { worker_id: workerId, workspace_id: workspaceId, title, status: 'closed', already_closed: false };
  }

  private async executeTool(call: ToolCall, ctx: ChatExecutionContext): Promise<JsonValue> {
    if (ctx.isCancelled()) throw new Error('Super-agent tool call cancelled before start');
    const name = stripToolNamespace(call.name);
    switch (name) {
      case 'super_dispatch_worker': return this.dispatchWorker(call.arguments, ctx);
      case 'super_message_worker': return this.messageWorker(call.arguments, ctx);
      case 'super_close_worker': return this.closeWorker(call.arguments, ctx);
      case 'super_list_workers':
        return listWorkersCore(this.deps.coordinator as unknown as SuperWorkerCoordinator, this.resolveSuperTurn(ctx)) as JsonValue;
      default: throw new Error(`Unknown Super-agent tool: ${name}`);
    }
  }

  async execute(call: ToolCall, ctx: ChatExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let info: ToolResultInfo;
    try {
      const output = await this.executeTool(call, ctx);
      const durationMs = Math.trunc(performance.now() - started);
      ctx.emitToolCallEnd({ result: output, durationMs });
      info = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output, success: true, durationMs };
    } catch (error) {
      const durationMs = Math.trunc(performance.now() - started);
      const text = message(error);
      ctx.emitToolCallError(text);
      info = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output: null, success: false, error: text, durationMs };
    }
    try { ctx.saveToolBlock(info); }
    catch (error) { this.deps.log.warn(`[SuperSessionExecutor] Failed to save tool block: ${message(error)}`); }
    return info;
  }
}
