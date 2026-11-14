/**
 * Registration for the worker-runtime commands. Called from the `chatPipeline`
 * injection only when L03 publishes `execute` and the L05/L06 surfaces exist
 * (`workerRuntimeSurfaces`), so no command runs on a partial runtime.
 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import type { Commands } from '../api.ts';
import type { AgentCompletionOutbox, WorkspaceCoordinator } from '../../agent-workspace/api.ts';
import type { ChatV2Database } from '../api.ts';
import type { ChatV2State } from './state.ts';
import type { CompletionDispatcherRuntime } from './completion-dispatcher.ts';
import { requireCoordinator } from './workspace-actions.ts';
import {
  workspaceCreateAgentAction, workspaceRestoreExecutionsAction, workspaceRunAgentAction,
  type WorkerPipelinePort, type WorkerRuntimeDeps, type WorkerRuntimeSurfaces,
} from './workspace-run-agent.ts';
import { errorText, type ChatLogger } from './logger.ts';

type Args<K extends keyof Commands> = Commands[K]['args'];

export interface WorkspaceWorkerCommandDeps {
  db: ChatV2Database;
  state: ChatV2State;
  pipeline: WorkerPipelinePort;
  surfaces: WorkerRuntimeSurfaces;
  coordinator: () => WorkspaceCoordinator | undefined;
  outbox: () => AgentCompletionOutbox | undefined;
  dispatcher: CompletionDispatcherRuntime;
  log: ChatLogger;
}

/** Rust `Result<_, String>`: every failure crosses IPC as its message string. */
async function stringResult<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(errorText(error));
  }
}

/** Per-call runtime snapshot shared by the commands and the `chatWorkerRuntime` service. */
export function workerRuntimeDeps(ctx: Context, deps: WorkspaceWorkerCommandDeps): () => WorkerRuntimeDeps {
  return () => ({
    coordinator: requireCoordinator(deps.coordinator()), state: deps.state, db: deps.db, pipeline: deps.pipeline,
    outbox: deps.outbox(), surfaces: deps.surfaces, log: deps.log,
    emit: (event, payload) => ctx.backendEvents.emit(event, payload),
  });
}

export function registerWorkspaceWorkerCommands(ctx: Context, deps: WorkspaceWorkerCommandDeps): void {
  const runtime = workerRuntimeDeps(ctx, deps);
  ctx.commands.register<Args<'workspace_run_agent'>>('workspace_run_agent', (a, call) => stringResult(() =>
    workspaceRunAgentAction(runtime(), a.request, call.source)));
  ctx.commands.register<Args<'workspace_create_agent'>>('workspace_create_agent', (a, call) => stringResult(() =>
    workspaceCreateAgentAction(runtime(), a.request, call.source)));
  ctx.commands.register<Args<'workspace_restore_executions'>>('workspace_restore_executions', (a, call) => stringResult(() =>
    workspaceRestoreExecutionsAction(runtime(), deps.dispatcher, a.sessionId, a.workspaceId, call.source)));
}
