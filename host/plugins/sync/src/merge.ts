import type { JsonValue } from '../api.ts';
import { compareLwwTimestamps, lwwDevicePair } from './lww.ts';
import { ManualResolutionRequiredError } from './errors.ts';
import { toRfc3339 as nowRfc3339 } from '../../../platform/time/index.ts';

export { ManualResolutionRequiredError, SyncError } from './errors.ts';

export type SyncTransactionStatus = 'Complete' | 'Partial' | 'Failed';
export type DatabaseConflictType = 'SchemaMismatch' | 'DataConflict' | 'ChecksumMismatch' | 'LocalOnly' | 'CloudOnly';
export type MergeStrategy = 'KeepLocal' | 'UseCloud' | 'KeepLatest' | 'Manual';

export interface DatabaseSyncState {
  schema_version: number;
  data_version: number | bigint;
  checksum: string;
  last_updated_at?: string | null;
}

/** sync/mod.rs:171-197. Fields retain the serde wire names. */
export interface SyncManifest {
  sync_transaction_id: string;
  databases: Record<string, DatabaseSyncState>;
  status: SyncTransactionStatus;
  created_at: string;
  device_id: string;
  format_version: number;
  published_max_seq: number | bigint;
  cursors: Record<string, number | bigint>;
  superseded_by?: string | null;
  snapshot_seen: Record<string, string>;
}

export interface DatabaseConflict {
  database_name: string;
  conflict_type: DatabaseConflictType;
  local_state: DatabaseSyncState | null;
  cloud_state: DatabaseSyncState | null;
}

export interface ConflictRecord {
  database_name: string;
  table_name: string;
  record_id: string;
  local_version: number;
  cloud_version: number;
  local_updated_at: string;
  cloud_updated_at: string;
  local_data: JsonValue;
  cloud_data: JsonValue;
}

/** sync/mod.rs:281-307. */
export interface ConflictDetectionResult {
  database_conflicts: DatabaseConflict[];
  record_conflicts: ConflictRecord[];
  has_conflicts: boolean;
  needs_migration: boolean;
}

export function emptyConflictDetection(): ConflictDetectionResult {
  return { database_conflicts: [], record_conflicts: [], has_conflicts: false, needs_migration: false };
}

export function totalConflicts(result: ConflictDetectionResult): number {
  return result.database_conflicts.length + result.record_conflicts.length;
}

/** sync/mod.rs:10063-10102. */
export interface MergeApplicationResult {
  success: boolean;
  kept_local: number;
  used_cloud: number;
  records_to_push: string[];
  records_to_pull: string[];
  errors: string[];
}

export function mergeApplicationSuccess(keptLocal: number, usedCloud: number): MergeApplicationResult {
  return { success: true, kept_local: keptLocal, used_cloud: usedCloud, records_to_push: [], records_to_pull: [], errors: [] };
}

export function mergeApplicationFailure(errors: string[]): MergeApplicationResult {
  return { success: false, kept_local: 0, used_cloud: 0, records_to_push: [], records_to_pull: [], errors };
}

function versionsEqual(left: number | bigint, right: number | bigint): boolean {
  return typeof left === typeof right ? left === right : BigInt(left) === BigInt(right);
}

/** sync/mod.rs:1097-1179. Database names sort by Rust String Ord (UTF-8 bytes). */
export function detectConflicts(localManifest: SyncManifest, cloudManifest: SyncManifest): ConflictDetectionResult {
  const result = emptyConflictDetection();
  const names = [...new Set([...Object.keys(localManifest.databases), ...Object.keys(cloudManifest.databases)])];
  names.sort(compareUtf8);

  for (const databaseName of names) {
    const local = Object.hasOwn(localManifest.databases, databaseName) ? localManifest.databases[databaseName]! : undefined;
    const cloud = Object.hasOwn(cloudManifest.databases, databaseName) ? cloudManifest.databases[databaseName]! : undefined;
    if (local && cloud) {
      if (local.schema_version !== cloud.schema_version) {
        result.database_conflicts.push({
          database_name: databaseName,
          conflict_type: 'SchemaMismatch',
          local_state: { ...local },
          cloud_state: { ...cloud },
        });
        result.needs_migration = true;
      } else if (!versionsEqual(local.data_version, cloud.data_version)) {
        if (local.checksum !== cloud.checksum) {
          result.database_conflicts.push({
            database_name: databaseName,
            conflict_type: 'DataConflict',
            local_state: { ...local },
            cloud_state: { ...cloud },
          });
        }
      } else if (local.checksum !== cloud.checksum) {
        result.database_conflicts.push({
          database_name: databaseName,
          conflict_type: 'ChecksumMismatch',
          local_state: { ...local },
          cloud_state: { ...cloud },
        });
      }
    } else if (local) {
      result.database_conflicts.push({
        database_name: databaseName,
        conflict_type: 'LocalOnly',
        local_state: { ...local },
        cloud_state: null,
      });
    } else if (cloud) {
      result.database_conflicts.push({
        database_name: databaseName,
        conflict_type: 'CloudOnly',
        local_state: null,
        cloud_state: { ...cloud },
      });
    }
  }

  result.has_conflicts = result.database_conflicts.length > 0 || result.record_conflicts.length > 0;
  return result;
}

/** sync/mod.rs:4532-4603. */
export function applyMergeStrategy(strategy: MergeStrategy, conflicts: readonly ConflictRecord[]): MergeApplicationResult {
  let keptLocal = 0;
  let usedCloud = 0;
  const recordsToPush: string[] = [];
  const recordsToPull: string[] = [];
  const errors: string[] = [];

  for (const conflict of conflicts) {
    switch (strategy) {
      case 'KeepLocal':
        recordsToPush.push(conflict.record_id);
        keptLocal += 1;
        break;
      case 'UseCloud':
        recordsToPull.push(conflict.record_id);
        usedCloud += 1;
        break;
      case 'KeepLatest': {
        let localContent: string;
        let cloudContent: string;
        try { localContent = JSON.stringify(conflict.local_data); } catch { localContent = ''; }
        try { cloudContent = JSON.stringify(conflict.cloud_data); } catch { cloudContent = ''; }
        const [localDevice, cloudDevice] = lwwDevicePair(conflict.local_data, conflict.cloud_data, null);
        const ordering = compareLwwTimestamps(
          conflict.local_updated_at, localDevice, localContent,
          conflict.cloud_updated_at, cloudDevice, cloudContent,
        );
        if (ordering >= 0) {
          recordsToPush.push(conflict.record_id);
          keptLocal += 1;
        } else {
          recordsToPull.push(conflict.record_id);
          usedCloud += 1;
        }
        break;
      }
      case 'Manual':
        errors.push(`记录 ${conflict.record_id} 需要手动处理`);
        break;
    }
  }

  if (errors.length > 0 && strategy === 'Manual') throw new ManualResolutionRequiredError(errors.length);

  const result = mergeApplicationSuccess(keptLocal, usedCloud);
  result.records_to_push = recordsToPush;
  result.records_to_pull = recordsToPull;
  return result;
}

/** sync/mod.rs:1372-1385. */
export function createManifest(deviceId: string, databases: Record<string, DatabaseSyncState>): SyncManifest {
  return {
    sync_transaction_id: globalThis.crypto.randomUUID(),
    databases: { ...databases },
    status: 'Complete',
    created_at: nowRfc3339(),
    device_id: deviceId,
    format_version: CURRENT_FORMAT_VERSION,
    published_max_seq: 0,
    cursors: {},
    superseded_by: null,
    snapshot_seen: {},
  };
}

/** `SyncManager::has_prune_gap`（sync/mod.rs:8122）。 */
export function hasPruneGap(sinceVersion: bigint, minAvailableVersion?: bigint | null): boolean {
  if (minAvailableVersion === null || minAvailableVersion === undefined) return false;
  return sinceVersion > 0n && sinceVersion < minAvailableVersion;
}

export const CURRENT_FORMAT_VERSION = 4;
import { compareUtf8 } from '../../../platform/util/portable.ts';
