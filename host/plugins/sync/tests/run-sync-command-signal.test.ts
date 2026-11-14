import { getEventListeners } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import type { SyncCommandPorts } from '../src/sync-command-needs.ts';
import type { CloudStorageConfig } from '../../../../contracts/ipc/generated/_shared.ts';
import sync from '../index.ts';

const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
const gates: (() => void)[] = [];
afterEach(async () => {
  for (const release of gates.splice(0)) release();
  for (const host of hosts.splice(0)) await host.dispose();
});

/**
 * The first cloud request hangs like a slow WebDAV call. As in sync-providers (cancellableSleep, stream reads), it only
 * ends early when the provider cancel token installed for this sync aborts; `release` lets it finish normally.
 */
async function fixture() {
  let token: AbortSignal | null = null;
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); gates.push(release);
  const cloud = {
    get: async () => {
      const signal = token; entered();
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        signal?.addEventListener('abort', () => reject(new Error('云同步已取消')), { once: true });
        if (signal?.aborted) reject(new Error('云同步已取消'));
      });
      return Buffer.from('{"format_version":5}');
    },
    put: vi.fn(),
  };
  let ports: SyncCommandPorts;
  const host = await createTestHost({ plugins: [sync], provide: {
    backup: { hydrateCloudConfig: vi.fn(async () => undefined), syncCommandPorts: () => ports }, paths: { deviceId: async () => 'device' },
    syncProvider: { createStorage: vi.fn(async () => cloud), setStatusHook: vi.fn(), clearStatusHook: vi.fn(),
      setCancelToken: vi.fn((signal: AbortSignal) => { token = signal; }), clearCancelToken: vi.fn(() => { token = null; }),
      isSyncCancelled: () => token?.aborted ?? false },
    secrets: { backup: createBackupCrypto() }, vfsDatabase: { isInMaintenanceMode: () => false },
    storage: { locations: { activeDir: 'unused-before-format-gate' } },
  } }); hosts.push(host);
  const permit = { release: vi.fn() };
  ports = { limiter: { tryAcquire: () => permit }, tombstones: {}, application: {},
    loadHydratedCloudConfig: vi.fn(async () => null), saveSyncAudit: vi.fn(), workspaceCoordinator: null,
  } as unknown as SyncCommandPorts;
  const start = (command: 'data_governance_run_sync' | 'data_governance_run_sync_with_progress') => {
    const pending = host.startInvoke(command, { direction: 'upload', cloudConfig: {} });
    const outcome = pending.result.then(() => 'resolved', (error: unknown) => String(error));
    return { pending, outcome };
  };
  /** What backup's governance-tool does: call the reflected service directly, outside any command invoke. */
  const startService = (method: 'runSync' | 'runSyncWithProgress', signal?: AbortSignal) => {
    const outcome = host.ctx.sync[method]('upload', {} as CloudStorageConfig, null, signal)
      .then(() => 'resolved', (error: unknown) => String(error));
    return { outcome };
  };
  return { host, started, release, permit, start, startService };
}
const settledWithin = (promise: Promise<unknown>, ms: number) => Promise.race([
  promise.then(() => 'settled', () => 'settled'), new Promise(resolve => setTimeout(() => resolve('still pending'), ms)),
]);

for (const command of ['data_governance_run_sync', 'data_governance_run_sync_with_progress'] as const) {
  it(`${command}: unloading the sync plugin mid-sync cancels the run well before the kernel stop deadline`, async () => {
    const f = await fixture();
    const { outcome } = f.start(command);
    await f.started;
    const unloaded = f.host.unload('dstu.sync');
    expect(await settledWithin(unloaded, 1000)).toBe('settled');
    expect(await outcome).toContain('取消');
    expect(f.permit.release).toHaveBeenCalledTimes(1);
  });

  it(`${command}: abandoning the invoke (window closed or page reload) keeps the sync running, as in Tauri`, async () => {
    const f = await fixture();
    const { pending, outcome } = f.start(command);
    await f.started;
    pending.abandon('reloaded');
    expect(await settledWithin(outcome, 300)).toBe('still pending');
    f.release();
    expect(await outcome).toContain('同步格式协商失败');
    expect(await outcome).not.toContain('取消');
  });

  it(`${command}: a sync abandoned by a reload is still cancelled once the plugin disposes its effects (kernel stop no longer waiting)`, async () => {
    // After an abandon the call signal is already aborted, so the kernel's CommandStoppedError abort cannot reach it.
    const f = await fixture();
    const { pending, outcome } = f.start(command);
    await f.started;
    pending.abandon('reloaded');
    const disposing = f.host.plugins.find(entry => entry.id === 'dstu.sync')!.fiber.dispose();
    expect(await settledWithin(outcome, 1000)).toBe('settled');
    expect(await outcome).toContain('取消');
    await disposing;
  });
}

for (const method of ['runSync', 'runSyncWithProgress'] as const) {
  it(`services.sync.${method}: unloading the sync plugin cancels a sync started through the service, not only through the command`, async () => {
    // The kernel does not track service calls, so unload returns at once; the run itself must end with the plugin.
    const f = await fixture();
    const { outcome } = f.startService(method);
    await f.started;
    expect(await settledWithin(f.host.unload('dstu.sync'), 1000)).toBe('settled');
    expect(await settledWithin(outcome, 1000)).toBe('settled');
    expect(await outcome).toContain('取消');
    expect(f.permit.release).toHaveBeenCalledTimes(1);
  });

  it(`services.sync.${method}: the caller's own signal still cancels the run and its listener is removed afterwards`, async () => {
    const f = await fixture();
    const caller = new AbortController();
    const { outcome } = f.startService(method, caller.signal);
    await f.started;
    expect(await settledWithin(outcome, 300)).toBe('still pending');
    caller.abort();
    expect(await settledWithin(outcome, 1000)).toBe('settled');
    expect(await outcome).toContain('取消');
    expect(f.permit.release).toHaveBeenCalledTimes(1);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });
}

it('data_governance_cancel_sync still cancels the progress sync and still does not reach the plain sync', async () => {
  const progress = await fixture();
  const running = progress.start('data_governance_run_sync_with_progress');
  await progress.started;
  expect(await progress.host.invoke('data_governance_cancel_sync')).toBe(true);
  expect(await settledWithin(running.outcome, 1000)).toBe('settled');
  expect(await running.outcome).toContain('取消');

  const plain = await fixture();
  const blocked = plain.start('data_governance_run_sync');
  await plain.started;
  // commands_sync.rs:1586 installs no cancel token; only the progress command (:2834) is user-cancellable.
  expect(await plain.host.invoke('data_governance_cancel_sync')).toBe(false);
  expect(await settledWithin(blocked.outcome, 300)).toBe('still pending');
  plain.release();
  expect(await blocked.outcome).toContain('同步格式协商失败');
});
