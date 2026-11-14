import { afterEach, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { SyncContext } from '../src/dependencies.ts';
import { OperationBusyError, OperationLockError, type BackupService } from '../../backup/api.ts';
import { CommandError } from '../../../kernel/api.ts';
import { importSyncDataCommand, resolveRecordConflictCommand, rollbackSyncSnapshotCommand } from '../src/mutation-commands.ts';

const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });
async function context(backup: object, maintenance = false) {
  const host = await createTestHost({ provide: { backup, vfsDatabase: { isInMaintenanceMode: () => maintenance }, storage: {}, paths: {}, mastery: {} } });
  hosts.push(host); return host.ctx as SyncContext;
}
it('mutation busy errors precede conflict arguments and database lookup', async () => {
  const ctx = await context({ tryAcquireOperation: () => { throw new OperationBusyError('busy'); } });
  expect(() => resolveRecordConflictCommand(ctx, { databaseName: 'unknown', tableName: 'notes', recordId: 'a', resolution: 'keep_local', mergedDataJson: null, expectedConflictIds: [] }))
    .toThrow('其他备份、恢复或同步操作正在进行，请刷新冲突后重试');
  expect(() => rollbackSyncSnapshotCommand(ctx, 'unknown', 'batch')).toThrow('其他备份、恢复或同步操作正在进行，请稍后重试');
});
it('local mutation errors still release the shared permit', async () => {
  const release = vi.fn(), ctx = await context({ tryAcquireOperation: () => ({ release }) });
  expect(() => resolveRecordConflictCommand(ctx, { databaseName: 'unknown', tableName: 'notes', recordId: 'a', resolution: 'keep_local', mergedDataJson: null, expectedConflictIds: [1] })).toThrow('未知数据库: unknown');
  expect(release).toHaveBeenCalledTimes(1);
  expect(() => rollbackSyncSnapshotCommand(ctx, 'unknown', 'batch')).toThrow('未知数据库: unknown');
  expect(release).toHaveBeenCalledTimes(2);
});
it('import preserves shared operation timeout and failure errors before reading any file', async () => {
  const acquire = vi.fn<BackupService['acquireOperation']>()
    .mockRejectedValueOnce(new CommandError('等待全局数据治理锁超时（60秒），可能有其他数据治理操作正在执行，请稍后再试。'))
    .mockRejectedValueOnce(new CommandError('获取全局数据治理锁失败'));
  const ctx = await context({ acquireOperation: acquire });
  await expect(importSyncDataCommand(ctx, '/missing', null)).rejects.toMatchObject({ value: '等待全局数据治理锁超时（60秒），可能有其他数据治理操作正在执行，请稍后再试。' });
  await expect(importSyncDataCommand(ctx, '/missing', null)).rejects.toMatchObject({ value: '获取全局数据治理锁失败' });
  expect(acquire).toHaveBeenNthCalledWith(1, 'sync', 60_000);
});
it('lock IO is not mislabeled as a busy operation', async () => {
  const ctx = await context({ tryAcquireOperation: () => { throw new OperationLockError('cannot write lock file'); } });
  expect(() => rollbackSyncSnapshotCommand(ctx, 'vfs', 'batch')).toThrow('cannot write lock file');
});
