import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import backupPlugin from '../../backup/index.ts';
import plugin from '../index.ts';
import { artifactRoot, tempRoot, newSleepBlockData, type WorkspaceChatSessionDeletion } from '../api.ts';
import { memorySettings } from './support.ts';

async function setup(deleteSessionV2: WorkspaceChatSessionDeletion['deleteSessionV2']) {
  const host = await createTestHost({ provide: {
    settings: memorySettings(),
    secrets: { openStore() { throw new Error('deletion does not use secrets'); } },
    chatSession: { deleteSessionV2 },
  } });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  host.ctx.provide('storage', storage);
  expect((await storage.migrations.runAll()).success).toBe(true);
  await host.install(plugin);
  await host.install(backupPlugin);
  const coordinator = host.ctx.agentWorkspace;
  const workspace = coordinator.createWorkspace('coord', 'delete integration');
  coordinator.registerAgent(workspace.id, 'coord', 'coordinator', null, null);
  for (const worker of ['worker-a', 'worker-b']) coordinator.registerAgent(workspace.id, worker, 'worker', null, null);
  const roots = new Map<string, string[]>();
  for (const session of ['coord', 'worker-a', 'worker-b']) {
    const dirs = [artifactRoot(host.app.dataDir, session, true).path, tempRoot(host.app.dataDir, session, true).path];
    for (const dir of dirs) fs.writeFileSync(path.join(dir, 'file.txt'), session);
    roots.set(session, dirs);
  }
  return { host, storage, coordinator, workspace, roots, async dispose() {
    coordinator.shutdownAllSleeps();
    if (!coordinator.isInMaintenanceMode()) await coordinator.enterMaintenanceMode();
    storage.dispose();
    await host.dispose();
  } };
}

it('W2 shared L21 busy guard fails immediately before closing, cancelling or deleting', async () => {
  const deletion = vi.fn();
  const f = await setup(deletion);
  const held = f.host.ctx.backup.tryAcquireOperation('backup');
  try {
    const sleeps = f.coordinator.getSleepManager(f.workspace.id);
    const sleep = newSleepBlockData(f.workspace.id, 'coord', [], { type: 'result_message' });
    sleeps.beginSleep(sleep);
    let original: unknown;
    try { f.host.ctx.governance.tryAcquireOperationGuard('delete_propagation'); } catch (error) { original = error; }
    expect(original).toBeInstanceOf(Error);
    let failure: unknown;
    try { f.coordinator.deleteWorkspace(f.workspace.id); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe((original as Error).message);
    expect(failure).not.toBeInstanceOf(CommandError);
    expect(f.coordinator.getWorkspace(f.workspace.id)?.status).toBe('active');
    expect(sleeps.isSleepActive(sleep.id)).toBe(true);
    expect(deletion).not.toHaveBeenCalled();
    for (const dirs of f.roots.values()) for (const dir of dirs) expect(fs.existsSync(dir)).toBe(true);
    expect(f.host.eventsNamed('workspace_closed')).toEqual([]);
  } finally {
    held.release();
    await f.dispose();
  }
});

it.each([false, true])('W2 holds delete_propagation through worker cleanup and releases on callback failure=%s', async failure => {
  const deletion = vi.fn((session: string) => {
    // Only the unavailable L04 candidate is replaced; policy/DB/permit/filesystem are real.
    expect(['worker-a', 'worker-b']).toContain(session);
    for (const dir of f.roots.get(session)!) expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(f.storage.locations.activeDir, 'workspaces', `ws_${f.workspace.id}.db`))).toBe(false);
    expect(f.host.eventsNamed('workspace_closed')).toEqual([{ workspace_id: f.workspace.id }]);
    expect(() => f.host.ctx.backup.tryAcquireOperation('restore')).toThrow('DeletePropagation');
    if (failure) throw new Error('L04 deletion failed');
  });
  const f = await setup(deletion);
  try {
    if (failure) {
      expect(() => f.coordinator.deleteWorkspace(f.workspace.id)).toThrow('工作区已删除，但部分关联会话清理失败:');
    } else f.coordinator.deleteWorkspace(f.workspace.id);
    expect(deletion.mock.calls.map(([session]) => session).sort()).toEqual(['worker-a', 'worker-b']);
    for (const dir of f.roots.get('coord')!) expect(fs.existsSync(dir)).toBe(true);
    const next = f.host.ctx.backup.tryAcquireOperation('restore');
    expect(next.snapshot.kind).toBe('restore');
    next.release();
  } finally {
    await f.dispose();
  }
});
