/** mod.rs:4017-4120. Download orchestration does not apply or acknowledge rows. */
import type { CloudStorage } from '../../sync-providers/api.ts';
import type { SyncStateStore } from '../../sync-support/api.ts';
import type { NativeCompression } from '../../../platform/native/api.ts';
import type { SyncManifest, MergeStrategy } from './merge.ts';
import { detectConflicts, totalConflicts } from './merge.ts';
import { validateUploadSchemaCompatibility, schemaMismatchError } from './manifest-upload.ts';
import { downloadManifest } from './remote-manifest.ts';
import { downloadChanges, type DownloadChangesResult } from './download-changes.ts';
import type { ValidateRemoteFormatOptions } from './remote-format.ts';
import { ManualResolutionRequiredError } from './errors.ts';
export interface PendingChangeSummary<Id extends number | bigint = number | bigint> {
  total_count: number;
  entries: readonly { id: Id }[];
}

export interface SyncExecutionResult {
  success: boolean;
  direction: 'Upload' | 'Download' | 'Bidirectional';
  changes_uploaded: number;
  changes_downloaded: number;
  conflicts_detected: number;
  duration_ms: number;
  error_message: string | null;
}

export async function executeDownload(
  storage: CloudStorage, local: SyncManifest, strategy: MergeStrategy,
  options: ValidateRemoteFormatOptions, openState: () => SyncStateStore, compression: NativeCompression,
): Promise<[SyncExecutionResult, DownloadChangesResult]> {
  const start = performance.now();
  await validateUploadSchemaCompatibility(storage, local, options);
  const cloud = await downloadManifest(storage, options);
  let conflicts = 0;
  if (cloud.sync_transaction_id !== '') {
    const detection = detectConflicts(local, cloud);
    const error = schemaMismatchError(detection);
    if (error !== null) throw error;
    if (detection.has_conflicts && strategy === 'Manual') throw new ManualResolutionRequiredError(totalConflicts(detection));
    conflicts = detection.has_conflicts ? totalConflicts(detection) : 0;
  }
  const perDbSince = new Map(Object.entries(local.databases).map(([name, state]) => [name, BigInt(state.data_version)]));
  let since: bigint | null = null;
  for (const version of perDbSince.values()) if (since === null || version < since) since = version;
  const downloaded = await downloadChanges(storage, since ?? 0n, perDbSince, options, openState, compression);
  const warning = downloaded.decode_failures.length === 0 ? null
    : `检测到 ${downloaded.decode_failures.length} 个云端变更文件解析失败，已跳过并继续同步。`;
  return [{
    success: true, direction: 'Download', changes_uploaded: 0, changes_downloaded: downloaded.changes.length,
    conflicts_detected: conflicts, duration_ms: Math.floor(performance.now() - start), error_message: warning,
  }, downloaded];
}

/** mod.rs:4139-4169: the caller owns upload/apply/ack, even in bidirectional mode. */
export async function executeBidirectional<Id extends number | bigint>(
  storage: CloudStorage, pending: PendingChangeSummary<Id>, local: SyncManifest, strategy: MergeStrategy,
  options: ValidateRemoteFormatOptions, openState: () => SyncStateStore, compression: NativeCompression,
): Promise<[SyncExecutionResult, Id[], DownloadChangesResult]> {
  const start = performance.now();
  const [downloadedResult, changes] = await executeDownload(storage, local, strategy, options, openState, compression);
  return [{
    success: true, direction: 'Bidirectional', changes_uploaded: pending.total_count,
    changes_downloaded: downloadedResult.changes_downloaded, conflicts_detected: downloadedResult.conflicts_detected,
    duration_ms: Math.floor(performance.now() - start), error_message: downloadedResult.error_message,
  }, pending.entries.map(entry => entry.id), changes];
}
