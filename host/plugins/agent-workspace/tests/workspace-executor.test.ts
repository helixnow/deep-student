import { expect, it } from 'vitest';
import type { WorkspaceCoordinator } from '../src/workspace/coordinator.ts';
import type { WorkspaceAgent, WorkspaceMessage } from '../api.ts';
import {
  WorkspaceToolExecutor, getWorkspaceToolSchemas, toolNames,
  type WorkspaceExecutorContext,
} from '../src/tools/workspace-executor.ts';

function agent(overrides: Partial<WorkspaceAgent> = {}): WorkspaceAgent {
  return {
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    role: 'coordinator',
    skillId: null,
    status: 'idle',
    joinedAt: '2026-01-01T00:00:00+00:00',
    lastActiveAt: '2026-01-01T00:00:00+00:00',
    ...overrides,
  };
}

function message(overrides: Partial<WorkspaceMessage> = {}): WorkspaceMessage {
  return {
    id: 'msg-1',
    workspaceId: 'ws-1',
    senderSessionId: 'sess-1',
    targetSessionId: null,
    messageType: 'task',
    content: 'hello',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00+00:00',
    ...overrides,
  };
}

function fakeCoordinator(overrides: Record<string, unknown> = {}): WorkspaceCoordinator {
  const coordinator = {
    createWorkspace: () => ({
      id: 'ws-123456789',
      name: 'Team',
      status: 'active',
      creatorSessionId: 'sess-1',
      createdAt: '2026-01-01T00:00:00+00:00',
      updatedAt: '2026-01-01T00:00:00+00:00',
    }),
    registerAgent: () => agent(),
    getWorkspace: () => ({
      id: 'ws-123456789',
      name: 'Team',
      status: 'active',
      creatorSessionId: 'sess-1',
      createdAt: '2026-01-01T00:00:00+00:00',
      updatedAt: '2026-01-01T00:00:00+00:00',
    }),
    ensureMemberOrCreator: () => undefined,
    sendMessage: () => message(),
    listAgents: () => [agent()],
    listMessages: () => [message()],
    listDocuments: () => [],
    listContext: () => [],
    getContext: () => null,
    setContext: () => undefined,
    saveDocument: () => undefined,
    getDocument: () => null,
    getTaskManager: () => ({ listRecentTasks: () => [] }),
    ...overrides,
  };
  return coordinator as unknown as WorkspaceCoordinator;
}

function context(overrides: Partial<WorkspaceExecutorContext> = {}): WorkspaceExecutorContext {
  return {
    sessionId: 'sess-1',
    chatV2Db: {
      sessionMetadata: () => null,
      createSession: () => undefined,
    },
    skillContents: null,
    now: () => '2026-01-01T00:00:00+00:00',
    ...overrides,
  };
}

it('workspace_tool_schemas_match_rust_names_and_required_fields', () => {
  const schemas = getWorkspaceToolSchemas() as Array<Record<string, unknown>>;
  expect(schemas.map(schema => schema.name)).toEqual([
    toolNames.CREATE,
    toolNames.CREATE_AGENT,
    toolNames.SEND,
    toolNames.QUERY,
    toolNames.SET_CONTEXT,
    toolNames.GET_CONTEXT,
    toolNames.UPDATE_DOCUMENT,
    toolNames.READ_DOCUMENT,
  ]);
  const byName = new Map(schemas.map(schema => [schema.name as string, schema]));
  const inputSchema = (name: string) => byName.get(name)!['input_schema'] as Record<string, unknown>;
  expect(inputSchema(toolNames.CREATE_AGENT)['required']).toEqual(['workspace_id', 'agent_session_id']);
  expect(inputSchema(toolNames.SEND)['required']).toEqual(['workspace_id', 'content']);
  expect(inputSchema(toolNames.QUERY)['required']).toEqual(['workspace_id']);
  expect(inputSchema(toolNames.SET_CONTEXT)['required']).toEqual(['workspace_id', 'key', 'value']);
  expect(inputSchema(toolNames.GET_CONTEXT)['required']).toEqual(['workspace_id', 'key']);
  expect(inputSchema(toolNames.UPDATE_DOCUMENT)['required']).toEqual(['workspace_id', 'title', 'content']);
  expect(inputSchema(toolNames.READ_DOCUMENT)['required']).toEqual(['workspace_id', 'document_id']);
});

it('can_handle_accepts_namespaced_and_historical_double_prefix_forms', () => {
  const executor = new WorkspaceToolExecutor(fakeCoordinator(), context());
  for (const name of Object.values(toolNames)) {
    expect(executor.canHandle(name)).toBe(true);
    expect(executor.canHandle(`builtin-${name}`)).toBe(true);
    expect(executor.canHandle(`workspace_${name}`)).toBe(true);
  }
  expect(executor.canHandle('workspace_file_read')).toBe(false);
  expect(executor.sensitivityLevel(toolNames.CREATE)).toBe('low');
  expect(executor.name()).toBe('WorkspaceToolExecutor');
});

it('execute_create_returns_workspace_snapshot', async () => {
  const executor = new WorkspaceToolExecutor(fakeCoordinator(), context());
  const result = await executor.executeCreate({ name: 'Team' });
  expect(result).toEqual({
    workspace_id: 'ws-123456789',
    status: 'created',
    message: 'Workspace created successfully. You are registered as the coordinator.',
    snapshotAgents: [{
      session_id: 'sess-1',
      role: 'coordinator',
      status: 'idle',
      skill_id: null,
    }],
    snapshotName: 'Team',
    snapshotCreatedAt: '2026-01-01T00:00:00+00:00',
  });
});

it('execute_send_rejects_broadcast_with_target_and_returns_broadcast_flag', async () => {
  const executor = new WorkspaceToolExecutor(fakeCoordinator(), context());
  await expect(executor.executeSend({
    workspace_id: 'ws-1',
    content: 'hi',
    target_session_id: 'sess-2',
    message_type: 'broadcast',
  })).rejects.toThrow('Broadcast message must not specify target_session_id');
  const result = await executor.executeSend({ workspace_id: 'ws-1', content: 'hi' });
  expect(result).toEqual({ message_id: 'msg-1', status: 'sent', is_broadcast: true });
});

it('execute_query_rejects_unknown_type_and_queries_agents', async () => {
  const executor = new WorkspaceToolExecutor(fakeCoordinator(), context());
  await expect(executor.executeQuery({ workspace_id: 'ws-1', query_type: 'unknown' }))
    .rejects.toThrow('Unknown query_type: unknown');
  expect(await executor.executeQuery({ workspace_id: 'ws-1' })).toEqual({
    agents: [{ session_id: 'sess-1', role: 'coordinator', status: 'idle', skill_id: null }],
  });
});

it('execute_get_context_returns_not_found_shape', async () => {
  const executor = new WorkspaceToolExecutor(fakeCoordinator(), context());
  expect(await executor.executeGetContext({ workspace_id: 'ws-1', key: 'k' }))
    .toEqual({ key: 'k', value: null, found: false });
});

it('execute_create_agent_fails_closed_without_chat_session_store', async () => {
  const executor = new WorkspaceToolExecutor(fakeCoordinator(), context({ chatV2Db: null }));
  await expect(executor.executeCreateAgent({ workspace_id: 'ws-1', initial_task: 'do it' }))
    .rejects.toThrow('chat_v2_db not available for creating agent session');
});

it('execute_records_failure_result_and_ignores_save_errors', async () => {
  const saves: unknown[] = [];
  const executor = new WorkspaceToolExecutor(fakeCoordinator(), context({
    saveToolBlock: result => {
      saves.push(result);
      throw new Error('save failed');
    },
  }));
  const result = await executor.execute({
    id: 'call-1', name: 'builtin-workspace_query', arguments: { workspace_id: 'ws-1', query_type: 'unknown' },
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain('Unknown query_type');
  expect(saves).toHaveLength(1);
});
