/** L04 handlers over the L05 coordinator's task/sleep runtime. */
import type { WorkspaceCoordinator } from '../../agent-workspace/api.ts';
import type { ChatV2State } from './state.ts';
import type { ManualWakeRequest, ManualWakeResponse } from '../api.ts';
import { ensureWorkspaceCreator, requireCoordinator } from './workspace-actions.ts';
import { errorText, type ChatLogger } from './logger.ts';

/** Minimal additive L05 port; these methods exist on the published service instance. */
export interface WorkspaceRuntimeTaskManager {
  getTasksToRestore(): { id: string }[];
  getAgentTask(agentSessionId: string): { id: string } | null;
  updateStatus(taskId: string, status: 'cancelled', reason: string): void;
}
export interface WorkspaceWakeInfo {
  sleepId: string; workspaceId: string; coordinatorSessionId: string;
  awakenedBy: string; awakenMessage: string | null; wakeReason: string;
}
/** L05 now publishes these methods directly; keep the additive L04 type name for consumers. */
export type WorkspaceRuntimeCoordinator = WorkspaceCoordinator;

/** Rust Debug of L05's domain errors, as used by workspace_handlers.rs. */
function runtimeErrorDebug(error: unknown): string {
  if (!(error instanceof Error) || !('kind' in error)) return errorText(error);
  const value = error as Error & { kind: string; detail?: string; taskId?: string; from?: string; to?: string };
  const title = (status: string) => status.charAt(0).toUpperCase() + status.slice(1);
  if (value.kind === 'invalid_transition') {
    return `InvalidTransition { task_id: ${JSON.stringify(value.taskId)}, from: ${title(value.from!)}, to: ${title(value.to!)} }`;
  }
  if (value.kind === 'timeout') return 'Timeout';
  if (value.kind === 'cancelled') return 'Cancelled';
  const variant = { database: 'Database', not_found: 'NotFound', already_awakened: 'AlreadyAwakened' }[value.kind];
  if (variant === undefined) return value.message;
  const prefix = value.kind === 'database' ? 'Database error: '
    : value.kind === 'already_awakened' ? 'Sleep already awakened: '
      : value.message.startsWith('Task not found: ') ? 'Task not found: ' : 'Sleep not found: ';
  return `${variant}(${JSON.stringify(value.detail ?? value.message.slice(prefix.length))})`;
}

/** Rust `let _ = update_agent_status`: no warning at this specific best-effort site. */
function setCancelledIgnoringError(service: WorkspaceCoordinator, workspaceId: string, agentId: string): void {
  try { service.updateAgentStatus(workspaceId, agentId, 'cancelled'); }
  catch { return; }
}

function cancelActiveWorkers(service: WorkspaceRuntimeCoordinator, state: ChatV2State,
  workspaceId: string, reason: string, log: ChatLogger): void {
  try {
    for (const agent of service.listAgents(workspaceId)) {
      if (agent.role !== 'worker') continue;
      const cancelled = state.cancelStream(agent.sessionId);
      if (cancelled || agent.status === 'running') {
        setCancelledIgnoringError(service, workspaceId, agent.sessionId);
        log.info(`[Workspace::handlers] Cancelled worker on ${reason}: agent=${agent.sessionId}, had_stream=${cancelled}`);
      }
    }
  } catch (error) {
    log.warn(`[Workspace::handlers] Failed to list agents for cancel propagation (${reason}): ${errorText(error)}`);
  }
  let tasks: WorkspaceRuntimeTaskManager;
  try { tasks = service.getTaskManager(workspaceId); }
  catch (error) {
    log.warn(`[Workspace::handlers] Failed to get task manager for cancel propagation (${reason}): ${errorText(error)}`);
    return;
  }
  let pending: { id: string }[];
  try { pending = tasks.getTasksToRestore(); }
  catch (error) {
    log.warn(`[Workspace::handlers] Failed to enumerate tasks for cancel propagation (${reason}): ${runtimeErrorDebug(error)}`);
    return;
  }
  for (const task of pending) {
    try { tasks.updateStatus(task.id, 'cancelled', reason); }
    catch (error) { log.warn(`[Workspace::handlers] Failed to cancel task ${task.id} on ${reason}: ${runtimeErrorDebug(error)}`); }
  }
}

export function closeWorkspaceAction(service: WorkspaceRuntimeCoordinator | undefined, state: ChatV2State,
  sessionId: string, workspaceId: string, log: ChatLogger, remove = false): void {
  requireCoordinator(service);
  ensureWorkspaceCreator(service!, workspaceId, sessionId);
  cancelActiveWorkers(service!, state, workspaceId, remove ? 'workspace deleted' : 'workspace closed', log);
  if (remove) service!.deleteWorkspace(workspaceId);
  else service!.closeWorkspace(workspaceId);
}

function cancelWorkspaceAgentCore(service: WorkspaceRuntimeCoordinator, state: ChatV2State,
  workspaceId: string, agentId: string, log: ChatLogger): boolean {
  const streamCancelled = state.cancelStream(agentId);
  let taskCancelled = false;
  let tasks: WorkspaceRuntimeTaskManager | null = null;
  try { tasks = service.getTaskManager(workspaceId); }
  catch (error) { log.warn(`[Workspace::handlers] Failed to get task manager for cancel: ${errorText(error)}`); }
  if (tasks !== null) {
    let task: { id: string } | null = null;
    try { task = tasks.getAgentTask(agentId); }
    catch (error) { log.warn(`[Workspace::handlers] Failed to query task for cancel: agent=${agentId}, error=${runtimeErrorDebug(error)}`); }
    if (task !== null) {
      try {
        tasks.updateStatus(task.id, 'cancelled', 'user cancelled');
        taskCancelled = true;
        log.info(`[Workspace::handlers] Cancelled task ${task.id} for agent ${agentId}`);
      } catch (error) {
        log.warn(`[Workspace::handlers] Failed to cancel task ${task.id} for agent ${agentId}: ${runtimeErrorDebug(error)}`);
      }
    }
  }
  const cancelled = streamCancelled || taskCancelled;
  if (cancelled) {
    setCancelledIgnoringError(service, workspaceId, agentId);
    service.emitWarning({ workspace_id: workspaceId, code: 'agent_cancelled',
      message: `Agent ${agentId} execution cancelled by user`, agent_session_id: agentId,
      message_id: null, retry_count: null, max_retries: null });
  }
  return cancelled;
}

/** Rust's trusted async backend entry discards the bool and omits membership authorization. */
export async function cancelWorkspaceAgentBackend(service: WorkspaceRuntimeCoordinator, state: ChatV2State,
  workspaceId: string, agentId: string, log: ChatLogger): Promise<void> {
  cancelWorkspaceAgentCore(service, state, workspaceId, agentId, log);
}

export function cancelWorkspaceAgentAction(service: WorkspaceRuntimeCoordinator | undefined, state: ChatV2State,
  sessionId: string, workspaceId: string, agentId: string, log: ChatLogger): boolean {
  requireCoordinator(service).ensureMemberOrCreator(workspaceId, sessionId);
  return cancelWorkspaceAgentCore(service!, state, workspaceId, agentId, log);
}

export function manualWakeAction(service: WorkspaceRuntimeCoordinator | undefined,
  request: ManualWakeRequest, log: ChatLogger): ManualWakeResponse {
  requireCoordinator(service).ensureMemberOrCreator(request.workspace_id, request.requester_session_id);
  const sleep = service!.getSleepManager(request.workspace_id);
  let info: WorkspaceWakeInfo | null;
  try { info = sleep.manualWake(request.sleep_id, request.message ?? null); }
  catch (error) { throw new Error(`Failed to wake: ${runtimeErrorDebug(error)}`); }
  const success = info !== null;
  log.info(`[Workspace::handlers] Manual wake: sleep_id=${request.sleep_id}, success=${success}`);
  if (info !== null) service!.emitCoordinatorAwakened(info);
  return { success, sleep_id: request.sleep_id };
}

export function cancelSleepAction(service: WorkspaceRuntimeCoordinator | undefined,
  sessionId: string, workspaceId: string, sleepId: string, log: ChatLogger): boolean {
  requireCoordinator(service).ensureMemberOrCreator(workspaceId, sessionId);
  const sleep = service!.getSleepManager(workspaceId);
  let cancelled: boolean;
  try { cancelled = sleep.cancel(sleepId); }
  catch (error) { throw new Error(`Failed to cancel sleep: ${runtimeErrorDebug(error)}`); }
  log.info(`[Workspace::handlers] Cancel sleep: sleep_id=${sleepId}, cancelled=${cancelled}`);
  return cancelled;
}

/** workspace_handlers.rs:385-465: emergency bookkeeping after cancelAllStreams. */
export function markAllWorkersCancelled(service: WorkspaceRuntimeCoordinator, state: ChatV2State,
  reason: string, log: ChatLogger): number {
  let count = 0;
  for (const workspaceId of service.loadedWorkspaceIds()) {
    try {
      for (const agent of service.listAgents(workspaceId)) {
        if (agent.role !== 'worker') continue;
        const cancelled = state.cancelStream(agent.sessionId);
        if (!cancelled && !['running', 'queued', 'interrupted'].includes(agent.status)) continue;
        const previous = agent.status.charAt(0).toUpperCase() + agent.status.slice(1);
        try {
          service.updateAgentStatus(workspaceId, agent.sessionId, 'cancelled'); count++;
          log.info(`[Workspace::handlers] mark_all_workers_cancelled (${reason}): workspace=${workspaceId}, agent=${agent.sessionId}, prev_status=${previous}`);
        } catch (error) {
          log.warn(`[Workspace::handlers] Failed to cancel worker ${agent.sessionId} in ${workspaceId} (${reason}): ${errorText(error)}`);
        }
      }
    } catch (error) {
      log.warn(`[Workspace::handlers] mark_all_workers_cancelled: failed to list agents for ${workspaceId} (${reason}): ${errorText(error)}`);
    }
    const tasks = tasksForEmergencyStop(service, workspaceId);
    if (tasks === null) continue;
    for (const task of tasks.pending) {
      try { tasks.manager.updateStatus(task.id, 'cancelled', reason); }
      catch (error) { log.warn(`[Workspace::handlers] Failed to cancel task ${task.id} in ${workspaceId} (${reason}): ${runtimeErrorDebug(error)}`); }
    }
  }
  return count;
}
function tasksForEmergencyStop(service: WorkspaceRuntimeCoordinator, workspaceId: string):
  { manager: WorkspaceRuntimeTaskManager; pending: { id: string }[] } | null {
  try {
    const manager = service.getTaskManager(workspaceId);
    return { manager, pending: manager.getTasksToRestore() };
  } catch { return null; } // Rust nested if let Ok intentionally has no failure log here.
}
