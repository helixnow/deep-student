// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L20-sync.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** deep_student_lib::data_governance::commands_sync::BatchQuarantineResult */
export type BatchQuarantineResult = {
  success: number;
  failed: number;
  errors: string[];
};
/** deep_student_lib::data_governance::commands_sync::ConflictDetectionResponse */
export type ConflictDetectionResponse = {
  has_conflicts: boolean;
  needs_migration: boolean;
  database_conflicts: DatabaseConflictResponse[];
  record_conflict_count: number;
  local_manifest_json: string | null;
  cloud_manifest_json: string | null;
};
/** deep_student_lib::data_governance::commands_sync::DatabaseConflictResponse */
export type DatabaseConflictResponse = {
  database_name: string;
  conflict_type: string;
  local_version: number | null;
  cloud_version: number | null;
  local_schema_version: number | null;
  cloud_schema_version: number | null;
};
/** deep_student_lib::data_governance::commands_sync::DatabaseSyncStatusResponse */
export type DatabaseSyncStatusResponse = {
  id: string;
  knowledge: SyncStatusKnowledge;
  error: string | null;
  has_change_log: boolean;
  pending_changes: number;
  synced_changes: number;
  last_sync_at: string | null;
};
/** deep_student_lib::data_governance::commands_sync::PruneGapResponse */
export type PruneGapResponse = {
  has_gap: boolean;
  since_version: number;
  min_available_version: number | null;
  remote_format_version: number;
  uses_device_cursors: boolean;
  instance_id: string | null;
  gap_details: string | null;
};
/** deep_student_lib::data_governance::commands_sync::RecordConflictCountEntry */
export type RecordConflictCountEntry = {
  groups: number;
  rows: number;
};
/** deep_student_lib::data_governance::commands_sync::RecordConflictCounts */
export type RecordConflictCounts = {
  per_database: { [key: string]: RecordConflictCountEntry };
  total_groups: number;
  total_rows: number;
};
/** deep_student_lib::data_governance::commands_sync::RecordConflictRow */
export type RecordConflictRow = {
  id: number;
  database_name: string;
  table_name: string;
  record_id: string;
  side: string;
  data_json: string;
  winning_device_id: string | null;
  losing_device_id: string | null;
  detected_at: string;
  resolved_at: string | null;
  resolution: string | null;
};
/** dstu_sync::cloud_storage::repo_check::RepoCheckProblem */
export type RepoCheckProblem = {
  kind: RepoCheckProblemKind;
  objectKey?: string | null;
  versionId?: string | null;
  detail: string;
};
/** dstu_sync::cloud_storage::repo_check::RepoCheckProblemKind */
export type RepoCheckProblemKind = "missingObject" | "checksumMismatch" | "undecodableDsbkHeader" | "plaintextInEncryptedRepo" | "encryptedWithoutMarker" | "orphanObject" | "tempLeftover" | "corruptManifest" | "conflictingManifestEntry" | "corruptEncryptionMarker" | "objectReadFailed";
/** dstu_sync::cloud_storage::repo_check::RepoCheckReport */
export type RepoCheckReport = {
  status: RepoCheckStatus;
  listingTruncated: boolean;
  encryptionMarkerPresent: boolean;
  versionsReferenced: number;
  objectsChecked: number;
  bytesVerified: number;
  orphanObjects: number;
  problems: RepoCheckProblem[];
  problemsTruncated: boolean;
  checkedAt: string;
};
/** dstu_sync::cloud_storage::repo_check::RepoCheckStatus */
export type RepoCheckStatus = "ok" | "problemsFound" | "incomplete";
/** deep_student_lib::data_governance::commands_sync::RollbackSnapshotResponse */
export type RollbackSnapshotResponse = {
  batch_id: string;
  restored: number;
  deleted: number;
  skipped: number;
  undo_batch_id: string;
};
/** deep_student_lib::data_governance::commands_sync::SyncExecutionResponse */
export type SyncExecutionResponse = {
  success: boolean;
  direction: string;
  changes_uploaded: number;
  changes_downloaded: number;
  conflicts_detected: number;
  duration_ms: number;
  device_id: string;
  error_message: string | null;
  skipped_changes: number;
};
/** deep_student_lib::data_governance::commands_sync::SyncExportResponse */
export type SyncExportResponse = {
  success: boolean;
  output_path: string;
  manifest_databases: number;
  pending_changes_count: number;
};
/** deep_student_lib::data_governance::commands_sync::SyncImportResponse */
export type SyncImportResponse = {
  success: boolean;
  imported_changes: number;
  conflicts_detected: number;
  needs_manual_resolution: boolean;
  error_message: string | null;
};
/** dstu_sync::data_governance::sync::progress::SyncOutcome */
export type SyncOutcome = "in_progress" | "succeeded" | "failed" | "partial" | "unknown";
/** dstu_sync::data_governance::sync::progress::SyncPhase */
export type SyncPhase = "preparing" | "detecting_changes" | "uploading" | "downloading" | "applying" | "completed" | "failed";
/** dstu_sync::data_governance::sync::progress::SyncProgress */
export type SyncProgress = {
  operation_id?: string | null;
  outcome?: SyncOutcome | null;
  phase: SyncPhase;
  percent: number;
  current: number;
  total: number;
  current_item: string | null;
  speed_bytes_per_sec: number | null;
  eta_seconds: number | null;
  error: string | null;
};
/** deep_student_lib::data_governance::commands_sync::SyncQuarantineRow */
export type SyncQuarantineRow = {
  id: number;
  database_name: string;
  source_device_id: string;
  source_seq: number;
  table_name: string;
  record_id: string;
  operation: string;
  payload_json: string | null;
  error: string;
  attempts: number;
  first_seen: string;
  last_attempt: string;
};
/** deep_student_lib::data_governance::commands_sync::SyncResultResponse */
export type SyncResultResponse = {
  success: boolean;
  strategy: string;
  synced_databases: number;
  resolved_conflicts: number;
  pending_manual_conflicts: number;
  records_to_push: string[];
  records_to_pull: string[];
  duration_ms: number;
  error_message: string | null;
};
/** deep_student_lib::data_governance::commands_sync::SyncSnapshotBatchRow */
export type SyncSnapshotBatchRow = {
  database_name: string;
  batch_id: string;
  reason: string;
  created_at: string;
  record_count: number;
  rolled_back_at: string | null;
};
/** deep_student_lib::data_governance::commands_sync::SyncStatusKnowledge */
export type SyncStatusKnowledge = "known" | "unknown";
/** deep_student_lib::data_governance::commands_sync::SyncStatusResponse */
export type SyncStatusResponse = {
  partial: boolean;
  errors: string[];
  has_pending_changes: boolean;
  total_pending_changes: number;
  total_synced_changes: number;
  databases: DatabaseSyncStatusResponse[];
  last_sync_at: string | null;
  device_id: string;
};
/** deep_student_lib::data_governance::commands_sync::UnsyncedItem */
export type UnsyncedItem = {
  kind: UnsyncedItemKind;
  scope: string;
  key: string;
  counterpart?: string | null;
  size?: number | null;
  detail: string;
};
/** deep_student_lib::data_governance::commands_sync::UnsyncedItemKind */
export type UnsyncedItemKind = "downloadPending" | "legacyPlaintext" | "caseConflict" | "sanitizedNameConflict" | "invalidKey";
/** deep_student_lib::data_governance::commands_sync::UnsyncedItemsReport */
export type UnsyncedItemsReport = {
  items: UnsyncedItem[];
  itemsTruncated: boolean;
  totalUnsynced: number;
  blobEntriesTotal: number;
  assetEntriesTotal: number;
  encryptionEnabled: boolean;
  generatedAt: string;
};

export interface Commands {
  /** src/data_governance/commands_sync.rs:2810 `data_governance_cancel_sync` */
  data_governance_cancel_sync: {
    args: Record<string, never>;
    result: boolean;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:4550 `data_governance_count_record_conflicts` */
  data_governance_count_record_conflicts: {
    args: Record<string, never>;
    result: RecordConflictCounts;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:1280 `data_governance_detect_conflicts` */
  data_governance_detect_conflicts: {
    args: {
      cloudManifestJson?: string | null;
      cloudConfig?: Shared.CloudStorageConfig | null;
    };
    result: ConflictDetectionResponse;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:5070 `data_governance_detect_prune_gap` */
  data_governance_detect_prune_gap: {
    args: {
      cloudConfig: Shared.CloudStorageConfig;
    };
    result: PruneGapResponse;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:4351 `data_governance_discard_all_quarantine` */
  data_governance_discard_all_quarantine: {
    args: Record<string, never>;
    result: BatchQuarantineResult;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:4256 `data_governance_discard_quarantine` */
  data_governance_discard_quarantine: {
    args: {
      databaseName: string;
      quarantineId: number;
    };
    result: boolean;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:2368 `data_governance_export_sync_data` */
  data_governance_export_sync_data: {
    args: {
      outputPath?: string | null;
    };
    result: SyncExportResponse;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:1025 `data_governance_get_sync_status` */
  data_governance_get_sync_status: {
    args: Record<string, never>;
    result: SyncStatusResponse;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:2570 `data_governance_import_sync_data` */
  data_governance_import_sync_data: {
    args: {
      inputPath: string;
      strategy?: string | null;
    };
    result: SyncImportResponse;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:4167 `data_governance_list_quarantine` */
  data_governance_list_quarantine: {
    args: {
      limit?: number | null;
      offset?: number | null;
    };
    result: SyncQuarantineRow[];
    error: string;
  };
  /** src/data_governance/commands_sync.rs:4406 `data_governance_list_record_conflicts` */
  data_governance_list_record_conflicts: {
    args: {
      limit?: number | null;
      offset?: number | null;
    };
    result: RecordConflictRow[];
    error: string;
  };
  /** src/data_governance/commands_sync.rs:5186 `data_governance_list_sync_snapshot_batches` */
  data_governance_list_sync_snapshot_batches: {
    args: {
      limit?: number | null;
    };
    result: SyncSnapshotBatchRow[];
    error: string;
  };
  /** src/data_governance/commands_sync.rs:5812 `data_governance_list_unsynced_items` */
  data_governance_list_unsynced_items: {
    args: {
      cloudConfig: Shared.CloudStorageConfig;
    };
    result: UnsyncedItemsReport;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:4104 `data_governance_mark_asset_deleted` */
  data_governance_mark_asset_deleted: {
    args: {
      key: string;
      size?: number | null;
      cloudConfig: Shared.CloudStorageConfig;
    };
    result: null;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:4062 `data_governance_mark_blob_deleted` */
  data_governance_mark_blob_deleted: {
    args: {
      hash: string;
      relativePath?: string | null;
      size?: number | null;
      cloudConfig: Shared.CloudStorageConfig;
    };
    result: null;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:5010 `data_governance_purge_resolved_conflicts` */
  data_governance_purge_resolved_conflicts: {
    args: {
      olderThanDays?: number | null;
    };
    result: number;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:5150 `data_governance_repo_check` */
  data_governance_repo_check: {
    args: {
      cloudConfig: Shared.CloudStorageConfig;
    };
    result: RepoCheckReport;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:1428 `data_governance_resolve_conflicts` */
  data_governance_resolve_conflicts: {
    args: {
      strategy: string;
      cloudManifestJson: string;
    };
    result: SyncResultResponse;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:4610 `data_governance_resolve_record_conflict` */
  data_governance_resolve_record_conflict: {
    args: {
      databaseName: string;
      tableName: string;
      recordId: string;
      resolution: string;
      mergedDataJson?: string | null;
      expectedConflictIds: number[];
    };
    result: null;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:4293 `data_governance_retry_all_quarantine` */
  data_governance_retry_all_quarantine: {
    args: Record<string, never>;
    result: BatchQuarantineResult;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:4232 `data_governance_retry_quarantine` */
  data_governance_retry_quarantine: {
    args: {
      databaseName: string;
      quarantineId: number;
    };
    result: boolean;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:5244 `data_governance_rollback_sync_snapshot_batch` */
  data_governance_rollback_sync_snapshot_batch: {
    args: {
      databaseName: string;
      batchId: string;
    };
    result: RollbackSnapshotResponse;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:1585 `data_governance_run_sync` */
  data_governance_run_sync: {
    args: {
      direction: string;
      cloudConfig?: Shared.CloudStorageConfig | null;
      strategy?: string | null;
    };
    result: SyncExecutionResponse;
    error: string;
  };
  /** src/data_governance/commands_sync.rs:2858 `data_governance_run_sync_with_progress` */
  data_governance_run_sync_with_progress: {
    args: {
      direction: string;
      cloudConfig?: Shared.CloudStorageConfig | null;
      strategy?: string | null;
    };
    result: SyncExecutionResponse;
    error: string;
  };
}

export interface Events {
  "data-governance-sync-progress": SyncProgress;
}

export type CommandName = keyof Commands;
export type DataGovernanceCancelSyncCommandArgs = Commands['data_governance_cancel_sync']['args'];
export type DataGovernanceCancelSyncCommandResult = Commands['data_governance_cancel_sync']['result'];
export type DataGovernanceCountRecordConflictsCommandArgs = Commands['data_governance_count_record_conflicts']['args'];
export type DataGovernanceCountRecordConflictsCommandResult = Commands['data_governance_count_record_conflicts']['result'];
export type DataGovernanceDetectConflictsCommandArgs = Commands['data_governance_detect_conflicts']['args'];
export type DataGovernanceDetectConflictsCommandResult = Commands['data_governance_detect_conflicts']['result'];
export type DataGovernanceDetectPruneGapCommandArgs = Commands['data_governance_detect_prune_gap']['args'];
export type DataGovernanceDetectPruneGapCommandResult = Commands['data_governance_detect_prune_gap']['result'];
export type DataGovernanceDiscardAllQuarantineCommandArgs = Commands['data_governance_discard_all_quarantine']['args'];
export type DataGovernanceDiscardAllQuarantineCommandResult = Commands['data_governance_discard_all_quarantine']['result'];
export type DataGovernanceDiscardQuarantineCommandArgs = Commands['data_governance_discard_quarantine']['args'];
export type DataGovernanceDiscardQuarantineCommandResult = Commands['data_governance_discard_quarantine']['result'];
export type DataGovernanceExportSyncDataCommandArgs = Commands['data_governance_export_sync_data']['args'];
export type DataGovernanceExportSyncDataCommandResult = Commands['data_governance_export_sync_data']['result'];
export type DataGovernanceGetSyncStatusCommandArgs = Commands['data_governance_get_sync_status']['args'];
export type DataGovernanceGetSyncStatusCommandResult = Commands['data_governance_get_sync_status']['result'];
export type DataGovernanceImportSyncDataCommandArgs = Commands['data_governance_import_sync_data']['args'];
export type DataGovernanceImportSyncDataCommandResult = Commands['data_governance_import_sync_data']['result'];
export type DataGovernanceListQuarantineCommandArgs = Commands['data_governance_list_quarantine']['args'];
export type DataGovernanceListQuarantineCommandResult = Commands['data_governance_list_quarantine']['result'];
export type DataGovernanceListRecordConflictsCommandArgs = Commands['data_governance_list_record_conflicts']['args'];
export type DataGovernanceListRecordConflictsCommandResult = Commands['data_governance_list_record_conflicts']['result'];
export type DataGovernanceListSyncSnapshotBatchesCommandArgs = Commands['data_governance_list_sync_snapshot_batches']['args'];
export type DataGovernanceListSyncSnapshotBatchesCommandResult = Commands['data_governance_list_sync_snapshot_batches']['result'];
export type DataGovernanceListUnsyncedItemsCommandArgs = Commands['data_governance_list_unsynced_items']['args'];
export type DataGovernanceListUnsyncedItemsCommandResult = Commands['data_governance_list_unsynced_items']['result'];
export type DataGovernanceMarkAssetDeletedCommandArgs = Commands['data_governance_mark_asset_deleted']['args'];
export type DataGovernanceMarkAssetDeletedCommandResult = Commands['data_governance_mark_asset_deleted']['result'];
export type DataGovernanceMarkBlobDeletedCommandArgs = Commands['data_governance_mark_blob_deleted']['args'];
export type DataGovernanceMarkBlobDeletedCommandResult = Commands['data_governance_mark_blob_deleted']['result'];
export type DataGovernancePurgeResolvedConflictsCommandArgs = Commands['data_governance_purge_resolved_conflicts']['args'];
export type DataGovernancePurgeResolvedConflictsCommandResult = Commands['data_governance_purge_resolved_conflicts']['result'];
export type DataGovernanceRepoCheckCommandArgs = Commands['data_governance_repo_check']['args'];
export type DataGovernanceRepoCheckCommandResult = Commands['data_governance_repo_check']['result'];
export type DataGovernanceResolveConflictsCommandArgs = Commands['data_governance_resolve_conflicts']['args'];
export type DataGovernanceResolveConflictsCommandResult = Commands['data_governance_resolve_conflicts']['result'];
export type DataGovernanceResolveRecordConflictCommandArgs = Commands['data_governance_resolve_record_conflict']['args'];
export type DataGovernanceResolveRecordConflictCommandResult = Commands['data_governance_resolve_record_conflict']['result'];
export type DataGovernanceRetryAllQuarantineCommandArgs = Commands['data_governance_retry_all_quarantine']['args'];
export type DataGovernanceRetryAllQuarantineCommandResult = Commands['data_governance_retry_all_quarantine']['result'];
export type DataGovernanceRetryQuarantineCommandArgs = Commands['data_governance_retry_quarantine']['args'];
export type DataGovernanceRetryQuarantineCommandResult = Commands['data_governance_retry_quarantine']['result'];
export type DataGovernanceRollbackSyncSnapshotBatchCommandArgs = Commands['data_governance_rollback_sync_snapshot_batch']['args'];
export type DataGovernanceRollbackSyncSnapshotBatchCommandResult = Commands['data_governance_rollback_sync_snapshot_batch']['result'];
export type DataGovernanceRunSyncCommandArgs = Commands['data_governance_run_sync']['args'];
export type DataGovernanceRunSyncCommandResult = Commands['data_governance_run_sync']['result'];
export type DataGovernanceRunSyncWithProgressCommandArgs = Commands['data_governance_run_sync_with_progress']['args'];
export type DataGovernanceRunSyncWithProgressCommandResult = Commands['data_governance_run_sync_with_progress']['result'];
