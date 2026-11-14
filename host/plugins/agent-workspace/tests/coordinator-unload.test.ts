/** V09 P2-6: the workspace databases the coordinator opens through `storage.openFile` belong to the plugin's lifetime.
 * Unloading agent-workspace closes them; a reinstall reopens the same file through a single new handle.
 */
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { newSleepBlockData } from '../api.ts';
import plugin from '../index.ts';
import { memorySettings } from './support.ts';

it('unload closes every workspace database handle and a reinstall reopens the workspace', async () => {
  const host = await createTestHost({ provide: {
    settings: memorySettings(),
    secrets: { openStore() { throw new Error('workspace databases do not use secrets'); } },
  } });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  host.ctx.provide('storage', storage);
  expect((await storage.migrations.runAll()).success).toBe(true);
  const open = new Set<DatabaseHandle>();
  const openFile = storage.openFile.bind(storage);
  const close = storage.close.bind(storage);
  vi.spyOn(storage, 'openFile').mockImplementation((file, options) => {
    const handle = openFile(file, options);
    if (options?.profile === 'workspace') open.add(handle);
    return handle;
  });
  vi.spyOn(storage, 'close').mockImplementation((handle) => { open.delete(handle); close(handle); });
  try {
    await host.install(plugin);
    const first = host.ctx.agentWorkspace.createWorkspace('coord', 'first');
    const second = host.ctx.agentWorkspace.createWorkspace('coord', 'second');
    host.ctx.agentWorkspace.registerAgent(first.id, 'coord', 'coordinator', null, null);
    expect(open.size).toBe(2);

    await host.unload('dstu.agent-workspace');
    expect(open.size).toBe(0);

    await host.install(plugin);
    expect(host.ctx.agentWorkspace.getWorkspace(first.id)).toMatchObject({ id: first.id, name: 'first' });
    expect(host.ctx.agentWorkspace.listAgents(first.id).map(agent => agent.sessionId)).toEqual(['coord']);
    expect(host.ctx.agentWorkspace.getWorkspace(second.id)).toMatchObject({ id: second.id, name: 'second' });
    expect(open.size).toBe(2);
  } finally {
    vi.restoreAllMocks();
    storage.dispose();
    await host.dispose();
  }
});

it('closing or deleting a workspace closes its database handle (the file can be deleted on Windows) and reopening uses one new handle', async () => {
  const host = await createTestHost({ provide: {
    settings: memorySettings(),
    secrets: { openStore() { throw new Error('workspace databases do not use secrets'); } },
    governance: { tryAcquireOperationGuard: () => ({ release() {} }) },
  } });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  host.ctx.provide('storage', storage);
  expect((await storage.migrations.runAll()).success).toBe(true);
  const open = new Map<DatabaseHandle, string>();
  const openFile = storage.openFile.bind(storage);
  const close = storage.close.bind(storage);
  vi.spyOn(storage, 'openFile').mockImplementation((file, options) => {
    const handle = openFile(file, options);
    if (options?.profile === 'workspace') open.set(handle, path.basename(file));
    return handle;
  });
  vi.spyOn(storage, 'close').mockImplementation((handle) => { open.delete(handle); close(handle); });
  try {
    await host.install(plugin);
    const closed = host.ctx.agentWorkspace.createWorkspace('coord', 'closed');
    const deleted = host.ctx.agentWorkspace.createWorkspace('coord', 'deleted');
    expect([...open.values()].sort()).toEqual([`ws_${closed.id}.db`, `ws_${deleted.id}.db`].sort());

    host.ctx.agentWorkspace.closeWorkspace(closed.id);
    expect([...open.values()]).toEqual([`ws_${deleted.id}.db`]);

    host.ctx.agentWorkspace.deleteWorkspace(deleted.id);
    expect([...open.values()]).toEqual([]);

    expect(host.ctx.agentWorkspace.getWorkspace(closed.id)).toMatchObject({ id: closed.id, name: 'closed', status: 'completed' });
    expect([...open.values()]).toEqual([`ws_${closed.id}.db`]);
  } finally {
    vi.restoreAllMocks();
    storage.dispose();
    await host.dispose();
  }
});

it('unload stops pending sleep timeout timers and leaves the sleep row for the next start to restore', async () => {
  const host = await createTestHost({ provide: {
    settings: memorySettings(),
    secrets: { openStore() { throw new Error('workspace databases do not use secrets'); } },
  } });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  host.ctx.provide('storage', storage);
  expect((await storage.migrations.runAll()).success).toBe(true);
  try {
    await host.install(plugin);
    const workspace = host.ctx.agentWorkspace.createWorkspace('coord', 'sleepy');
    const sleeps = host.ctx.agentWorkspace.getSleepManager(workspace.id);
    const data = {
      ...newSleepBlockData(workspace.id, 'coord', ['worker'], { type: 'result_message' }),
      timeoutAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    sleeps.beginSleep(data);

    await host.unload('dstu.agent-workspace');
    expect(await sleeps.shutdown(50)).toBe(true);

    await host.install(plugin);
    const restored = host.ctx.agentWorkspace.getSleepManager(workspace.id).restoreSleeps();
    expect(restored.map(row => [row.id, row.status])).toEqual([[data.id, 'sleeping']]);
  } finally {
    storage.dispose();
    await host.dispose();
  }
});
