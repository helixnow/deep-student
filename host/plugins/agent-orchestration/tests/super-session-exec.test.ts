/**
 * super_session_executor.rs 的 close/list 核心与“非 Super 回合 fail-closed”。
 *
 * L05 只发布 `agentWorkspace` 的类型，测试不得引用其实现；这里用按 Rust
 * WorkspaceCoordinator / SubagentTaskManager 语义实现的内存替身。
 */
import { describe, expect, it } from 'vitest';
import { AgentProfileResolver } from '../../agent-workspace/portable.ts';
import type {
  AgentRole, AgentStatus, JsonValue, SubagentTaskData, Workspace, WorkspaceAgent,
} from '../../agent-workspace/api.ts';
import type { SuperSessionDeps } from '../src/super-state.ts';
import {
  NOT_SUPER_SESSION_MESSAGE, closeWorkerCore, listWorkersCore, requireSuperTurn,
  type SuperTaskManager, type SuperWorkerCoordinator,
} from '../src/super-session-exec.ts';

class MemoryTaskManager implements SuperTaskManager {
  private readonly tasks: SubagentTaskData[] = [];
  listRecentTasks(limit: number): SubagentTaskData[] {
    return [...this.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  getAgentTask(agentSessionId: string): SubagentTaskData | null {
    return this.tasks.find((task) => task.agentSessionId === agentSessionId
      && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') ?? null;
  }
  getTask(taskId: string): SubagentTaskData | null {
    return this.tasks.find((task) => task.id === taskId) ?? null;
  }
  createTask(task: SubagentTaskData): void { this.tasks.push({ ...task }); }
  markRunning(taskId: string): void {
    const task = this.getTask(taskId);
    if (task === null) throw new Error(`Task not found: ${taskId}`);
    task.status = 'running';
  }
  updateStatus(taskId: string, status: string, resultSummary?: string | null): void {
    const task = this.getTask(taskId);
    if (task === null) throw new Error(`Task not found: ${taskId}`);
    task.status = status as SubagentTaskData['status'];
    task.resultSummary = resultSummary ?? null;
    if (status === 'cancelled' || status === 'completed' || status === 'failed') {
      task.completedAt = '2026-11-03T00:00:01+00:00';
    }
  }
}

class MemoryCoordinator implements SuperWorkerCoordinator {
  private readonly agents = new Map<string, WorkspaceAgent>();
  private readonly taskManagers = new Map<string, MemoryTaskManager>();
  private readonly workspaces = new Map<string, Workspace>();
  private counter = 0;

  createWorkspace(creatorSessionId: string, name: string | null): Workspace {
    this.counter += 1;
    const workspace: Workspace = {
      id: `ws_${this.counter}`, creatorSessionId, name, status: 'active',
      createdAt: '2026-11-03T00:00:00+00:00', updatedAt: '2026-11-03T00:00:00+00:00',
    };
    this.workspaces.set(workspace.id, workspace);
    this.taskManagers.set(workspace.id, new MemoryTaskManager());
    return workspace;
  }
  getWorkspace(workspaceId: string): Workspace | null {
    return this.workspaces.get(workspaceId) ?? null;
  }
  closeWorkspace(): void { throw new Error('not used'); }
  deleteWorkspace(): void { throw new Error('not used'); }
  registerAgent(
    workspaceId: string, sessionId: string, role: AgentRole, _skillId: string | null, metadata: JsonValue | null,
  ): WorkspaceAgent {
    const agent: WorkspaceAgent = {
      sessionId, workspaceId, role, skillId: null, status: 'idle',
      joinedAt: '2026-11-03T00:00:00+00:00', lastActiveAt: '2026-11-03T00:00:00+00:00',
      metadata,
    };
    this.agents.set(`${workspaceId}\u0000${sessionId}`, agent);
    return agent;
  }
  getAgent(workspaceId: string, sessionId: string): WorkspaceAgent | null {
    return this.agents.get(`${workspaceId}\u0000${sessionId}`) ?? null;
  }
  updateAgentStatus(workspaceId: string, sessionId: string, status: AgentStatus): void {
    const agent = this.getAgent(workspaceId, sessionId);
    if (agent === null) throw new Error(`Agent not found: ${sessionId}`);
    agent.status = status;
  }
  updateAgentMetadata(workspaceId: string, sessionId: string, metadata: JsonValue | null): void {
    const agent = this.getAgent(workspaceId, sessionId);
    if (agent === null) throw new Error(`Agent not found: ${sessionId}`);
    agent.metadata = metadata;
  }
  listAgents(workspaceId: string): WorkspaceAgent[] {
    return [...this.agents.values()].filter((agent) => agent.workspaceId === workspaceId);
  }
  pendingInboxCount(): number { return 0; }
  getTaskManager(workspaceId: string): MemoryTaskManager {
    const manager = this.taskManagers.get(workspaceId);
    if (manager === undefined) throw new Error(`Workspace not found: ${workspaceId}`);
    return manager;
  }
}

const cancelledStreams: string[] = [];

function setup(): { coordinator: MemoryCoordinator; workspaceId: string; deps: SuperSessionDeps } {
  const coordinator = new MemoryCoordinator();
  const workspace = coordinator.createWorkspace('sess_super', null);
  coordinator.registerAgent(workspace.id, 'sess_super', 'coordinator', null, null);
  const deps: SuperSessionDeps = {
    chat: {} as SuperSessionDeps['chat'],
    lookup: {} as SuperSessionDeps['lookup'],
    workspace: coordinator as unknown as SuperSessionDeps['workspace'],
    streams: {
      cancelStream(sessionId: string) { cancelledStreams.push(sessionId); return true; },
    } as SuperSessionDeps['streams'],
    settings: {} as SuperSessionDeps['settings'],
    events: { changed: () => {}, inboxChanged: () => {} },
    logger: { info: () => {}, warn: () => {} },
  };
  return { coordinator, workspaceId: workspace.id, deps };
}

describe('super_session_executor.rs close/list workers', () => {
  it('close_cancels_then_marks_closed_by_router', () => {
    const { coordinator, workspaceId, deps } = setup();
    const worker = 'subagent_explorer_close';
    coordinator.registerAgent(workspaceId, worker, 'worker', null,
      { super_agent: { title: '整理错题', dispatched_in_message_id: 'm1' } });
    coordinator.updateAgentStatus(workspaceId, worker, 'running');
    const taskManager = coordinator.getTaskManager(workspaceId);
    const task: SubagentTaskData = {
      id: 'task_close_1', workspaceId, agentSessionId: worker, skillId: null,
      initialTask: 'collect', status: 'pending', createdAt: '2026-11-03T00:00:00+00:00',
      startedAt: null, completedAt: null, resultSummary: null,
    };
    taskManager.createTask(task);
    taskManager.markRunning(task.id);

    const output = closeWorkerCore(deps, workspaceId, worker);
    expect(output.status).toBe('closed');
    expect(output.already_closed).toBe(false);
    expect(output.title).toBe('整理错题');

    expect(cancelledStreams).toContain(worker);
    expect(taskManager.getTask(task.id)!.status).toBe('cancelled');
    const agent = coordinator.getAgent(workspaceId, worker)!;
    expect(agent.status).toBe('closed');
    const meta = agent.metadata as Record<string, Record<string, unknown>>;
    expect(meta.super_agent!.closed_by_router).toBe(true);
    expect(meta.super_agent!.title).toBe('整理错题');
    expect(meta.super_agent!.dispatched_in_message_id).toBe('m1');
    expect(typeof meta.super_agent!.closed_at).toBe('string');

    const again = closeWorkerCore(deps, workspaceId, worker);
    expect(again.already_closed).toBe(true);
  });

  it('close_rejects_coordinator_and_unknown_agents', () => {
    const { workspaceId, deps } = setup();
    expect(() => closeWorkerCore(deps, workspaceId, 'sess_super'))
      .toThrow('Agent sess_super is not a worker');
    expect(() => closeWorkerCore(deps, workspaceId, 'missing'))
      .toThrow('Worker missing not found in the Super-agent workspace; use super_list_workers to see current workers');
  });

  it('list_summarizes_workers_with_latest_task', () => {
    const { coordinator, workspaceId } = setup();
    coordinator.registerAgent(workspaceId, 'subagent_explorer_a', 'worker', null,
      { super_agent: { title: 'A', dispatched_in_message_id: 'm1' } });
    coordinator.registerAgent(workspaceId, 'subagent_worker_b', 'worker', null, null);
    coordinator.getTaskManager(workspaceId).createTask({
      id: 'task_a_1', workspaceId, agentSessionId: 'subagent_explorer_a', skillId: null,
      initialTask: 'find notes', status: 'pending', createdAt: '2026-11-03T00:00:00+00:00',
      startedAt: null, completedAt: null, resultSummary: null,
    });

    const listed = listWorkersCore(coordinator, workspaceId);
    expect(listed.workspace_id).toBe(workspaceId);
    expect(listed.count).toBe(2);
    const workers = listed.workers as Array<Record<string, unknown>>;
    expect(workers.every((entry) => entry.worker_id !== 'sess_super')).toBe(true);
    const a = workers.find((entry) => entry.worker_id === 'subagent_explorer_a')!;
    expect(a.title).toBe('A');
    expect(a.dispatched_in_message_id).toBe('m1');
    expect(a.closed_by_router).toBe(false);
    expect(a.task_count).toBe(1);
    expect((a.latest_task as Record<string, unknown>).task_id).toBe('task_a_1');
    expect((a.latest_task as Record<string, unknown>).task).toBe('find notes');
    const b = workers.find((entry) => entry.worker_id === 'subagent_worker_b')!;
    expect(b.title).toBeNull();
    expect(b.latest_task).toBeNull();
  });

  it('tools_fail_closed_outside_super_session', () => {
    expect(() => requireSuperTurn(null)).toThrow(NOT_SUPER_SESSION_MESSAGE);
    expect(NOT_SUPER_SESSION_MESSAGE).toContain('Super-agent session');
    const turn = { workspaceId: 'ws_super' };
    expect(requireSuperTurn(turn)).toBe(turn);
  });

  it('lists the persisted custom profile and legacy skill profile actually used by workers', () => {
    const { coordinator, workspaceId } = setup();
    const custom = { ...AgentProfileResolver.resolve({ profileId: 'worker' }), id: 'research-assistant' };
    coordinator.registerAgent(workspaceId, 'custom', 'worker', null,
      AgentProfileResolver.persistIntoMetadata(undefined, custom));
    const legacy = coordinator.registerAgent(workspaceId, 'legacy', 'worker', null, null);
    legacy.skillId = 'explorer';

    const workers = listWorkersCore(coordinator, workspaceId).workers as Array<Record<string, unknown>>;
    expect(workers.find(worker => worker.worker_id === 'custom')?.profile_id).toBe('research-assistant');
    expect(workers.find(worker => worker.worker_id === 'legacy')?.profile_id).toBe('explorer');
  });
});
