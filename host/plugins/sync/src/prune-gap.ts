/** commands_sync.rs:5071-5141; diagnostic publication versions never replace cursors. */
import { fs } from '../src/local-runtime.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { CoordinatedDatabaseName, DatabaseHandle } from '../../../platform/storage/api.ts';
import type { CloudStorageConfig, CloudStorage } from '../../sync-providers/api.ts';
import type { PruneGapResponse } from '../../../../contracts/ipc/generated/L20-sync.ts';
import type { SyncContext } from './dependencies.ts';
import { assertNotInMaintenance, cloudErrorMessage } from './cloud-runtime.ts';
import { getDatabaseSyncState } from '../repository/record-data.ts';
import { createPayloadCodec } from './payload.ts';
import { detectChangeLogGaps } from './change-availability.ts';
import { changeLogGapDiagnostic } from './change-keys.ts';

export async function detectPruneGap(ctx: SyncContext, config: CloudStorageConfig): Promise<PruneGapResponse> {
  assertNotInMaintenance(ctx);
  await ctx.backup.hydrateCloudConfig(config);
  const deviceId = await ctx.paths.deviceId();
  let sinceVersion: bigint | null = null;
  const names: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
  for (const name of names) {
    const path = ctx.storage.pathOf(name);
    if (!fs.existsSync(path)) continue;
    let db: DatabaseHandle;
    try {
      db = ctx.storage.openFile(path, { profile: 'plain' });
    } catch {
      // Rust if let Ok(conn): no warning on inaccessible business databases.
      continue;
    }
    try {
      try {
        const state = getDatabaseSyncState(db, name);
        if (sinceVersion === null || state.data_version < sinceVersion) sinceVersion = state.data_version;
      } catch { // boundary-allow empty-catch: commands_sync.rs:5096 uses if let Ok(state), without logging.
      }
    } finally {
      ctx.storage.close(db);
    }
  }
  let storage: CloudStorage;
  try {
    storage = await ctx.syncProvider.createStorage(config);
  } catch (error) {
    throw new CommandError(`创建云存储失败: ${cloudErrorMessage(error)}`);
  }
  const codec = await createPayloadCodec(ctx.secrets.backup, config.encryptionPassword);
  let availability;
  try {
    availability = await detectChangeLogGaps(storage, {
      deviceId, codec, logger: ctx.logger('sync'),
    }, () => ctx.syncSupport.state);
  } catch (error) {
    throw new CommandError(`检查云端变更断层失败: ${cloudErrorMessage(error)}`);
  } finally {
    codec.dispose();
  }
  const since = sinceVersion ?? 0n;
  const hasGap = availability.gaps.length > 0;
  ctx.logger('sync').info(
    `[data_governance] prune gap 检测: format=${availability.remote_format_version}, ` +
    `instance=${availability.instance_id}, since=${since}, min_available=${availability.min_available_version}, has_gap=${hasGap}`,
  );
  return {
    has_gap: hasGap,
    // Generated IPC schema and F1 JSON bridge require numbers; engine stays bigint.
    since_version: Number(since),
    min_available_version: availability.min_available_version === null ? null : Number(availability.min_available_version),
    remote_format_version: availability.remote_format_version,
    uses_device_cursors: true,
    instance_id: availability.instance_id,
    gap_details: hasGap ? availability.gaps.map(changeLogGapDiagnostic).join('；') : null,
  };
}
