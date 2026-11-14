// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L21-backup-governance.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** deep_student_lib::data_governance::commands_asset::AssetScanResponse */
export type AssetScanResponse = {
  by_type: { [key: string]: AssetTypeStats };
  total_files: number;
  total_size: number;
};
/** deep_student_lib::data_governance::commands_asset::AssetTypeInfo */
export type AssetTypeInfo = {
  id: string;
  name: string;
  relative_path: string;
  priority: number;
};
/** dstu_sync::data_governance::backup::assets::AssetTypeStats */
export type AssetTypeStats = {
  file_count: number;
  total_size: number;
};
/** deep_student_lib::data_governance::commands_asset::AssetVerifyErrorResponse */
export type AssetVerifyErrorResponse = {
  path: string;
  error_type: string;
  message: string;
};
/** deep_student_lib::data_governance::commands_types::AuditLogPagedResponse */
export type AuditLogPagedResponse = {
  logs: AuditLogResponse[];
  total: number;
};
/** deep_student_lib::data_governance::commands_types::AuditLogResponse */
export type AuditLogResponse = {
  id: string;
  timestamp: string;
  operation_type: string;
  target: string;
  status: string;
  duration_ms: number | null;
  error_message: string | null;
};
/** deep_student_lib::data_governance::commands_backup::AutoVerifyResponse */
export type AutoVerifyResponse = {
  backup_id: string;
  is_valid: boolean;
  verified_at: string;
  duration_ms: number;
  databases_verified: DatabaseVerifyStatus[];
  errors: string[];
};
/** deep_student_lib::data_governance::commands_backup::BackupInfoResponse */
export type BackupInfoResponse = {
  path: string;
  created_at: string;
  size: number;
  backup_type: string;
  recovery_kind: string;
  restorable: boolean;
  databases: string[];
};
/** dstu_sync::backup_job_manager::BackupJobResultPayload */
export type BackupJobResultPayload = {
  success: boolean;
  output_path: string | null;
  resolved_path?: string | null;
  message: string | null;
  error: string | null;
  duration_ms: number | null;
  stats?: unknown | null;
  requires_restart: boolean;
  checkpoint_path?: string | null;
  resumable_job_id?: string | null;
};
/** deep_student_lib::data_governance::commands_backup::BackupJobStartResponse */
export type BackupJobStartResponse = {
  job_id: string;
  kind: string;
  status: string;
  message: string;
};
/** dstu_sync::backup_job_manager::BackupJobSummary */
export type BackupJobSummary = {
  job_id: string;
  kind: Shared.BackupJobKind;
  status: Shared.BackupJobStatus;
  phase: Shared.BackupJobPhase;
  progress: number;
  message: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  result?: BackupJobResultPayload | null;
  resumable: boolean;
};
/** deep_student_lib::data_governance::commands_backup::BackupVerifyResponse */
export type BackupVerifyResponse = {
  is_valid: boolean;
  checksum_match: boolean;
  databases_verified: DatabaseVerifyStatus[];
  errors: string[];
};
/** deep_student_lib::data_governance::commands_asset::BackupVerifyWithAssetsResponse */
export type BackupVerifyWithAssetsResponse = {
  is_valid: boolean;
  database_errors: string[];
  asset_errors: AssetVerifyErrorResponse[];
  has_assets: boolean;
  asset_file_count: number;
};
/** dstu_sync::cloud_config_commands::CloudConfigDraftTestResponse */
export type CloudConfigDraftTestResponse = {
  ok: boolean;
  generation: number;
};
/** dstu_storage::backup_common::DataGovernanceOperationKind */
export type DataGovernanceOperationKind = "backup" | "auto_backup" | "verify" | "zip_export" | "zip_import" | "restore" | "sync" | "delete_propagation" | "prune";
/** dstu_storage::backup_common::DataGovernanceOperationSnapshot */
export type DataGovernanceOperationSnapshot = {
  operation_id: string;
  kind: DataGovernanceOperationKind;
  started_at: string;
  process_id: number;
};
/** deep_student_lib::data_governance::commands_types::DatabaseDetailResponse */
export type DatabaseDetailResponse = {
  id: string;
  schema_version: number;
  min_compatible_version: number;
  max_compatible_version: number;
  data_contract_version: string;
  checksum: string;
  updated_at: string;
  migration_history: MigrationRecordResponse[];
  dependencies: string[];
};
/** deep_student_lib::data_governance::commands_types::DatabaseHealthStatus */
export type DatabaseHealthStatus = {
  id: string;
  is_healthy: boolean;
  dependencies_met: boolean;
  schema_version: number;
  target_version: number;
  pending_count: number;
  issues: string[];
};
/** deep_student_lib::data_governance::commands_types::DatabaseStatusResponse */
export type DatabaseStatusResponse = {
  id: string;
  schema_version: number;
  min_compatible_version: number;
  max_compatible_version: number;
  data_contract_version: string;
  migration_count: number;
  checksum: string;
  updated_at: string;
};
/** deep_student_lib::data_governance::commands_backup::DatabaseVerifyStatus */
export type DatabaseVerifyStatus = {
  id: string;
  is_valid: boolean;
  error: string | null;
};
/** deep_student_lib::data_governance::commands_backup::DiskSpaceCheckResponse */
export type DiskSpaceCheckResponse = {
  has_enough_space: boolean;
  available_bytes: number;
  required_bytes: number;
  backup_size: number;
};
/** deep_student_lib::data_governance::commands_types::HealthCheckResponse */
export type HealthCheckResponse = {
  overall_healthy: boolean;
  total_databases: number;
  initialized_count: number;
  uninitialized_count: number;
  dependency_check_passed: boolean;
  dependency_error: string | null;
  databases: DatabaseHealthStatus[];
  checked_at: string;
  pending_migrations_count: number;
  has_pending_migrations: boolean;
  audit_log_healthy: boolean;
  audit_log_error: string | null;
  audit_log_error_at: string | null;
};
/** deep_student_lib::data_governance::commands_types::MaintenanceStatusResponse */
export type MaintenanceStatusResponse = {
  is_in_maintenance_mode: boolean;
  blocked_components: string[];
  current_operation: DataGovernanceOperationSnapshot | null;
  component_health: StartupComponentHealth | null;
  component_issues: StartupComponentIssue[];
};
/** deep_student_lib::data_governance::commands_types::MigrationDatabaseStatus */
export type MigrationDatabaseStatus = {
  id: string;
  current_version: number;
  target_version: number;
  is_initialized: boolean;
  last_migration_at: string | null;
  pending_count: number;
  has_pending: boolean;
};
/** deep_student_lib::data_governance::commands_types::MigrationRecordResponse */
export type MigrationRecordResponse = {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
  duration_ms: number | null;
  success: boolean;
};
/** deep_student_lib::data_governance::commands_types::MigrationStatusResponse */
export type MigrationStatusResponse = {
  global_version: number;
  all_healthy: boolean;
  databases: MigrationDatabaseStatus[];
  pending_migrations_total: number;
  has_pending_migrations: boolean;
  last_error: string | null;
};
/** deep_student_lib::data_governance::commands_restore::RestoreResultResponse */
export type RestoreResultResponse = {
  success: boolean;
  backup_id: string;
  duration_ms: number;
  databases_restored: string[];
  pre_restore_backup_path: string | null;
  error_message: string | null;
  assets_restored?: number | null;
};
/** deep_student_lib::data_governance::commands_backup::ResumableJobResponse */
export type ResumableJobResponse = {
  job_id: string;
  kind: Shared.BackupJobKind;
  status: Shared.BackupJobStatus;
  phase: Shared.BackupJobPhase;
  progress: number;
  created_at: string;
  started_at?: string | null;
  params: unknown;
  checkpoint?: Shared.JobCheckpoint | null;
  error_message?: string | null;
  requires_password: boolean;
};
/** deep_student_lib::data_governance::commands_types::SchemaRegistryResponse */
export type SchemaRegistryResponse = {
  global_version: number;
  aggregated_at: string;
  databases: DatabaseStatusResponse[];
};
/** deep_student_lib::data_governance::commands::SlotMigrationTestResponse */
export type SlotMigrationTestResponse = {
  success: boolean;
  report: string;
};
/** dstu_storage::data_space::startup_health::StartupComponentHealth */
export type StartupComponentHealth = {
  components: StartupComponentIssue[];
};
/** dstu_storage::data_space::startup_health::StartupComponentIssue */
export type StartupComponentIssue = {
  component: string;
  status: StartupComponentStatus;
  reason: string | null;
  dependency: string | null;
};
/** dstu_storage::data_space::startup_health::StartupComponentStatus */
export type StartupComponentStatus = "healthy" | "degraded" | "blocked";
/** dstu_storage::backup_common::ImportProgress */
export type dstu_storage__backup_common__ImportProgress = {
  phase: string;
  progress: number;
  message: string;
  current_file: string | null;
  total_files: number;
  processed_files: number;
};

/* ---------- 历史导出名（兼容既有 import，勿删） ---------- */
/** 兼容导出：_shared.BackupJobKind（保留旧名） */
export type { BackupJobKind } from './_shared.ts';
/** 兼容导出：_shared.BackupJobPhase（保留旧名） */
export type { BackupJobPhase } from './_shared.ts';
/** 兼容导出：_shared.BackupJobStatus（保留旧名） */
export type { BackupJobStatus } from './_shared.ts';
/** 兼容导出：保留旧名 ImportProgress */
export type ImportProgress = dstu_storage__backup_common__ImportProgress;
/** 兼容导出：_shared.JobCheckpoint（保留旧名） */
export type { JobCheckpoint } from './_shared.ts';
/** 兼容导出：_shared.PersistedJob（保留旧名） */
export type { PersistedJob } from './_shared.ts';

export interface Commands {
  /** crates/dstu-sync/src/cloud_config_commands.rs:765 `cloud_config_test_connection_draft` */
  cloud_config_test_connection_draft: {
    args: {
      config: Shared.SafeCloudStorageConfig__De;
      credentials: Shared.CloudStorageCredentials;
      encryptionPasswordIsPreexisting?: boolean | null;
    };
    result: CloudConfigDraftTestResponse;
    error: Shared.CommandError;
  };
  /** src/data_governance/commands_backup.rs:1494 `data_governance_auto_verify_latest_backup` */
  data_governance_auto_verify_latest_backup: {
    args: Record<string, never>;
    result: AutoVerifyResponse;
    error: string;
  };
  /** src/data_governance/commands_zip.rs:221 `data_governance_backup_and_export_zip` */
  data_governance_backup_and_export_zip: {
    args: {
      outputPath: string;
      compressionLevel?: number | null;
      addToBackupList?: boolean | null;
      useTiered?: boolean | null;
      tiers?: string[] | null;
      includeAssets?: boolean | null;
      assetTypes?: string[] | null;
      encryptionPassword?: string | null;
    };
    result: BackupJobStartResponse;
    error: string;
  };
  /** src/data_governance/commands_backup.rs:2538 `data_governance_backup_tiered` */
  data_governance_backup_tiered: {
    args: {
      tiers?: string[] | null;
      includeDatabases?: string[] | null;
      excludeDatabases?: string[] | null;
      includeAssets?: boolean | null;
      maxAssetSize?: number | null;
      assetTypes?: string[] | null;
    };
    result: BackupJobStartResponse;
    error: string;
  };
  /** src/data_governance/commands_backup.rs:2249 `data_governance_cancel_backup` */
  data_governance_cancel_backup: {
    args: {
      jobId: string;
    };
    result: boolean;
    error: string;
  };
  /** src/data_governance/commands_backup.rs:1320 `data_governance_check_disk_space_for_restore` */
  data_governance_check_disk_space_for_restore: {
    args: {
      backupId: string;
    };
    result: DiskSpaceCheckResponse;
    error: string;
  };
  /** src/data_governance/commands.rs:598 `data_governance_cleanup_audit_logs` */
  data_governance_cleanup_audit_logs: {
    args: {
      keepRecent?: number | null;
      beforeDays?: number | null;
      confirmationToken: string;
    };
    result: number;
    error: string;
  };
  /** src/data_governance/commands_backup.rs:2504 `data_governance_cleanup_persisted_jobs` */
  data_governance_cleanup_persisted_jobs: {
    args: Record<string, never>;
    result: number;
    error: string;
  };
  /** src/data_governance/commands_backup.rs:1271 `data_governance_delete_backup` */
  data_governance_delete_backup: {
    args: {
      backupId: string;
    };
    result: boolean;
    error: string;
  };
  /** src/data_governance/commands_zip.rs:698 `data_governance_export_zip` */
  data_governance_export_zip: {
    args: {
      backupId: string;
      outputPath?: string | null;
      compressionLevel?: number | null;
      includeChecksums?: boolean | null;
      encryptionPassword?: string | null;
      useStoredCloudEncryptionPassword?: boolean | null;
    };
    result: BackupJobStartResponse;
    error: string;
  };
  /** src/data_governance/commands_asset.rs:79 `data_governance_get_asset_types` */
  data_governance_get_asset_types: {
    args: Record<string, never>;
    result: AssetTypeInfo[];
    error: never;
  };
  /** src/data_governance/commands.rs:529 `data_governance_get_audit_logs` */
  data_governance_get_audit_logs: {
    args: {
      operationType?: string | null;
      status?: string | null;
      limit?: number | null;
      offset?: number | null;
    };
    result: AuditLogPagedResponse;
    error: string;
  };
  /** src/data_governance/commands_backup.rs:2281 `data_governance_get_backup_job` */
  data_governance_get_backup_job: {
    args: {
      jobId: string;
    };
    result: BackupJobSummary | null;
    error: string;
  };
  /** src/data_governance/commands_backup.rs:1193 `data_governance_get_backup_list` */
  data_governance_get_backup_list: {
    args: Record<string, never>;
    result: BackupInfoResponse[];
    error: string;
  };
  /** src/data_governance/commands.rs:1005 `data_governance_get_database_status` */
  data_governance_get_database_status: {
    args: {
      databaseId: string;
    };
    result: DatabaseDetailResponse | null;
    error: string;
  };
  /** src/data_governance/commands.rs:430 `data_governance_get_maintenance_status` */
  data_governance_get_maintenance_status: {
    args: Record<string, never>;
    result: MaintenanceStatusResponse;
    error: string;
  };
  /** src/data_governance/commands.rs:1060 `data_governance_get_migration_diagnostic_report` */
  data_governance_get_migration_diagnostic_report: {
    args: Record<string, never>;
    result: string;
    error: string;
  };
  /** src/data_governance/commands.rs:738 `data_governance_get_migration_status` */
  data_governance_get_migration_status: {
    args: Record<string, never>;
    result: MigrationStatusResponse;
    error: string;
  };
  /** src/data_governance/commands.rs:499 `data_governance_get_schema_registry` */
  data_governance_get_schema_registry: {
    args: Record<string, never>;
    result: SchemaRegistryResponse;
    error: string;
  };
  /** src/data_governance/commands_zip.rs:1209 `data_governance_import_zip` */
  data_governance_import_zip: {
    args: {
      zipPath: string;
      backupId?: string | null;
      password?: string | null;
      useStoredCloudEncryptionPassword?: boolean | null;
    };
    result: BackupJobStartResponse;
    error: string;
  };
  /** src/data_governance/commands_backup.rs:2299 `data_governance_list_backup_jobs` */
  data_governance_list_backup_jobs: {
    args: Record<string, never>;
    result: BackupJobSummary[];
    error: string;
  };
  /** src/data_governance/commands_backup.rs:2355 `data_governance_list_resumable_jobs` */
  data_governance_list_resumable_jobs: {
    args: Record<string, never>;
    result: ResumableJobResponse[];
    error: string;
  };
  /** src/data_governance/commands_backup.rs:3047 `data_governance_purge_all_data` */
  data_governance_purge_all_data: {
    args: Record<string, never>;
    result: string;
    error: string;
  };
  /** src/data_governance/commands_restore.rs:420 `data_governance_restore_backup` */
  data_governance_restore_backup: {
    args: {
      backupId: string;
      restoreAssets?: boolean | null;
    };
    result: BackupJobStartResponse;
    error: string;
  };
  /** src/data_governance/commands_asset.rs:116 `data_governance_restore_with_assets` */
  data_governance_restore_with_assets: {
    args: {
      backupId: string;
      restoreAssets?: boolean | null;
    };
    result: RestoreResultResponse;
    error: string;
  };
  /** src/data_governance/commands_backup.rs:2395 `data_governance_resume_backup_job` */
  data_governance_resume_backup_job: {
    args: {
      jobId: string;
      password?: string | null;
    };
    result: BackupJobStartResponse;
    error: string;
  };
  /** src/data_governance/commands_backup.rs:1737 `data_governance_run_backup` */
  data_governance_run_backup: {
    args: {
      backupType?: string | null;
      baseVersion?: string | null;
      includeAssets?: boolean | null;
      assetTypes?: string[] | null;
    };
    result: BackupJobStartResponse;
    error: string;
  };
  /** src/data_governance/commands.rs:822 `data_governance_run_health_check` */
  data_governance_run_health_check: {
    args: Record<string, never>;
    result: HealthCheckResponse;
    error: string;
  };
  /** src/data_governance/commands.rs:1279 `data_governance_run_slot_c_empty_db_test` */
  data_governance_run_slot_c_empty_db_test: {
    args: Record<string, never>;
    result: SlotMigrationTestResponse;
    error: string;
  };
  /** src/data_governance/commands.rs:1288 `data_governance_run_slot_d_clone_db_test` */
  data_governance_run_slot_d_clone_db_test: {
    args: Record<string, never>;
    result: SlotMigrationTestResponse;
    error: string;
  };
  /** src/data_governance/commands_asset.rs:24 `data_governance_scan_assets` */
  data_governance_scan_assets: {
    args: {
      assetTypes?: string[] | null;
    };
    result: AssetScanResponse;
    error: string;
  };
  /** src/data_governance/commands_backup.rs:1403 `data_governance_verify_backup` */
  data_governance_verify_backup: {
    args: {
      backupId: string;
    };
    result: BackupVerifyResponse;
    error: string;
  };
  /** src/data_governance/commands_asset.rs:138 `data_governance_verify_backup_with_assets` */
  data_governance_verify_backup_with_assets: {
    args: {
      backupId: string;
    };
    result: BackupVerifyWithAssetsResponse;
    error: string;
  };
}

export interface Events {
  "backup-import-progress": dstu_storage__backup_common__ImportProgress;
  "backup-job-progress": unknown /* x-unresolved: payload type of `snapshot.clone(..)` not determinable statically */;
}

export type CommandName = keyof Commands;
export type CloudConfigTestConnectionDraftCommandArgs = Commands['cloud_config_test_connection_draft']['args'];
export type CloudConfigTestConnectionDraftCommandResult = Commands['cloud_config_test_connection_draft']['result'];
export type DataGovernanceAutoVerifyLatestBackupCommandArgs = Commands['data_governance_auto_verify_latest_backup']['args'];
export type DataGovernanceAutoVerifyLatestBackupCommandResult = Commands['data_governance_auto_verify_latest_backup']['result'];
export type DataGovernanceBackupAndExportZipCommandArgs = Commands['data_governance_backup_and_export_zip']['args'];
export type DataGovernanceBackupAndExportZipCommandResult = Commands['data_governance_backup_and_export_zip']['result'];
export type DataGovernanceBackupTieredCommandArgs = Commands['data_governance_backup_tiered']['args'];
export type DataGovernanceBackupTieredCommandResult = Commands['data_governance_backup_tiered']['result'];
export type DataGovernanceCancelBackupCommandArgs = Commands['data_governance_cancel_backup']['args'];
export type DataGovernanceCancelBackupCommandResult = Commands['data_governance_cancel_backup']['result'];
export type DataGovernanceCheckDiskSpaceForRestoreCommandArgs = Commands['data_governance_check_disk_space_for_restore']['args'];
export type DataGovernanceCheckDiskSpaceForRestoreCommandResult = Commands['data_governance_check_disk_space_for_restore']['result'];
export type DataGovernanceCleanupAuditLogsCommandArgs = Commands['data_governance_cleanup_audit_logs']['args'];
export type DataGovernanceCleanupAuditLogsCommandResult = Commands['data_governance_cleanup_audit_logs']['result'];
export type DataGovernanceCleanupPersistedJobsCommandArgs = Commands['data_governance_cleanup_persisted_jobs']['args'];
export type DataGovernanceCleanupPersistedJobsCommandResult = Commands['data_governance_cleanup_persisted_jobs']['result'];
export type DataGovernanceDeleteBackupCommandArgs = Commands['data_governance_delete_backup']['args'];
export type DataGovernanceDeleteBackupCommandResult = Commands['data_governance_delete_backup']['result'];
export type DataGovernanceExportZipCommandArgs = Commands['data_governance_export_zip']['args'];
export type DataGovernanceExportZipCommandResult = Commands['data_governance_export_zip']['result'];
export type DataGovernanceGetAssetTypesCommandArgs = Commands['data_governance_get_asset_types']['args'];
export type DataGovernanceGetAssetTypesCommandResult = Commands['data_governance_get_asset_types']['result'];
export type DataGovernanceGetAuditLogsCommandArgs = Commands['data_governance_get_audit_logs']['args'];
export type DataGovernanceGetAuditLogsCommandResult = Commands['data_governance_get_audit_logs']['result'];
export type DataGovernanceGetBackupJobCommandArgs = Commands['data_governance_get_backup_job']['args'];
export type DataGovernanceGetBackupJobCommandResult = Commands['data_governance_get_backup_job']['result'];
export type DataGovernanceGetBackupListCommandArgs = Commands['data_governance_get_backup_list']['args'];
export type DataGovernanceGetBackupListCommandResult = Commands['data_governance_get_backup_list']['result'];
export type DataGovernanceGetDatabaseStatusCommandArgs = Commands['data_governance_get_database_status']['args'];
export type DataGovernanceGetDatabaseStatusCommandResult = Commands['data_governance_get_database_status']['result'];
export type DataGovernanceGetMaintenanceStatusCommandArgs = Commands['data_governance_get_maintenance_status']['args'];
export type DataGovernanceGetMaintenanceStatusCommandResult = Commands['data_governance_get_maintenance_status']['result'];
export type DataGovernanceGetMigrationDiagnosticReportCommandArgs = Commands['data_governance_get_migration_diagnostic_report']['args'];
export type DataGovernanceGetMigrationDiagnosticReportCommandResult = Commands['data_governance_get_migration_diagnostic_report']['result'];
export type DataGovernanceGetMigrationStatusCommandArgs = Commands['data_governance_get_migration_status']['args'];
export type DataGovernanceGetMigrationStatusCommandResult = Commands['data_governance_get_migration_status']['result'];
export type DataGovernanceGetSchemaRegistryCommandArgs = Commands['data_governance_get_schema_registry']['args'];
export type DataGovernanceGetSchemaRegistryCommandResult = Commands['data_governance_get_schema_registry']['result'];
export type DataGovernanceImportZipCommandArgs = Commands['data_governance_import_zip']['args'];
export type DataGovernanceImportZipCommandResult = Commands['data_governance_import_zip']['result'];
export type DataGovernanceListBackupJobsCommandArgs = Commands['data_governance_list_backup_jobs']['args'];
export type DataGovernanceListBackupJobsCommandResult = Commands['data_governance_list_backup_jobs']['result'];
export type DataGovernanceListResumableJobsCommandArgs = Commands['data_governance_list_resumable_jobs']['args'];
export type DataGovernanceListResumableJobsCommandResult = Commands['data_governance_list_resumable_jobs']['result'];
export type DataGovernancePurgeAllDataCommandArgs = Commands['data_governance_purge_all_data']['args'];
export type DataGovernancePurgeAllDataCommandResult = Commands['data_governance_purge_all_data']['result'];
export type DataGovernanceRestoreBackupCommandArgs = Commands['data_governance_restore_backup']['args'];
export type DataGovernanceRestoreBackupCommandResult = Commands['data_governance_restore_backup']['result'];
export type DataGovernanceRestoreWithAssetsCommandArgs = Commands['data_governance_restore_with_assets']['args'];
export type DataGovernanceRestoreWithAssetsCommandResult = Commands['data_governance_restore_with_assets']['result'];
export type DataGovernanceResumeBackupJobCommandArgs = Commands['data_governance_resume_backup_job']['args'];
export type DataGovernanceResumeBackupJobCommandResult = Commands['data_governance_resume_backup_job']['result'];
export type DataGovernanceRunBackupCommandArgs = Commands['data_governance_run_backup']['args'];
export type DataGovernanceRunBackupCommandResult = Commands['data_governance_run_backup']['result'];
export type DataGovernanceRunHealthCheckCommandArgs = Commands['data_governance_run_health_check']['args'];
export type DataGovernanceRunHealthCheckCommandResult = Commands['data_governance_run_health_check']['result'];
export type DataGovernanceRunSlotCEmptyDbTestCommandArgs = Commands['data_governance_run_slot_c_empty_db_test']['args'];
export type DataGovernanceRunSlotCEmptyDbTestCommandResult = Commands['data_governance_run_slot_c_empty_db_test']['result'];
export type DataGovernanceRunSlotDCloneDbTestCommandArgs = Commands['data_governance_run_slot_d_clone_db_test']['args'];
export type DataGovernanceRunSlotDCloneDbTestCommandResult = Commands['data_governance_run_slot_d_clone_db_test']['result'];
export type DataGovernanceScanAssetsCommandArgs = Commands['data_governance_scan_assets']['args'];
export type DataGovernanceScanAssetsCommandResult = Commands['data_governance_scan_assets']['result'];
export type DataGovernanceVerifyBackupCommandArgs = Commands['data_governance_verify_backup']['args'];
export type DataGovernanceVerifyBackupCommandResult = Commands['data_governance_verify_backup']['result'];
export type DataGovernanceVerifyBackupWithAssetsCommandArgs = Commands['data_governance_verify_backup_with_assets']['args'];
export type DataGovernanceVerifyBackupWithAssetsCommandResult = Commands['data_governance_verify_backup_with_assets']['result'];
