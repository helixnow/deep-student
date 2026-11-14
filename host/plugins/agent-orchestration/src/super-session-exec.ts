/**
 * super_session_executor.rs:144–311 — `super_close_worker` / `super_list_workers` 的核心，
 * 以及 Super 工具在非 Super 回合的 fail-closed 判定。
 *
 * 跨 lane 依赖（L05 `agentWorkspace`）以最小结构接口声明；任务管理器在已发布
 * 契约里没有，因此按可选能力读取，缺失时 list 报错（Rust `get_task_manager` 同样返回 Err）。
 */
import { takeChars } from '../../../platform/util/index.ts';
import { chronoRfc3339 } from '../../../platform/time/index.ts';
import { AgentProfileResolver } from '../../agent-workspace/portable.ts';
import type { SubagentTaskData, WorkspaceAgent } from '../../agent-workspace/api.ts';
import {
  agentSuperFlag, agentSuperStr, cancelWorkerCore, patchAgentSuperMeta,
  type SuperSessionDeps, type SuperWorkspaceCoordinator,
} from './super-state.ts';
import { SUPER_AGENT_META_KEY, superMeta } from './super-session.ts';

export const LIST_RECENT_TASKS_LIMIT = 200;
export const LIST_TASK_PREVIEW_CHARS = 200;
export const LIST_RESULT_PREVIEW_CHARS = 600;

export const NOT_SUPER_SESSION_MESSAGE =
  'Super-agent tools are only available in the active Super-agent session';
export const WORKER_META_TITLE = 'title';
export const WORKER_META_DISPATCHED_IN = 'dispatched_in_message_id';
export const WORKER_META_CLOSED_BY_ROUTER = 'closed_by_router';

export interface SuperTaskManager {
  listRecentTasks(limit: number): SubagentTaskData[];
  getAgentTask(agentSessionId: string): SubagentTaskData | null;
  updateStatus(taskId: string, status: string, resultSummary?: string | null): void;
}

/** `agentWorkspace` + 尚未发布的 `getTaskManager().listRecentTasks` 能力。 */
export interface SuperWorkerCoordinator extends Omit<SuperWorkspaceCoordinator, 'getTaskManager'> {
  getTaskManager?(workspaceId: string): SuperTaskManager;
}

export type SuperWorkerAgent = WorkspaceAgent;

function truncateChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** super_session_executor.rs:144–161。 */
export function loadWorker(
  coordinator: SuperWorkerCoordinator, workspaceId: string, workerId: string,
): SuperWorkerAgent {
  const agent = coordinator.getAgent(workspaceId, workerId);
  if (agent === null) {
    throw new Error(`Worker ${workerId} not found in the Super-agent workspace; use super_list_workers to see current workers`);
  }
  if (agent.role !== 'worker') throw new Error(`Agent ${workerId} is not a worker`);
  return agent;
}

/** super-session/prompt.rs `worker_title`：metadata `super_agent.title`，缺失时为 null。 */
export function workerTitle(agent: SuperWorkerAgent): string | null {
  const entry = superMeta(agent.metadata);
  const title = entry?.[WORKER_META_TITLE];
  return typeof title === 'string' ? title : null;
}

/** super_session_executor.rs:163–186：只在 `super_agent` 子对象里合并字段。 */
export function mergeSuperAgentMetadata(
  metadata: unknown, patch: ReadonlyArray<readonly [string, unknown]>,
): Record<string, unknown> {
  const base = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) } : {};
  const existing = base[SUPER_AGENT_META_KEY];
  const entry = existing !== null && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) } : {};
  for (const [key, value] of patch) entry[key] = value;
  base[SUPER_AGENT_META_KEY] = entry;
  return base;
}

/** super_session_executor.rs:187–239。 */
export function closeWorkerCore(
  deps: SuperSessionDeps, workspaceId: string, workerId: string, nowMs: number = Date.now(),
): Record<string, unknown> {
  const agent = loadWorker(deps.workspace as SuperWorkerCoordinator, workspaceId, workerId);
  const title = workerTitle(agent);
  if (agent.status === 'closed') {
    return {
      worker_id: workerId, workspace_id: workspaceId, title, status: 'closed', already_closed: true,
    };
  }

  // 1. 先取消（停流 + pending/running 任务置 Cancelled）
  cancelWorkerCore(deps, workspaceId, workerId, 'super_close_worker');
  // 2. 再置 Closed
  deps.workspace.updateAgentStatus(workspaceId, workerId, 'closed');
  // 3. 标记 closed_by_router（收件箱据此吞掉取消回执）。重新读取 metadata，
  //    避免覆盖取消过程中的并发写入。
  const latest = deps.workspace.getAgent(workspaceId, workerId);
  const metadata = mergeSuperAgentMetadata(latest?.metadata ?? agent.metadata, [
    [WORKER_META_CLOSED_BY_ROUTER, true],
    ['closed_at', chronoRfc3339(BigInt(nowMs) * 1_000_000n)],
  ]);
  deps.workspace.updateAgentMetadata(workspaceId, workerId, metadata as unknown as Parameters<SuperWorkspaceCoordinator['updateAgentMetadata']>[2]);

  return {
    worker_id: workerId, workspace_id: workspaceId, title, status: 'closed', already_closed: false,
  };
}

/** super_session_executor.rs:241–254。 */
export function taskSummary(task: SubagentTaskData): Record<string, unknown> {
  return {
    task_id: task.id,
    status: task.status,
    task: task.initialTask === null ? null : truncateChars(task.initialTask, LIST_TASK_PREVIEW_CHARS),
    result_summary: task.resultSummary === null
      ? null : truncateChars(task.resultSummary, LIST_RESULT_PREVIEW_CHARS),
    created_at: task.createdAt,
    completed_at: task.completedAt,
  };
}

/** super_session_executor.rs:256–311。 */
export function listWorkersCore(
  coordinator: SuperWorkerCoordinator, workspaceId: string,
): Record<string, unknown> {
  const agents = coordinator.listAgents(workspaceId);
  const taskManager = coordinator.getTaskManager?.(workspaceId);
  if (taskManager === undefined) {
    throw new Error('Failed to list worker tasks: task manager is not available in the workspace coordinator');
  }
  let tasks: SubagentTaskData[];
  try {
    tasks = taskManager.listRecentTasks(LIST_RECENT_TASKS_LIMIT);
  } catch (error) {
    throw new Error(`Failed to list worker tasks: ${messageOf(error)}`);
  }
  const workers = agents
    .filter((agent) => agent.role === 'worker')
    .map((agent) => {
      const own = tasks.filter((task) => task.agentSessionId === agent.sessionId);
      const latest = own[0];
      return {
        worker_id: agent.sessionId,
        title: workerTitle(agent),
        status: agent.status,
        profile_id: resolveProfileId(agent),
        dispatched_in_message_id: agentSuperStr(agent, WORKER_META_DISPATCHED_IN),
        closed_by_router: agentSuperFlag(agent, WORKER_META_CLOSED_BY_ROUTER),
        joined_at: agent.joinedAt,
        last_active_at: agent.lastActiveAt,
        task_count: own.length,
        latest_task: latest === undefined ? null : taskSummary(latest),
      };
    });
  // 最近活跃在前。
  workers.sort((left, right) => right.last_active_at.localeCompare(left.last_active_at));
  return { workspace_id: workspaceId, count: workers.length, workers };
}

function resolveProfileId(agent: SuperWorkerAgent): string | null {
  try {
    return AgentProfileResolver.resolveForAgent(agent).id;
  } catch {
    return null;
  }
}

/**
 * super_session_executor.rs:323–352：非 Super 回合一律 fail-closed。
 * `superTurn` 为 null 等价于 Rust 里 `SendOptions.super_session` 缺失。
 */
export function requireSuperTurn<T>(superTurn: T | null | undefined): T {
  if (superTurn === null || superTurn === undefined) throw new Error(NOT_SUPER_SESSION_MESSAGE);
  return superTurn;
}
