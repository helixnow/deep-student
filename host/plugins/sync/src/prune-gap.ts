import { syncGovernance } from '../../backup/api.ts';
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

function recordPruneGapFailureAudit(
  ctx: SyncContext,
  config: CloudStorageConfig,
  deviceId: string | null,
  start: number,
  detail: string,
): void {
  try {
    const governance = syncGovernance(ctx) as {
      syncCommandPorts?: () => { saveSyncAudit?: (req: unknown) => void };
    } | undefined;
    const saveSyncAudit = governance?.syncCommandPorts?.()?.saveSyncAudit;
    if (typeof saveSyncAudit !== 'function') return;
    const durationMs = Math.max(0, Math.floor(performance.now() - start));
    saveSyncAudit({
      direction: 'Bidirectional',
      recordsAffected: 0,
      target: 'cloud_sync/bidirectional',
      outcome: { kind: 'failed', error: detail, durationMs },
      details: {
        device_id: deviceId,
        phase: 'detect_prune_gap',
        provider: config?.provider ?? 'webdav',
        root: config?.root ?? null,
      },
    });
  } catch {
    // Best-effort audit recording must never mask preflight errors or stubbed test fixtures.
  }
}

export async function detectPruneGap(ctx: SyncContext, config: CloudStorageConfig): Promise<PruneGapResponse> {
  const start = performance.now();
  assertNotInMaintenance(ctx);
  try {
    await syncGovernance(ctx).hydrateCloudConfig(config);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    recordPruneGapFailureAudit(ctx, config, null, start, detail);
    throw error instanceof CommandError ? error : new CommandError(detail);
  }
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
    const detail = `创建云存储失败: ${cloudErrorMessage(error)}`;
    recordPruneGapFailureAudit(ctx, config, deviceId, start, detail);
    throw new CommandError(detail);
  }
  const codec = await createPayloadCodec(ctx.secrets.backup, config.encryptionPassword);
  let availability;
  try {
    availability = await detectChangeLogGaps(storage, {
      deviceId, codec, logger: ctx.logger('sync'),
    }, () => ctx.syncSupport.state);
  } catch (error) {
    const detail = `检查云端变更断层失败: ${cloudErrorMessage(error)}`;
    recordPruneGapFailureAudit(ctx, config, deviceId, start, detail);
    throw new CommandError(detail);
  } finally {
    codec.dispose();
  }
  const since = sinceVersion ?? 0n;
  const hasGap = availability.gaps.length > 0;
  const gapDetails = hasGap ? availability.gaps.map(changeLogGapDiagnostic).join('；') : null;
  if (hasGap && gapDetails !== null) {
    recordPruneGapFailureAudit(ctx, config, deviceId, start, gapDetails);
  }
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
    gap_details: gapDetails,
  };
}
