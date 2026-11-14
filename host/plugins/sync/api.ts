import type {} from '@deepseek-ai/cordis';
import type { BatchQuarantineResult, RecordConflictCounts, RecordConflictRow, RollbackSnapshotResponse, SyncExportResponse, SyncImportResponse, SyncQuarantineRow, SyncSnapshotBatchRow, SyncStatusResponse } from '../../../contracts/ipc/generated/L20-sync.ts';
import type { DatabaseHandle } from '../../platform/storage/api.ts';
import type { CloudStorage, RuntimeCloudStorageConfig, UploadProgressCallback } from '../sync-providers/api.ts';
import type { SyncExecutionResponse, UnsyncedItemsReport } from '../../../contracts/ipc/generated/L20-sync.ts';
import type { PayloadCodec } from './src/payload.ts';
import type { SyncFormatDescriptor } from './src/remote-format.ts';
import type { ChangeLogAvailability, SyncCursorStore } from './src/change-availability.ts';
import type { DownloadChangesResult } from './src/download-changes.ts';
import type { SyncExecutionResult } from './src/execute-download.ts';
export type { SyncExecutionResult };
import type { EngineChange } from './src/change-payload.ts';
export type { EngineChange };
export type { DownloadChangesResult };
export type { PayloadCodec, SyncFormatDescriptor, ChangeLogAvailability, SyncCursorStore };
export { createPayloadCodec } from './src/payload.ts';
export type { FilePayloadCodec } from './src/payload.ts';
export type { AsyncTombstoneReader, AsyncWorkspaceTombstones, AsyncBlobTombstones, AsyncAssetTombstones, AsyncTombstoneWriter } from './src/tombstone-needs.ts';
export type { SyncMutationPermit, SyncGlobalLimiter, SyncAwaitingGlobalLimiter } from './src/limiter-needs.ts';
export type { SyncCommandPorts, SyncAuditRequest } from './src/sync-command-needs.ts';
export type { SyncDatabaseApplication } from './src/record-progress.ts';
export type { ApplyToDatabasesResult } from './repository/apply-databases.ts';
import type { SyncProgressEmitter } from './src/emitter.ts';
import type { DbJson } from '../../platform/util/lossless-json.ts';
export type { DbJson } from '../../platform/util/lossless-json.ts';
/** Shared lossless boundary for syncSupport; keep all parsing/comparison in this implementation. */
export { JsonFloat, isJsonFloat, isJsonObject, parseJsonLossless, stringifyJsonLossless, dbJsonEquals, cloneDbJson } from '../../platform/util/lossless-json.ts';
export { sqliteValueToJson } from './repository/sqlite-values.ts';
export { canonicalizeSyncValueForCompare } from './repository/record-data.ts';
/** field_merge.rs:95 merge_field; the same implementation the apply paths call, returning `[value, wasMerged, isConflict]`. */
export { mergeField } from './src/field-merge.ts';
export type { MergeResult, LearnerProfileMerger } from './src/field-merge.ts';
export * from './src/hlc.ts';
export * from './src/fractional-index.ts';
export * from './src/version-vector.ts';
export * from './src/unknown-fields.ts';
export * from './repository/v5-vaults.ts';
export * from './src/plugin-sync-sandbox.ts';
export * from './src/dspair2.ts';
export * from './src/v5-runtime-bridge.ts';
export { runSyncV5 } from './src/run-sync.ts';
import type { ChangeLogEntry, PendingChanges } from './src/change-log.ts';
import type { RollbackOutcome } from './src/history.ts';
import type {
  ConflictDetectionResult,
  ConflictRecord,
  DatabaseSyncState,
  MergeApplicationResult,
  MergeStrategy,
  SyncManifest,
} from './src/merge.ts';
import type { ApplyChangeFailure, ApplyChangesResult } from './repository/apply-shared.ts';
import type { ConflictAwareApplyResult, ConflictGuardOptions } from './repository/apply-guard.ts';
import type { ForceExactHooks } from './repository/apply-force.ts';
import type { DatabaseSyncStateSnapshot } from './repository/record-data.ts';
import type { ConflictPolicy } from './repository/conflict-resolver.ts';

export type {
  ApplyChangeFailure,
  ApplyChangesResult,
  ChangeLogEntry,
  ConflictAwareApplyResult,
  ConflictDetectionResult,
  ConflictGuardOptions,
  ConflictPolicy,
  ConflictRecord,
  DatabaseSyncState,
  DatabaseSyncStateSnapshot,
  ForceExactHooks,
  MergeApplicationResult,
  MergeStrategy,
  PendingChanges,
  RollbackOutcome,
  SyncManifest,
};

export type * from '../../../contracts/ipc/generated/L20-sync.ts';

/** Rust sync/mod.rs:9734,9769; wire fields retain serde names. */
export type ChangeOperation = 'Insert' | 'Update' | 'Delete';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface SyncChangeWithData {
  table_name: string;
  record_id: string;
  operation: ChangeOperation;
  data: JsonValue | null;
  changed_at: string;
  change_log_id?: number | null;
  database_name?: string | null;
  suppress_change_log?: boolean | null;
  source_device_id?: string | null;
  source_seq?: number | null;
}

/** Legacy HLC representation is internal; bigint preserves Rust u64. */
export interface HlcValue {
  readonly millis: bigint;
  readonly counter: number;
  toString(): string;
  toU64(): bigint;
}

/**
 * 引擎批量应用选项，对应 Rust `apply_downloaded_changes*` 的上下文参数。
 * 日志与笔记历史钩子由插件接线时注入，消费方不需要（也不应该）提供。
 */
export interface EngineApplyOptions {
  /** 本地设备 ID，用于 LWW 平局与 DELETE 版本账本。 */
  deviceId: string;
  /** 非 `id` 主键列映射（`id_column_map`）。 */
  idColumnMap?: ReadonlyMap<string, string> | null;
  /** 仅测试替代 Rust `#[cfg(test)]` 的表名豁免；生产调用方不得设置。 */
  allowSyncTestFixtureTables?: boolean;
}

export const syncService = { name: 'sync', version: '1.0.0' } as const;

/** Additive sync surface; members are published as their implementation lands. */
export interface SyncService {
  createPairingCode(args: import('./src/device-pairing.ts').CreatePairingArgs): ReturnType<typeof import('./src/device-pairing.ts').createPairingCode>;
  applyPairingCode(args: import('./src/device-pairing.ts').ApplyPairingArgs): ReturnType<typeof import('./src/device-pairing.ts').applyPairingCode>;
  /** `signal` aborting, or the sync plugin stopping, cancels this run at the next provider cancellation point (Rust drop / CancellationToken). */
  runSync(direction: string, cloudConfig?: RuntimeCloudStorageConfig | null, strategy?: string | null, signal?: AbortSignal | null): Promise<SyncExecutionResponse>;
  runSyncWithProgress(direction: string, cloudConfig?: RuntimeCloudStorageConfig | null, strategy?: string | null, signal?: AbortSignal | null): Promise<SyncExecutionResponse>;
  markBlobDeleted(config: RuntimeCloudStorageConfig, hash: string, relativePath: string | null, size: bigint | null): Promise<void>;
  markAssetDeleted(config: RuntimeCloudStorageConfig, key: string, size: bigint | null): Promise<void>;
  listUnsyncedItems(config: RuntimeCloudStorageConfig): Promise<UnsyncedItemsReport>;
  /** state.rs:528: reset only consumed state after successful local purge, preserving upload sequences. */
  resetDefaultAfterLocalPurge(): void | Promise<void>;
  importSyncData(inputPath: string, strategy?: string | null): Promise<SyncImportResponse>;
  resolveRecordConflict(args: import('./src/mutation-commands.ts').ResolveConflictArgs): void;
  rollbackSyncSnapshotBatch(databaseName: string, batchId: string): RollbackSnapshotResponse;
  /** commands_backup.rs:374: route/apply all databases; rejects any non-durable target before callers may acknowledge cursors. */
  applyDownloadedChangesToDatabases(changes: readonly EngineChange[], strategy: MergeStrategy): Promise<import('./repository/apply-databases.ts').ApplyToDatabasesResult>;
  /** mod.rs:3819: persist cursor candidates after durable apply; no row application. */
  commitDownloadProgress(storage: CloudStorage, downloaded: DownloadChangesResult, options: {
    deviceId: string; codec: PayloadCodec;
  }): Promise<void>;
  /** mod.rs:8390: preserve local DELETE versions before archiving change-log rows. */
  prepareDeleteVersionsForCleanup(db: DatabaseHandle, localDeviceId: string): void;
  /** mod.rs:4139: download only; caller applies rows and publishes enriched local changes. */
  executeBidirectional(storage: CloudStorage, pending: PendingChanges, local: SyncManifest, strategy: MergeStrategy, options: {
    deviceId: string; codec: PayloadCodec;
  }): Promise<[SyncExecutionResult, Array<number | bigint>, DownloadChangesResult]>;
  /** mod.rs:2456: encrypted compressed shards, verified before publishing sequence. */
  uploadEnrichedChanges(storage: CloudStorage, changes: readonly EngineChange[], options: {
    deviceId: string; codec: PayloadCodec;
  }, progress?: UploadProgressCallback | null): Promise<void>;
  /** mod.rs:4017: schema/manual gate, manifest merge and download without applying. */
  executeDownload(storage: CloudStorage, local: SyncManifest, strategy: MergeStrategy, options: {
    deviceId: string; codec: PayloadCodec;
  }): Promise<[SyncExecutionResult, DownloadChangesResult]>;
  /** mod.rs:2725: verified contiguous download; returns candidates without acknowledging. */
  downloadChanges(storage: CloudStorage, sinceVersion: bigint, perDbSince: ReadonlyMap<string, bigint> | null, options: {
    deviceId: string; codec: PayloadCodec;
  }): Promise<DownloadChangesResult>;
  /** mod.rs:1908: reject cloud schema downgrade, including duplicate device aliases. */
  validateUploadSchemaCompatibility(storage: CloudStorage, manifest: SyncManifest, options: {
    deviceId: string; codec: PayloadCodec;
  }): Promise<void>;
  /** mod.rs:1944: publish a verified per-device manifest using the shared state service. */
  uploadManifest(storage: CloudStorage, manifest: SyncManifest, options: {
    deviceId: string; codec: PayloadCodec;
  }): Promise<void>;
  /** Format gate must precede all remote protocol writes. */
  validateRemoteFormat(storage: CloudStorage, willWrite: boolean, options: {
    deviceId: string; codec: PayloadCodec;
  }): Promise<SyncFormatDescriptor>;
  /** Remote read-only preflight; L20b supplies instance-bound cursor persistence. */
  detectChangeLogGaps(storage: CloudStorage, options: {
    deviceId: string; codec: PayloadCodec;
  }, openState: () => SyncCursorStore): Promise<ChangeLogAvailability>;
  parseHlc(value: string): HlcValue | null;
  createHlc(millis: bigint, counter: number): HlcValue;
  countRecordConflicts(): RecordConflictCounts;
  discardQuarantine(databaseName: string, quarantineId: number): boolean;
  discardAllQuarantine(): BatchQuarantineResult;
  getSyncStatus(): Promise<SyncStatusResponse>;
  listSyncSnapshotBatches(limit?: number | null): SyncSnapshotBatchRow[];
  purgeResolvedConflicts(olderThanDays?: number | null): number;
  listQuarantine(limit?: number | null, offset?: number | null): SyncQuarantineRow[];
  listRecordConflicts(limit?: number | null, offset?: number | null): RecordConflictRow[];
  resolveConflicts(strategy: string, cloudManifestJson: string): never;
  retryQuarantine(databaseName: string, quarantineId: number): Promise<boolean>;
  retryAllQuarantine(): Promise<BatchQuarantineResult>;
  exportSyncData(outputPath?: string | null): Promise<SyncExportResponse>;
  cancelSync(): boolean;
  createProgressEmitter(): SyncProgressEmitter;

  // ---------------------------------------------------------------- engine API (L22/L23)
  /** `apply_downloaded_changes`：整批事务 + 单条隔离。 */
  applyDownloadedChanges(
    db: DatabaseHandle,
    changes: readonly EngineChange[],
    options: EngineApplyOptions,
  ): ApplyChangesResult;
  /** `apply_downloaded_changes_with_conflict_guard`：冲突写入 `__sync_conflicts`。 */
  applyDownloadedChangesWithConflictGuard(
    db: DatabaseHandle,
    changes: readonly EngineChange[],
    options: EngineApplyOptions,
    guard: ConflictGuardOptions,
  ): { apply: ApplyChangesResult; conflict: ConflictAwareApplyResult };
  /** `apply_downloaded_changes_force_exact_with_hooks`：显式裁决后的强制套用。 */
  applyDownloadedChangesForceExactWithHooks(
    db: DatabaseHandle,
    changes: readonly EngineChange[],
    options: EngineApplyOptions,
    hooks?: ForceExactHooks,
  ): ApplyChangesResult;
  /** 查询 `__change_log` 中 `sync_version = 0` 的待上传变更。 */
  getPendingChanges(db: DatabaseHandle, tableFilter?: string | null, limit?: number | null): PendingChanges;
  /** 仅保留属于指定数据库的待同步变更。 */
  filterPendingChangesForDatabase(pending: PendingChanges, databaseName: string): PendingChanges;
  /** 用当前记录数据补全变更（上传路径）。 */
  enrichChangesWithData(
    db: DatabaseHandle,
    entries: readonly ChangeLogEntry[],
    idColumnMap?: ReadonlyMap<string, string> | null,
  ): EngineChange[];
  /** `get_record_data`：按主键读取记录（无记录返回 null）。 */
  getRecordData(db: DatabaseHandle, tableName: string, recordId: string, idColumn: string): DbJson | null;
  /** `records_semantically_equal_for_sync`。 */
  recordsSemanticallyEqualForSync(local: DbJson, cloud: DbJson): boolean;
  /** `get_database_sync_state`：变更日志版本/校验和/最后更新时间。 */
  getDatabaseSyncState(db: DatabaseHandle, databaseName: string): DatabaseSyncStateSnapshot;
  /**
   * `reset_sync_baseline_after_restore`：备份恢复后重建待上传基线。
   * 返回值按 Rust 顺序 `[cleaned_change_log_rows, touched_business_records]`。
   */
  resetSyncBaselineAfterRestore(db: DatabaseHandle): [cleaned: number, touched: number];
  /** `mark_synced_with_timestamp`：把已上传变更标记为已同步。 */
  markSyncedWithTimestamp(db: DatabaseHandle, changeIds: readonly (number | bigint)[]): number;
  /** `cleanup_synced_changes`：清理指定时间之前的已同步日志。 */
  cleanupSyncedChanges(db: DatabaseHandle, olderThan: string): number;
  /** `history::rollback_batch`：按快照批次回退单个数据库。 */
  rollbackBatch(
    db: DatabaseHandle,
    batchId: string,
    idColumnMap?: ReadonlyMap<string, string> | null,
    databaseName?: string | null,
  ): RollbackOutcome;
  /** `has_prune_gap`：本地游标早于云端最小可用版本时存在断层。 */
  hasPruneGap(sinceVersion: bigint, minAvailableVersion?: bigint | null): boolean;
  /** `detect_conflicts`：比较本地/云端清单。 */
  detectConflicts(local: SyncManifest, cloud: SyncManifest): ConflictDetectionResult;
  /** `apply_merge_strategy`：按策略生成合并结果。 */
  applyMergeStrategy(strategy: MergeStrategy, conflicts: readonly ConflictRecord[]): MergeApplicationResult;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sync: SyncService;
  }
}
