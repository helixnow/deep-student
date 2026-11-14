import { expect, it } from 'vitest';
import type { ChatWorkerRuntimeService, ExecutionContext } from '../../chat/api.ts';
import type { WorkspaceCoordinator } from '../src/workspace/coordinator.ts';
import { WorkspaceToolContribution } from '../src/tools/workspace-tool-contribution.ts';

const workspace = { id: 'ws-123456789', name: 'Team', status: 'active', creatorSessionId: 'sess-1',
  createdAt: '2026-01-01T00:00:00+00:00', updatedAt: '2026-01-01T00:00:00+00:00' };
const coordinator = {
  ensureMemberOrCreator: () => undefined, getWorkspace: () => workspace,
  registerAgent: (workspaceId: string, sessionId: string, role: string) => ({ sessionId, workspaceId, role, skillId: null,
    status: 'idle', joinedAt: workspace.createdAt, lastActiveAt: workspace.createdAt }),
  sendMessage: () => ({ id: 'm1' }), getTaskManager: () => ({ createTask: () => undefined }), listAgents: () => [],
} as unknown as WorkspaceCoordinator;

function context(saved: unknown[]): ExecutionContext {
  return {
    session_id: 'sess-1', block_id: 'blk-1', chat_v2_db: {} as ExecutionContext['chat_v2_db'], skill_contents: null,
    services: { logger: { warn: () => undefined, info: () => undefined }, backendEvents: { emit: () => undefined } },
    windowRef: () => ({ window: 'main', webview: 'main' }),
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined, emitToolCallError: () => undefined,
    saveToolBlock: (result: unknown) => { saved.push(result); },
  } as unknown as ExecutionContext;
}

const sessionStore = { sessionMetadata: () => null, createSession: () => undefined };

it('matches the Rust roster name, accepts builtin- names and is low sensitivity (workspace_executor.rs:822)', () => {
  const executor = new WorkspaceToolContribution(coordinator, () => undefined);
  expect(executor.name()).toBe('WorkspaceToolExecutor');
  expect(executor.canHandle('builtin-workspace_create_agent')).toBe(true);
  expect(executor.canHandle('workspace_query')).toBe(true);
  expect(executor.canHandle('builtin-workspace_list')).toBe(false);
  expect(executor.sensitivityLevel('builtin-workspace_send')).toBe('low');
});

it('fails closed with the Rust error when the chat worker runtime is absent or not bound', async () => {
  const args = { workspace_id: workspace.id, initial_task: 'do it' };
  const call = { id: 'c1', name: 'builtin-workspace_create_agent', arguments: args };
  const saved: unknown[] = [];
  const absent = await new WorkspaceToolContribution(coordinator, () => undefined).execute(call, context(saved));
  // Without chatWorkerRuntime there is no session store either (Rust `ctx.chat_v2_db` None).
  expect(absent).toMatchObject({ success: false, error: 'chat_v2_db not available for creating agent session' });
  const unbound = { isRunAvailable: () => false, sessionStore,
    runWorkspaceAgentBackend: async () => { throw new Error('unreachable'); } } as unknown as ChatWorkerRuntimeService;
  const result = await new WorkspaceToolContribution(coordinator, () => unbound).execute(call, context(saved));
  expect(result).toMatchObject({ success: false, error: 'ChatV2Pipeline not available for worker runtime' });
  expect(saved).toHaveLength(2);
});

it('dispatches through chatWorkerRuntime with the turn window and the requester session', async () => {
  const runs: unknown[] = [];
  const runtime = { isRunAvailable: () => true, sessionStore, cancelWorkspaceAgentBackend: async () => undefined,
    runWorkspaceAgentBackend: async (request: unknown, window: unknown) => { runs.push([request, window]);
      return { agent_session_id: 'x', message_id: 'run-1', status: 'running' }; } } as unknown as ChatWorkerRuntimeService;
  const result = await new WorkspaceToolContribution(coordinator, () => runtime).execute(
    { id: 'c1', name: 'builtin-workspace_create_agent', arguments: { workspace_id: workspace.id, initial_task: 'do it' } }, context([]));
  expect(result).toMatchObject({ success: true, output: { status: 'dispatched', run_id: 'run-1' } });
  expect(runs).toEqual([[{ workspace_id: workspace.id, agent_session_id: expect.stringMatching(/^agent_worker_/),
    requester_session_id: 'sess-1', reminder: null }, { window: 'main', webview: 'main' }]]);
});
