/** commands_sync.rs:4033-4133. Registered through the real L21/L20b owner ports. */
import { join } from '../../../platform/util/path.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { RuntimeCloudStorageConfig } from '../../sync-providers/api.ts';
import type { SyncContext } from './dependencies.ts';
import type { SyncGlobalLimiter, SyncMutationPermit } from './limiter-needs.ts';
import type { AsyncTombstoneWriter } from './tombstone-needs.ts';
import { enforceRecordUploadEncryptionPolicyForConfig } from './upload-policy.ts';
import { createPayloadCodec } from './payload.ts';
import { markBlobDeleted, markAssetDeleted } from './file-deletions.ts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function acquireTombstonePermit(limiter: SyncGlobalLimiter): SyncMutationPermit {
  const permit = limiter.tryAcquire();
  if (permit === null) throw new CommandError('[E_DG_TOMBSTONE_LIMITER_BUSY] 另一个数据治理任务（同步/备份/恢复/删除标记）正在进行中，请稍后再试。');
  return permit;
}
async function markDeletedCommand(
  ctx: SyncContext, limiter: SyncGlobalLimiter, tombstones: AsyncTombstoneWriter, config: RuntimeCloudStorageConfig,
  kind: 'blob' | 'asset', key: string, path: string | null, size: bigint | null,
): Promise<void> {
  await ctx.backup.hydrateCloudConfig(config);
  const permit = acquireTombstonePermit(limiter);
  try {
    let storage;
    try { storage = await ctx.syncProvider.createStorage(config); }
    catch (error) { throw new CommandError(`创建云存储失败: ${message(error)}`); }
    const deviceId = await ctx.paths.deviceId();
    try {
      await enforceRecordUploadEncryptionPolicyForConfig(ctx.syncProvider, config, deviceId,
        { backup: ctx.secrets.backup, encryptionMemoryPath: join(ctx.app.dataDir, '.cloud-encrypted-roots.json') });
    } catch (error) { throw new CommandError(message(error)); }
    const codec = await createPayloadCodec(ctx.secrets.backup, config.encryptionPassword);
    try {
      const options = { deviceId, codec, tombstones, logger: ctx.logger('sync') };
      if (kind === 'blob') await markBlobDeleted(storage, key, path, size, options);
      else await markAssetDeleted(storage, key, size, options);
    } catch (error) { throw new CommandError(`标记${kind === 'blob' ? ' blob ' : '资产'}删除失败: ${message(error)}`); }
    finally { codec.dispose(); }
  } finally { permit.release(); }
}
export function markBlobDeletedCommand(ctx: SyncContext, limiter: SyncGlobalLimiter, tombstones: AsyncTombstoneWriter, config: RuntimeCloudStorageConfig, hash: string, path: string | null, size: bigint | null): Promise<void> {
  return markDeletedCommand(ctx, limiter, tombstones, config, 'blob', hash, path, size);
}
export function markAssetDeletedCommand(ctx: SyncContext, limiter: SyncGlobalLimiter, tombstones: AsyncTombstoneWriter, config: RuntimeCloudStorageConfig, key: string, size: bigint | null): Promise<void> {
  return markDeletedCommand(ctx, limiter, tombstones, config, 'asset', key, null, size);
}
