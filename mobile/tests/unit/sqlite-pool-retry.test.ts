/**
 * V06-07：opfs-sahpool 的同步访问句柄被另一个 Worker 占用时，`createSqliteRuntime` 按
 * `POOL_RETRY_DELAYS_MS` 有限退避重试；仍失败时不让 Host 启动失败，而是交出“库被锁定”的运行时，
 * 存储插件据此进入核心恢复屏障，原因经迁移状态事件与 MAINTENANCE 错误给到前端。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin } from '../../../host/kernel/core.ts';
import { loadImportedProfile } from '../../../host/kernel/profile-install.ts';
import { createTestHost, type TestHost } from '../../../host/kernel/testing.ts';
import { PROFILES } from '../../../host/platform/storage/profiles.ts';
import { MEMORY_DATABASE, MobileConnection } from '../../../host/platform/storage-mobile/connection.ts';
import mobileStorage from '../../../host/platform/storage-mobile/index.ts';
import { POOL_RETRY_DELAYS_MS, createSqliteRuntime } from '../../src/worker/sqlite-runtime.ts';
import { errorShape, nodeSqlite, thrown } from './support/sqlite-node.ts';

let host: TestHost | undefined;
afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

interface InstallOptions { name: string; directory: string; initialCapacity: number; forceReinitIfPreviouslyFailed: boolean }

/** 前 `busyFor` 次安装抛 `busy`，之后返回一个只用于计数的 pool 桩。 */
async function stubbedSqlite(busyFor: number, busy: () => unknown = () => new DOMException('Access Handles cannot be created if there is another open Access Handle', 'NoModificationAllowedError')) {
  const real = await nodeSqlite();
  const calls: InstallOptions[] = [];
  const pool = {
    OpfsSAHPoolDb: function OpfsSAHPoolDb() { throw new Error('not used'); },
    getFileNames: () => [],
    unlink: () => undefined,
    exportFile: () => new Uint8Array(),
    reserveMinimumCapacity: async () => undefined,
  };
  const sqlite3 = {
    ...real,
    installOpfsSAHPoolVfs: async (options: InstallOptions) => {
      calls.push(options);
      if (calls.length <= busyFor) throw busy();
      return pool;
    },
  };
  return { calls, init: async () => sqlite3 as unknown as typeof real };
}

describe('SAH pool contention', () => {
  it('retries while the pool is held and succeeds once it is released', async () => {
    const { calls, init } = await stubbedSqlite(3);
    const waits: number[] = [];
    const { runtime, timings } = await createSqliteRuntime({ init, wait: async ms => { waits.push(ms); } });
    expect(waits).toEqual(POOL_RETRY_DELAYS_MS.slice(0, 3));
    expect(calls.map(call => call.forceReinitIfPreviouslyFailed)).toEqual([false, true, true, true]);
    expect(timings).toMatchObject({ poolAttempts: 4, poolError: null });
    expect(runtime.exists('/anything.db')).toBe(false);
  });

  it('WebKit reports the same condition as InvalidStateError', async () => {
    const { init } = await stubbedSqlite(1, () => new DOMException('held', 'InvalidStateError'));
    const { timings } = await createSqliteRuntime({ init, wait: async () => undefined });
    expect(timings).toMatchObject({ poolAttempts: 2, poolError: null });
  });

  it('other install errors are not retried', async () => {
    const { calls, init } = await stubbedSqlite(1, () => new Error('Missing required OPFS APIs.'));
    const waits: number[] = [];
    await expect(createSqliteRuntime({ init, wait: async ms => { waits.push(ms); } })).rejects.toThrow('Missing required OPFS APIs.');
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('gives up after the bounded window: databases open as locked and the Host boots into core recovery', async () => {
    const { calls, init } = await stubbedSqlite(Number.POSITIVE_INFINITY);
    const waits: number[] = [];
    const { runtime, timings } = await createSqliteRuntime({ init, wait: async ms => { waits.push(ms); } });
    expect(waits).toEqual(POOL_RETRY_DELAYS_MS);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(9_500);
    expect(calls).toHaveLength(POOL_RETRY_DELAYS_MS.length + 1);
    expect(timings.poolAttempts).toBe(POOL_RETRY_DELAYS_MS.length + 1);
    expect(timings.poolError).toMatch(/still held by another worker after 8 attempts: NoModificationAllowedError/);
    // 与桌面库被另一进程锁住时 better-sqlite3 打开失败的形状相同（storage-errors.differential.test.ts 的 BUSY 用例）。
    expect(errorShape(thrown(() => runtime.open('/data/slots/slotA/databases/vfs.db')))).toEqual({
      storageError: true, code: 'SQLITE', sqliteCode: 'SQLITE_BUSY', phase: 'execute', database: '/data/slots/slotA/databases/vfs.db', message: 'database is locked',
    });

    host = await createTestHost({ provide: { sqliteRuntime: runtime } });
    const business = definePlugin({
      meta: { id: 'dstu.notes', commands: ['notes_list'] },
      inject: ['storage'],
      apply(ctx) {
        const db = ctx.storage.database('vfs');
        ctx.commands.register('notes_list', () => db.all('SELECT 1'));
      },
    });
    const loaded = await loadImportedProfile(host.runtime, [
      { plugin: mobileStorage, source: 'test:storage-mobile' },
      { plugin: business, source: 'test:business' },
    ]);
    await host.ctx.storage.runStartupFinalizers();

    const recovery = host.ctx.storage.startupCoreRecovery()!;
    expect(recovery.databases).toEqual(['mistakes', 'vfs', 'chat_v2', 'llm_usage']);
    expect(recovery.reason).toMatch(/^Database 'vfs' migration failed: Database error: database is locked\. .*; Database 'llm_usage' migration failed: Database error: database is locked\. /);
    expect(loaded.degraded.map(entry => entry.id)).toEqual(['dstu.notes']);
    await expect(host.invoke('notes_list', {})).rejects.toMatchObject({
      message: 'MAINTENANCE_MODE: notes is temporarily unavailable',
      details: { code: 'MAINTENANCE', reason: recovery.reason },
    });
    const [status] = host.eventsNamed('data-governance-migration-status') as [{ success: boolean; warnings: string[] }];
    expect(status.success).toBe(true);
    expect(status.warnings).toHaveLength(3);
    expect(status.warnings.filter(w => w.includes('database is locked'))).toHaveLength(2);
  }, 60_000);

  it('the migration scratch is an in-memory database outside the pool, with or without the pool', async () => {
    for (const busyFor of [0, Number.POSITIVE_INFINITY]) {
      const { init } = await stubbedSqlite(busyFor);
      const { runtime, timings } = await createSqliteRuntime({ init, wait: async () => undefined });
      expect(timings.poolError === null).toBe(busyFor === 0);
      // 桩 pool 的 OpfsSAHPoolDb 一构造就抛错：scratch 走到 pool 就会在这里失败。
      const scratch = new MobileConnection(runtime.sqlite3, runtime.openMemory(), MEMORY_DATABASE, { label: 'migration-scratch', profile: PROFILES.plain });
      try {
        expect(scratch.applied).toMatchObject({ journalMode: 'memory', foreignKeys: 1, pageSize: 4096 });
        scratch.exec('CREATE TABLE replay(x INTEGER)');
        expect(scratch.pluck("SELECT name FROM sqlite_master WHERE type='table'")).toBe('replay');
      } finally {
        scratch.close();
      }
    }
  });
});
