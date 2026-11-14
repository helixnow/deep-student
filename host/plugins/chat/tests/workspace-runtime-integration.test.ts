import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import workspace from '../../agent-workspace/index.ts';
import backup from '../../backup/index.ts';
import { newSession } from '../src/types.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';

it('workspace cancellation commands use the real L05 runtime managers and event payloads', async () => {
  const f = databaseFixture();
  const host = await createTestHost({ plugins: [workspace, plugin, backup], provide: {
    storage: f.storage, vfs: vfsStub, settings: {}, secrets: {},
  } });
  try {
    const created = await host.invoke<{ workspace_id: string }>('workspace_create', { sessionId: 'owner', request: {} });
    const id = created.workspace_id;
    host.ctx.agentWorkspace.registerAgent(id, 'worker', 'worker', null, null);
    const token = host.ctx.chatState.registerStream('worker');
    expect(await host.invoke('workspace_cancel_agent', { sessionId: 'owner', workspaceId: id, agentSessionId: 'worker' })).toBe(true);
    expect(token.signal.aborted).toBe(true);
    expect(host.ctx.agentWorkspace.getAgent(id, 'worker')?.status).toBe('cancelled');
    const warnings = host.events.filter(event => event.event === 'workspace_warning').map(event => event.payload);
    expect(warnings).toContainEqual({ workspace_id: id, code: 'agent_cancelled',
      message: 'Agent worker execution cancelled by user', agent_session_id: 'worker',
      message_id: null, retry_count: null, max_retries: null });
    expect(await host.invoke('workspace_cancel_sleep', { sessionId: 'owner', workspaceId: id, sleepId: 'missing' })).toBe(false);
    expect(await host.invoke('workspace_manual_wake', { request: { workspace_id: id, requester_session_id: 'owner', sleep_id: 'missing' } }))
      .toEqual({ success: false, sleep_id: 'missing' });
    expect(await host.invoke('workspace_close', { sessionId: 'owner', workspaceId: id })).toBeNull();
    expect(host.ctx.agentWorkspace.getWorkspace(id)?.status).toBe('completed');
    const second = await host.invoke<{ workspace_id: string }>('workspace_create', { sessionId: 'owner', request: {} });
    host.ctx.chatSession.createSession(newSession('sess_worker_delete', 'chat'));
    host.ctx.agentWorkspace.registerAgent(second.workspace_id, 'sess_worker_delete', 'worker', null, null);
    const guard = host.ctx.backup.tryAcquireOperation('backup');
    try {
      await expect(host.invoke('workspace_delete', { sessionId: 'owner', workspaceId: second.workspace_id })).rejects.toContain('Backup');
      expect(host.ctx.chatSession.getSession('sess_worker_delete')).not.toBeNull();
      expect(host.ctx.agentWorkspace.getWorkspace(second.workspace_id)).not.toBeNull();
    } finally { guard.release(); }
    expect(await host.invoke('workspace_delete', { sessionId: 'owner', workspaceId: second.workspace_id })).toBeNull();
    expect(host.ctx.agentWorkspace.getWorkspace(second.workspace_id)).toBeNull();
    expect(host.ctx.chatSession.getSession('sess_worker_delete')).toBeNull();
    host.ctx.backup.tryAcquireOperation('restore').release();
  } finally { await host.dispose(); f.dispose(); }
});
