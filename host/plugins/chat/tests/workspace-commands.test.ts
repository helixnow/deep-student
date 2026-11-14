import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { AgentProfileResolver } from '../../agent-workspace/api.ts';
import type { WorkspaceCoordinator, WorkspaceAgent, WorkspaceMessage, WorkspaceContext, WorkspaceDocument } from '../../agent-workspace/api.ts';

// L05 service double; all mapping, error policy and commands under test are L04 production code.
function coordinatorFixture() {
  const calls: unknown[][] = [];
  const timestamp = '2026-01-02T03:04:05.123400Z';
  const agents: WorkspaceAgent[] = [];
  const messages: WorkspaceMessage[] = [];
  const contexts = new Map<string, WorkspaceContext>();
  const documents: WorkspaceDocument[] = [];
  const service = {
    createWorkspace(sessionId: string, name: string | null) {
      calls.push(['create', sessionId, name]);
      return { id: 'ws_1', name, status: 'active' as const, creatorSessionId: sessionId,
        createdAt: timestamp, updatedAt: timestamp };
    },
    ensureMemberOrCreator(workspaceId: string, sessionId: string) {
      calls.push(['authorize', workspaceId, sessionId]);
      if (sessionId === 'outsider') throw new Error('Permission denied: workspace access');
    },
    getWorkspace(id: string) {
      calls.push(['get', id]);
      return id === 'missing' ? null : { id, name: null, status: 'active' as const,
        creatorSessionId: 'sess_owner', createdAt: timestamp, updatedAt: timestamp };
    },
    listAgents: () => agents,
    pendingInboxCount(_workspaceId: string, sessionId: string) {
      if (sessionId === 'agent_broken') throw new Error('inbox read failure');
      return 3;
    },
    sendMessage(workspaceId: string, senderId: string, targetId: string | null,
      type: WorkspaceMessage['messageType'], content: string) {
      calls.push(['send', workspaceId, senderId, targetId, type, content]);
      const message: WorkspaceMessage = { id: 'message_1', workspaceId, senderSessionId: senderId,
        targetSessionId: targetId, messageType: type, content, status: 'pending', createdAt: timestamp };
      messages.push(message);
      return message;
    },
    listMessages(workspaceId: string, limit: number) {
      calls.push(['messages', workspaceId, limit]);
      return messages.slice(0, limit);
    },
    setContext(workspaceId: string, key: string, value: WorkspaceContext['value'], updatedBy: string) {
      contexts.set(key, { workspaceId, key, value, updatedBy, updatedAt: timestamp });
    },
    getContext: (_id: string, key: string) => contexts.get(key) ?? null,
    listDocuments: () => documents,
    getDocument: (_id: string, id: string) => documents.find(doc => doc.id === id) ?? null,
    isMemberOrCreatorSession(id: string) {
      if (id === 'ws_error') throw new Error('membership read failure');
      return id !== 'ws_hidden';
    },
  } satisfies Pick<WorkspaceCoordinator, 'createWorkspace' | 'ensureMemberOrCreator' | 'getWorkspace'
    | 'listAgents' | 'pendingInboxCount' | 'sendMessage' | 'listMessages' | 'setContext' | 'getContext'
    | 'listDocuments' | 'getDocument' | 'isMemberOrCreatorSession'>;
  return { service, calls, timestamp, agents, messages, contexts, documents };
}

describe('workspace_handlers coordinator command wire semantics', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let coordinator: ReturnType<typeof coordinatorFixture>;
  beforeEach(async () => {
    f = databaseFixture();
    coordinator = coordinatorFixture();
    host = await createTestHost({ plugins: [plugin], provide: {
      storage: f.storage, vfs: vfsStub, agentWorkspace: coordinator.service,
    } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  it('workspace_create/get preserve snake_case, null and authorization ordering', async () => {
    expect(await host.invoke('workspace_create', { sessionId: 'any-id', request: {} }))
      .toEqual({ workspace_id: 'ws_1', name: null, status: 'active' });
    expect(coordinator.calls).toEqual([['create', 'any-id', null]]);
    expect(await host.invoke('workspace_get', { sessionId: 'sess_owner', workspaceId: 'ws_1' }))
      .toEqual({ id: 'ws_1', name: null, status: 'active', creator_session_id: 'sess_owner',
        created_at: '2026-01-02T03:04:05.123400+00:00', updated_at: '2026-01-02T03:04:05.123400+00:00' });
    expect(coordinator.calls.slice(1)).toEqual([['authorize', 'ws_1', 'sess_owner'], ['get', 'ws_1']]);
    await expect(host.invoke('workspace_get', { sessionId: 'outsider', workspaceId: 'ws_1' }))
      .rejects.toBe('Permission denied: workspace access');
    expect(coordinator.calls.at(-1)).toEqual(['authorize', 'ws_1', 'outsider']);
    expect(await host.invoke('workspace_get', { sessionId: 'sess_owner', workspaceId: 'missing' })).toBeNull();
  });

  it('workspace_list_agents uses the published profile validator and tolerates inbox failure', async () => {
    coordinator.agents.push({ sessionId: 'agent_ok', workspaceId: 'ws_1', role: 'worker',
      skillId: null, status: 'idle', joinedAt: coordinator.timestamp, lastActiveAt: coordinator.timestamp,
      metadata: { agent_profile: AgentProfileResolver.builtIn('default')! as unknown as WorkspaceContext['value'] } },
    { sessionId: 'agent_broken', workspaceId: 'ws_1', role: 'worker', skillId: 'skill_x', status: 'running',
      joinedAt: coordinator.timestamp, lastActiveAt: coordinator.timestamp, metadata: { agent_profile: { id: 'invalid-only-id' } } });
    expect(await host.invoke('workspace_list_agents', { sessionId: 'sess_owner', workspaceId: 'ws_1' }))
      .toEqual([
        { session_id: 'agent_ok', role: 'worker', status: 'idle', skill_id: null, agent_profile_id: 'default',
          pending_inbox_count: 3, joined_at: '2026-01-02T03:04:05.123400+00:00', last_active_at: '2026-01-02T03:04:05.123400+00:00' },
        { session_id: 'agent_broken', role: 'worker', status: 'running', skill_id: 'skill_x', agent_profile_id: null,
          pending_inbox_count: 0, joined_at: '2026-01-02T03:04:05.123400+00:00', last_active_at: '2026-01-02T03:04:05.123400+00:00' },
      ]);
  });

  it('workspace_send_message validates broadcast before delivery and preserves task fallback', async () => {
    await expect(host.invoke('workspace_send_message', { sessionId: 's', request: {
      workspace_id: 'ws_1', target_session_id: '', message_type: 'broadcast', content: 'hi',
    } })).rejects.toBe('Broadcast message must not specify target_session_id');
    expect(coordinator.calls).toEqual([]);
    for (const type of ['progress', 'result', 'query', 'correction', 'broadcast', 'unknown']) {
      expect(await host.invoke('workspace_send_message', { sessionId: 's', request: {
        workspace_id: 'ws_1', message_type: type, content: type,
      } })).toEqual({ message_id: 'message_1', is_broadcast: true });
      expect(coordinator.calls.at(-1)).toEqual(['send', 'ws_1', 's', null, type === 'unknown' ? 'task' : type, type]);
    }
    expect(await host.invoke('workspace_send_message', { sessionId: 's', request: {
      workspace_id: 'ws_1', target_session_id: 'agent_1', content: 'task',
    } })).toEqual({ message_id: 'message_1', is_broadcast: false });
    const messages = await host.invoke<unknown[]>('workspace_list_messages', { sessionId: 's', workspaceId: 'ws_1' });
    expect(messages).toHaveLength(7);
    expect(messages[0]).toEqual({ id: 'message_1', sender_session_id: 's', target_session_id: null,
      message_type: 'progress', content: 'progress', status: 'pending', created_at: '2026-01-02T03:04:05.123400+00:00' });
    expect(coordinator.calls.at(-1)).toEqual(['messages', 'ws_1', 50]);
    expect(await host.invoke('workspace_list_messages', { sessionId: 's', workspaceId: 'ws_1', limit: 0 })).toEqual([]);
    expect(coordinator.calls.at(-1)).toEqual(['messages', 'ws_1', 0]);
  });

  it('workspace context and document reads preserve JSON values and return only content', async () => {
    expect(await host.invoke('workspace_set_context', { sessionId: 's', workspaceId: 'ws_1', key: 'k', value: false })).toBeNull();
    expect(coordinator.contexts.get('k')?.updatedBy).toBe('s');
    expect(await host.invoke('workspace_get_context', { sessionId: 's', workspaceId: 'ws_1', key: 'k' })).toBe(false);
    expect(await host.invoke('workspace_get_context', { sessionId: 's', workspaceId: 'ws_1', key: 'missing' })).toBeNull();
    coordinator.documents.push({ id: 'doc_1', workspaceId: 'ws_1', docType: 'research', title: 'Title',
      content: 'body', version: 2, updatedBy: 's', updatedAt: coordinator.timestamp });
    expect(await host.invoke('workspace_list_documents', { sessionId: 's', workspaceId: 'ws_1' })).toEqual([
      { id: 'doc_1', doc_type: 'research', title: 'Title', version: 2, updated_by: 's', updated_at: '2026-01-02T03:04:05.123400+00:00' },
    ]);
    expect(await host.invoke('workspace_get_document', { sessionId: 's', workspaceId: 'ws_1', documentId: 'doc_1' })).toBe('body');
    expect(await host.invoke('workspace_get_document', { sessionId: 's', workspaceId: 'ws_1', documentId: 'missing' })).toBeNull();
  });

  it('workspace_list_all skips membership failures with a warning and preserves DB timestamps', async () => {
    for (const [id, date] of [['ws_old', '2026-01-01'], ['ws_error', '2026-01-03'], ['ws_new', '2026-01-04'], ['ws_hidden', '2026-01-02']]) {
      f.db.run('INSERT INTO workspace_index (workspace_id, name, status, creator_session_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?)',
        [id!, 'active', 's', date!, date!]);
    }
    const logs: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 3 },
      export(message) { if (message.type === 'warn') logs.push(String(message.args[0])); } });
    expect(await host.invoke('workspace_list_all', { sessionId: 's' })).toEqual([
      { id: 'ws_new', name: null, status: 'active', creator_session_id: 's', created_at: '2026-01-04', updated_at: '2026-01-04' },
      { id: 'ws_old', name: null, status: 'active', creator_session_id: 's', created_at: '2026-01-01', updated_at: '2026-01-01' },
    ]);
    expect(logs).toContain('[Workspace::handlers] Failed to check workspace membership: workspace_id=ws_error, error=membership read failure');
  });
});
