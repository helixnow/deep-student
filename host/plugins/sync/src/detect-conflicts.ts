/**
 * `data_governance_detect_conflicts`（commands_sync.rs:1280）。
 *
 * 本地清单来自四个业务库的同步状态；云端清单优先用显式 JSON（测试/调试），
 * 否则按 `cloud_config` 下载并合并其他设备清单。无云端清单时只返回本地状态。
 */
import type { SyncContext } from './dependencies.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { CloudStorageConfig } from '../../../../contracts/ipc/generated/_shared.ts';
import type {
  ConflictDetectionResponse,
  DatabaseConflictResponse,
} from '../../../../contracts/ipc/generated/L20-sync.ts';
import type { RuntimeCloudStorageConfig } from '../../sync-providers/api.ts';
import { createPayloadCodec } from './payload.ts';
import { downloadManifest, parseSyncManifest } from './remote-manifest.ts';
import { collectLocalManifest } from './transfer-commands.ts';
import { detectConflicts, type ConflictDetectionResult, type SyncManifest } from './merge.ts';
import { stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { assertNotInMaintenance, cloudErrorMessage, createCloudStorage } from './cloud-runtime.ts';
import type { SyncLogger } from './log.ts';

export interface DetectConflictsArgs {
  cloudManifestJson?: string | null;
  cloudConfig?: CloudStorageConfig | null;
}

function manifestJson(manifest: SyncManifest): string | null {
  try {
    return stringifyJsonLossless(manifest as unknown as DbJson);
  } catch {
    // 与 Rust `serde_json::to_string(&manifest).ok()` 一致：序列化失败返回 null。
    return null;
  }
}

function databaseConflicts(detection: ConflictDetectionResult): DatabaseConflictResponse[] {
  return detection.database_conflicts.map(conflict => ({
    database_name: conflict.database_name,
    conflict_type: conflict.conflict_type,
    local_version: conflict.local_state === null ? null : Number(conflict.local_state.data_version),
    cloud_version: conflict.cloud_state === null ? null : Number(conflict.cloud_state.data_version),
    local_schema_version: conflict.local_state === null ? null : conflict.local_state.schema_version,
    cloud_schema_version: conflict.cloud_state === null ? null : conflict.cloud_state.schema_version,
  }));
}

async function loadCloudManifest(
  ctx: SyncContext,
  args: DetectConflictsArgs,
  deviceId: string,
  logger: SyncLogger,
): Promise<SyncManifest | null> {
  if (args.cloudManifestJson !== undefined && args.cloudManifestJson !== null) {
    try {
      return parseSyncManifest(args.cloudManifestJson);
    } catch (error) {
      throw new CommandError(`解析云端清单失败: ${cloudErrorMessage(error)}`);
    }
  }
  if (args.cloudConfig === undefined || args.cloudConfig === null) return null;

  const config = args.cloudConfig as RuntimeCloudStorageConfig;
  let storage;
  try {
    storage = await createCloudStorage(ctx, config);
  } catch (error) {
    throw new CommandError(`创建云存储失败: ${cloudErrorMessage(error)}`);
  }

  const codec = await createPayloadCodec(ctx.secrets.backup, config.encryptionPassword ?? null);
  try {
    return await downloadManifest(storage, { deviceId, codec, logger });
  } catch (error) {
    throw new CommandError(`从云端下载清单失败: ${cloudErrorMessage(error)}`);
  } finally {
    codec.dispose();
  }
}

/** `data_governance_detect_conflicts`（commands_sync.rs:1280）。 */
export async function detectSyncConflicts(
  ctx: SyncContext,
  args: DetectConflictsArgs,
): Promise<ConflictDetectionResponse> {
  const logger = ctx.logger('sync');
  logger.info('[data_governance] 开始检测同步冲突');
  assertNotInMaintenance(ctx);

  const deviceId = await ctx.paths.deviceId();
  const { manifest: localManifest } = collectLocalManifest(ctx.storage, deviceId, false, logger);
  const cloudManifest = await loadCloudManifest(ctx, args, deviceId, logger);

  if (cloudManifest === null) {
    logger.info('[data_governance] 无云端清单，返回本地状态');
    return {
      has_conflicts: false,
      needs_migration: false,
      database_conflicts: [],
      record_conflict_count: 0,
      local_manifest_json: manifestJson(localManifest),
      cloud_manifest_json: null,
    };
  }

  let detection;
  try {
    detection = detectConflicts(localManifest, cloudManifest);
  } catch (error) {
    throw new CommandError(`冲突检测失败: ${cloudErrorMessage(error)}`);
  }

  logger.info(
    `[data_governance] 冲突检测完成: has_conflicts=${detection.has_conflicts}, ` +
      `needs_migration=${detection.needs_migration}, ` +
      `db_conflicts=${detection.database_conflicts.length}, ` +
      `record_conflicts=${detection.record_conflicts.length}`,
  );

  return {
    has_conflicts: detection.has_conflicts,
    needs_migration: detection.needs_migration,
    database_conflicts: databaseConflicts(detection),
    record_conflict_count: detection.record_conflicts.length,
    local_manifest_json: manifestJson(localManifest),
    cloud_manifest_json: manifestJson(cloudManifest),
  };
}
