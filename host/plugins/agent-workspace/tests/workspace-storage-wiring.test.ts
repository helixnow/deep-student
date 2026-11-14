import { expect, it } from 'vitest';
import { createWorkspaceHost } from './host-support.ts';

it('liveExecutor preserves the real SQLite receiver across maintenance and reopen', async () => {
  const { host, storage } = await createWorkspaceHost();
  const coordinator = host.ctx.agentWorkspace;
  try {
    const migration = await storage.migrations.runAll();
    expect(migration.success).toBe(true);
    const workspace = coordinator.createWorkspace('coordinator', 'receiver regression');
    coordinator.registerAgent(workspace.id, 'coordinator', 'coordinator', null, null);
    coordinator.registerAgent(workspace.id, 'worker', 'worker', null, null);
    const message = coordinator.sendMessage(workspace.id, 'worker', 'coordinator', 'result', 'done');
    expect(coordinator.peekInbox(workspace.id, 'coordinator').map(value => value.id)).toEqual([message.id]);
    await coordinator.enterMaintenanceMode();
    expect(() => coordinator.listAgents(workspace.id)).toThrow();
    coordinator.exitMaintenanceMode();
    expect(coordinator.listAgents(workspace.id).map(value => value.sessionId).sort()).toEqual(['coordinator', 'worker']);
    expect(coordinator.drainInbox(workspace.id, 'coordinator', 1).map(value => value.id)).toEqual([message.id]);
    expect(coordinator.pendingInboxCount(workspace.id, 'coordinator')).toBe(0);
    coordinator.closeWorkspace(workspace.id);
    expect(coordinator.getWorkspace(workspace.id)?.status).toBe('completed');
    coordinator.closeWorkspace(workspace.id);
  } finally {
    await coordinator.enterMaintenanceMode();
    storage.dispose();
    await host.dispose();
  }
});
