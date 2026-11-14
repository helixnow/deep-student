import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { DatabaseName } from '../../../platform/storage/api.ts';
import type { TodoList } from '../api.ts';
import plugin from '../index.ts';

interface TestMaintenanceParticipant {
  readonly databases?: readonly DatabaseName[];
  enterMaintenance(): void | Promise<void>;
  exitMaintenance(): void;
}

/**
 * F3 的公开注册面（9f8c773876）尚未合入 main；这里只按已发布签名提供注册/撤销，
 * 让生产 `index.ts` 的接线走真实 `ctx.storage`。维护屏障本身仍由 F3 负责，测试
 * 不复制其 enter/release 语义。
 */
function attachParticipantRegistry(storage: object): {
  names(): string[];
  get(name: string): TestMaintenanceParticipant | undefined;
} {
  const participants = new Map<string, TestMaintenanceParticipant>();
  Object.assign(storage, {
    registerMaintenanceParticipant(name: string, participant: TestMaintenanceParticipant): () => void {
      if (participants.has(name)) throw new Error(`duplicate maintenance participant: ${name}`);
      participants.set(name, participant);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (participants.get(name) === participant) participants.delete(name);
      };
    },
  });
  return {
    names: () => [...participants.keys()],
    get: name => participants.get(name),
  };
}

let root: string;
let storage: Awaited<ReturnType<typeof createVfsTestStorage>>['storage'];
let host: Awaited<ReturnType<typeof createTestHost>>;
let disposed = false;
beforeEach(async () => {
  const created = await createVfsTestStorage('l11-maintenance-');
  root = created.root;
  storage = created.storage;
}, 120_000);
afterEach(async () => {
  if (!disposed) await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);

describe('F3 maintenance participant registration', { timeout: 120_000 }, () => {
  it('registers vfs-worker for the vfs database and unregisters it on plugin unload', async () => {
    const registry = attachParticipantRegistry(storage);
    host = await createTestHost({
      plugins: [plugin],
      provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) },
    });

    expect(registry.names()).toEqual(['vfs-worker']);
    expect(registry.get('vfs-worker')?.databases).toEqual(['vfs']);

    await host.dispose();
    disposed = true;
    expect(registry.names()).toEqual([]);
  });

  it('drains in-flight work, rejects new work while entered, then recovers on exit', async () => {
    const registry = attachParticipantRegistry(storage);
    host = await createTestHost({
      plugins: [plugin],
      provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) },
    });
    const participant = registry.get('vfs-worker');
    if (participant === undefined) throw new Error('vfs-worker participant was not registered');
    const worker = host.ctx.vfsWorker;
    await worker.workerThreadId();

    const admitted = worker.runTodoOperation<TodoList[]>('listTodoLists');
    const entering = participant.enterMaintenance();
    await expect(admitted).resolves.toEqual(expect.any(Array));
    await entering;

    await expect(worker.runTodoOperation('listTodoLists')).rejects.toThrow('paused for maintenance');

    participant.exitMaintenance();
    await expect(worker.runTodoOperation('listTodoLists')).resolves.toEqual(expect.any(Array));
  });

  it('resumes the worker when the maintenance enter hook fails', async () => {
    const registry = attachParticipantRegistry(storage);
    host = await createTestHost({
      plugins: [plugin],
      provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) },
    });
    const participant = registry.get('vfs-worker');
    if (participant === undefined) throw new Error('vfs-worker participant was not registered');
    vi.spyOn(host.ctx.vfsWorker, 'pauseAndDrain').mockRejectedValueOnce(new Error('drain failed'));

    await expect(participant.enterMaintenance()).rejects.toThrow('drain failed');
    await expect(host.ctx.vfsWorker.runTodoOperation('listTodoLists')).resolves.toEqual(expect.any(Array));
  });
});
