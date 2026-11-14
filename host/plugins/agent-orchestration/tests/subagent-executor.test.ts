import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatExecutionContext, ChatWorkerRuntimeService } from '../../chat/api.ts';
import type { SubagentTaskData, WorkspaceCoordinator } from '../../agent-workspace/api.ts';
import { SubagentExecutor } from '../src/subagent-executor.ts';
import { SuperSessionExecutor } from '../src/super-session-executor.ts';
import { setAgentOrchestrationWorkspaceRuntime } from '../src/workspace-runtime.ts';
import { nodeAgentOrchestrationWorkspaceRuntime } from '../src/workspace-runtime.node.ts';

const log = { info: () => undefined, warn: () => undefined };
beforeEach(() => setAgentOrchestrationWorkspaceRuntime(nodeAgentOrchestrationWorkspaceRuntime));
afterEach(() => setAgentOrchestrationWorkspaceRuntime(null));
const workspace = { id: 'ws-1234567890', name: 'T', status: 'active', creatorSessionId: 'parent',
  createdAt: '2026-01-01T00:00:00+00:00', updatedAt: '2026-01-01T00:00:00+00:00' };

function fakeCoordinator(tasks: Map<string, SubagentTaskData>): WorkspaceCoordinator {
  return {
    getWorkspace: () => workspace, createWorkspace: () => workspace, customAgentsDir: () => '/nonexistent-agents',
    registerAgent: (workspaceId: string, sessionId: string, role: string) => ({ sessionId, workspaceId, role,
      skillId: null, status: 'idle', joinedAt: workspace.createdAt, lastActiveAt: workspace.createdAt }),
    getTaskManager: () => ({ createTask: (task: SubagentTaskData) => { tasks.set(task.id, task); },
      getTask: (id: string) => tasks.get(id) ?? null }),
    sendMessage: () => ({ id: 'msg-1' }), drainInbox: () => [], reEnqueueMessage: () => undefined,
  } as unknown as WorkspaceCoordinator;
}

function context(signal: AbortSignal, chunks: string[] = []): ChatExecutionContext {
  return {
    session_id: 'parent', message_id: 'm1', block_id: 'blk', chat_v2_db: {}, skill_contents: null, llm_manager: null,
    cancellation_token: signal, isCancelled: () => signal.aborted, windowRef: () => ({ window: 'main', webview: 'main' }),
    tryWindow: () => ({ window: 'main', webview: 'main' }),
    services: { backendEvents: { emit: () => undefined } },
    emitter: { emitChunk: (_type: string, _block: string, chunk: string) => { chunks.push(chunk); } },
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined, emitToolCallError: () => undefined,
    saveToolBlock: () => undefined,
  } as unknown as ChatExecutionContext;
}

function runtime(cancelled: string[]): ChatWorkerRuntimeService {
  return {
    isRunAvailable: () => true,
    sessionStore: { sessionMetadata: () => null, createSession: () => undefined },
    runWorkspaceAgentBackend: async () => ({ agent_session_id: 'x', message_id: 'run-1', status: 'running' }),
    cancelWorkspaceAgentBackend: async (_workspaceId: string, agentSessionId: string) => { cancelled.push(agentSessionId); },
  } as unknown as ChatWorkerRuntimeService;
}

describe('SubagentExecutor / SuperSessionExecutor executor contract', () => {
  it('match the Rust roster names, accept builtin- names and carry Rust sensitivity (subagent_executor.rs:1063, super_session_executor.rs:524)', () => {
    const subagent = new SubagentExecutor({ coordinator: fakeCoordinator(new Map()), workerRuntime: () => undefined,
      chatSession: () => undefined, log });
    expect(subagent.name()).toBe('SubagentExecutor');
    expect(subagent.canHandle('builtin-subagent_call')).toBe(true);
    expect(subagent.canHandle('subagent_call')).toBe(true);
    expect(subagent.sensitivityLevel('builtin-subagent_call')).toBe('medium');
    expect(subagent.managesCancellation('builtin-subagent_call')).toBe(true);
    const sup = new SuperSessionExecutor({ coordinator: fakeCoordinator(new Map()), subagent,
      superDeps: () => { throw new Error('unused'); }, workerRuntime: () => undefined, log });
    expect(sup.name()).toBe('SuperSessionExecutor');
    for (const name of ['super_dispatch_worker', 'super_message_worker', 'super_close_worker', 'super_list_workers']) {
      expect(sup.canHandle(`builtin-${name}`)).toBe(true);
    }
    expect(['super_dispatch_worker', 'super_message_worker', 'super_close_worker', 'super_list_workers']
      .map(name => [sup.sensitivityLevel(`builtin-${name}`), sup.managesCancellation(`builtin-${name}`)]))
      .toEqual([['medium', true], ['medium', true], ['low', false], ['low', false]]);
  });

  it('parent cancellation during the blocking wait stops the child pipeline first (contract C5)', async () => {
    const tasks = new Map<string, SubagentTaskData>();
    const cancelled: string[] = [];
    const chunks: string[] = [];
    const controller = new AbortController();
    const executor = new SubagentExecutor({ coordinator: fakeCoordinator(tasks), workerRuntime: () => runtime(cancelled),
      chatSession: () => undefined, log, timing: { pollIntervalMs: 5, waitBudgetMs: 60_000, settleGraceMs: 10 } });
    const running = executor.execute({ id: 'c1', name: 'builtin-subagent_call', arguments: { task: 'x' } }, context(controller.signal, chunks));
    await expect.poll(() => chunks.length).toBe(1);
    controller.abort();
    const result = await running;
    expect(result).toMatchObject({ success: false, error: 'Subagent call cancelled' });
    expect(cancelled).toEqual([expect.stringMatching(/^subagent_worker_/)]);
    expect(JSON.parse(chunks[0]!)).toMatchObject({ phase: 'dispatched', run_id: 'run-1', status: 'running' });
    expect(executor.background('parent', 'blk')).toBe(false);
  });

  it('releases the exact parent wait immediately without cancelling, restarting or consuming completion', async () => {
    const tasks = new Map<string, SubagentTaskData>();
    const cancelled: string[] = [];
    const chunks: string[] = [];
    const controller = new AbortController();
    const coordinator = fakeCoordinator(tasks);
    coordinator.drainInbox = vi.fn(() => []);
    const worker = runtime(cancelled);
    worker.runWorkspaceAgentBackend = vi.fn(worker.runWorkspaceAgentBackend);
    const executor = new SubagentExecutor({ coordinator, workerRuntime: () => worker,
      chatSession: () => undefined, log, timing: { pollIntervalMs: 60_000, waitBudgetMs: 120_000, settleGraceMs: 10 } });
    const ctx = context(controller.signal, chunks);
    ctx.saveToolBlock = vi.fn();
    const running = executor.execute({ id: 'c1', name: 'builtin-subagent_call', arguments: { task: 'x', wait: true } }, ctx);
    await expect.poll(() => chunks.length).toBe(1);
    expect(JSON.parse(chunks[0]!)).toMatchObject({ can_background: true });
    expect(executor.background('another-parent', 'blk')).toBe(false);
    expect(executor.background('parent', 'another-block')).toBe(false);
    expect(executor.background('parent', 'blk')).toBe(true);
    expect(executor.background('parent', 'blk')).toBe(true);
    const result = await running;
    expect(result).toMatchObject({ success: true, input: { wait: true }, output: {
      status: 'running', backgrounded: true, workspace_id: workspace.id, run_id: 'run-1', task_message_id: 'msg-1',
      agent_session_id: expect.stringMatching(/^subagent_worker_/), resumed: false,
    } });
    expect((result.output as Record<string, unknown>).message).toContain('Do not call coordinator_sleep');
    controller.abort();
    expect(cancelled).toEqual([]);
    expect(worker.runWorkspaceAgentBackend).toHaveBeenCalledTimes(1);
    expect(coordinator.drainInbox).not.toHaveBeenCalled();
    expect(ctx.saveToolBlock).toHaveBeenCalledTimes(1);
    expect([...tasks.values()]).toHaveLength(1);
    expect(executor.background('parent', 'blk')).toBe(false);
  });

  it('preserves async completion when completion and the background request arrive together', async () => {
    const tasks = new Map<string, SubagentTaskData>();
    const chunks: string[] = [];
    const coordinator = fakeCoordinator(tasks);
    coordinator.drainInbox = vi.fn(() => []);
    const executor = new SubagentExecutor({ coordinator, workerRuntime: () => runtime([]),
      chatSession: () => undefined, log, timing: { pollIntervalMs: 60_000, waitBudgetMs: 120_000, settleGraceMs: 10 } });
    const running = executor.execute({ id: 'c1', name: 'subagent_call', arguments: { task: 'x' } },
      context(new AbortController().signal, chunks));
    await expect.poll(() => chunks.length).toBe(1);
    for (const task of tasks.values()) { task.status = 'completed'; task.resultSummary = 'done'; }
    expect(executor.background('parent', 'blk')).toBe(true);
    expect(await running).toMatchObject({ success: true, output: { status: 'running', backgrounded: true } });
    expect(coordinator.drainInbox).not.toHaveBeenCalled();
  });

  it('also backgrounds a resumed subagent without creating a new worker', async () => {
    const chunks: string[] = [];
    const cancelled: string[] = [];
    const coordinator = fakeCoordinator(new Map());
    coordinator.getAgent = () => ({ role: 'worker', sessionId: 'existing-worker' }) as ReturnType<WorkspaceCoordinator['getAgent']>;
    coordinator.registerAgent = vi.fn(coordinator.registerAgent);
    const executor = new SubagentExecutor({ coordinator, workerRuntime: () => runtime(cancelled),
      chatSession: () => ({ getSession: () => ({ id: 'existing-worker' }) } as never), log,
      timing: { pollIntervalMs: 60_000, waitBudgetMs: 120_000, settleGraceMs: 10 } });
    const running = executor.execute({ id: 'c1', name: 'subagent_call', arguments: {
      task: 'follow up', workspace_id: workspace.id, resume_agent_session_id: 'existing-worker',
    } }, context(new AbortController().signal, chunks));
    await expect.poll(() => chunks.length).toBe(1);
    expect(executor.background('parent', 'blk')).toBe(true);
    expect(await running).toMatchObject({ success: true, output: {
      agent_session_id: 'existing-worker', resumed: true, backgrounded: true, status: 'running',
    } });
    expect(coordinator.registerAgent).not.toHaveBeenCalled();
    expect(cancelled).toEqual([]);
  });

  it('does not release another blocking call in the same parent session', async () => {
    const chunks: string[] = [];
    const executor = new SubagentExecutor({ coordinator: fakeCoordinator(new Map()), workerRuntime: () => runtime([]),
      chatSession: () => undefined, log, timing: { pollIntervalMs: 60_000, waitBudgetMs: 120_000, settleGraceMs: 10 } });
    const first = executor.execute({ id: 'c1', name: 'subagent_call', arguments: { task: 'first' } },
      context(new AbortController().signal, chunks));
    const secondCtx = context(new AbortController().signal, chunks);
    secondCtx.block_id = 'blk-second';
    const second = executor.execute({ id: 'c2', name: 'subagent_call', arguments: { task: 'second' } }, secondCtx);
    await expect.poll(() => chunks.length).toBe(2);
    expect(executor.background('parent', 'blk')).toBe(true);
    await first;
    expect(executor.background('parent', 'blk-second')).toBe(true);
    expect(await second).toMatchObject({ success: true, output: { backgrounded: true } });
  });

  it('does not register a foreground wait for wait=false dispatches', async () => {
    const executor = new SubagentExecutor({ coordinator: fakeCoordinator(new Map()), workerRuntime: () => runtime([]),
      chatSession: () => undefined, log });
    const chunks: string[] = [];
    expect(await executor.execute({ id: 'c1', name: 'subagent_call', arguments: { task: 'x', wait: false } },
      context(new AbortController().signal, chunks))).toMatchObject({ success: true, output: { status: 'running' } });
    expect(chunks).toEqual([]);
    expect(executor.background('parent', 'blk')).toBe(false);
  });

  it('keeps synchronous completion delivery and removes the wait after a terminal result', async () => {
    const tasks = new Map<string, SubagentTaskData>();
    const coordinator = fakeCoordinator(tasks);
    coordinator.drainInbox = vi.fn(() => []);
    const createTask = coordinator.getTaskManager(workspace.id).createTask;
    coordinator.getTaskManager = () => ({
      createTask: (task: SubagentTaskData) => createTask({ ...task, status: 'completed', resultSummary: 'done' }),
      getTask: (id: string) => tasks.get(id) ?? null,
    }) as ReturnType<WorkspaceCoordinator['getTaskManager']>;
    const executor = new SubagentExecutor({ coordinator, workerRuntime: () => runtime([]),
      chatSession: () => undefined, log });
    const result = await executor.execute({ id: 'c1', name: 'subagent_call', arguments: { task: 'x' } },
      context(new AbortController().signal));
    expect(result).toMatchObject({ success: true, output: { status: 'completed', output: 'done' } });
    expect(result.output).not.toHaveProperty('backgrounded');
    expect(coordinator.drainInbox).toHaveBeenCalledTimes(1);
    expect(executor.background('parent', 'blk')).toBe(false);
  });

  it('returns running with a hint when the wait budget is exhausted', async () => {
    const executor = new SubagentExecutor({ coordinator: fakeCoordinator(new Map()), workerRuntime: () => runtime([]),
      chatSession: () => undefined, log, timing: { pollIntervalMs: 5, waitBudgetMs: 20, settleGraceMs: 10 } });
    const result = await executor.execute({ id: 'c1', name: 'subagent_call', arguments: { task: 'x' } }, context(new AbortController().signal));
    expect(result).toMatchObject({ success: true, output: { status: 'running', run_id: 'run-1', auto_created_workspace: true,
      message: 'Subagent is still running; use coordinator_sleep or wait for the automatic completion wakeup.' } });
    expect(executor.background('parent', 'blk')).toBe(false);
  });

  it('rejects profile/skill/model overrides on resume and resume without workspace_id', async () => {
    const executor = new SubagentExecutor({ coordinator: fakeCoordinator(new Map()), workerRuntime: () => runtime([]),
      chatSession: () => undefined, log });
    const ctx = context(new AbortController().signal);
    expect(await executor.execute({ id: 'c1', name: 'subagent_call', arguments: { task: 'x', resume_agent_session_id: 'a', model: 'm', profile: 'p' } }, ctx))
      .toMatchObject({ success: false, error: 'resume_agent_session_id reuses the persisted agent profile; [profile, model] cannot be overridden during resume. Omit these fields or create a new subagent.' });
    expect(await executor.execute({ id: 'c2', name: 'subagent_call', arguments: { task: 'x', resume_agent_session_id: 'a' } }, ctx))
      .toMatchObject({ success: false, error: 'resume_agent_session_id requires workspace_id (it is included in the original subagent_call return value)' });
  });
});
