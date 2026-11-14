// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/F4-security.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** deep_student_lib::backup_config::AutoBackupStatus */
export type AutoBackupStatus = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextDueAt: string | null;
  lastJobId: string | null;
};
/** deep_student_lib::backup_config::BackupConfig */
export type BackupConfig = {
  backupDirectory: string | null;
  autoBackupEnabled: boolean;
  autoBackupIntervalHours: number;
  maxBackupCount: number | null;
  slimBackup: boolean;
  backupTiers?: BackupTier[] | null;
};
/** deep_student_lib::backup_config::BackupConfig */
export type BackupConfig__De = {
  backupDirectory?: string | null;
  autoBackupEnabled?: boolean;
  autoBackupIntervalHours?: number;
  maxBackupCount?: number | null;
  slimBackup?: boolean;
  backupTiers?: BackupTier__De[] | null;
};
/** dstu_sync::data_governance::backup::BackupTier */
export type BackupTier = "core" | "important" | "rebuildable" | "large_assets";
/** dstu_sync::data_governance::backup::BackupTier */
export type BackupTier__De = ("core" | "core_config_chat" | "important" | "vfs_full" | "rebuildable" | "large_assets" | "large_files") | {
  core: null;
} | {
  core_config_chat: null;
} | {
  important: null;
} | {
  vfs_full: null;
} | {
  rebuildable: null;
} | {
  large_assets: null;
} | {
  large_files: null;
};
/** dstu_sync::cloud_config_commands::CloudConfigPublishResponse */
export type CloudConfigPublishResponse = {
  ok: boolean;
  generation: number;
  provider: string;
  root?: string | null;
  config: SafeCloudStorageConfig;
};
/** dstu_sync::cloud_config_commands::CloudConfigSsotResponse */
export type CloudConfigSsotResponse = {
  configured: boolean;
  provider?: string | null;
  root?: string | null;
  config?: SafeCloudStorageConfig | null;
};
/** dstu_security::secure_store::CloudStorageCredentialStatus */
export type CloudStorageCredentialStatus = {
  webdavPasswordConfigured: boolean;
  s3SecretAccessKeyConfigured: boolean;
  ftpPasswordConfigured: boolean;
  encryptionPasswordConfigured: boolean;
};
/** deep_student_lib::debug_commands::DebugDatabaseStats */
export type DebugDatabaseStats = {
  total_mistakes: number;
  mistakes_with_chat: number;
  total_messages: number;
  messages_with_images: number;
  messages_with_thinking: number;
  messages_with_rag_sources: number;
  messages_with_memory_sources: number;
  messages_with_web_sources: number;
  messages_with_persistent_id: number;
};
/** dstu_platform::debug_log_service::DebugLogsInfo */
export type DebugLogsInfo = {
  count: number;
  total_size_bytes: number;
  total_size_display: string;
  oldest_file: string | null;
  newest_file: string | null;
};
/** deep_student_lib::debug_commands::DebugTextbookPageInfo */
export type DebugTextbookPageInfo = {
  textbook_id: string;
  resource_id: string | null;
  file_name: string | null;
  page_count: number | null;
  has_ocr_pages_json: boolean;
  ocr_pages_json_len: number | null;
  has_extracted_text: boolean;
  extracted_text_len: number | null;
};
/** deep_student_lib::diagnostics::DiagnosticsExportOptions */
export type DiagnosticsExportOptions = {
  destination: string;
  includeDebugLogs?: boolean;
};
/** deep_student_lib::diagnostics::DiagnosticsExportResult */
export type DiagnosticsExportResult = {
  path: string;
  fileCount: number;
  skippedCount: number;
  sizeBytes: number;
};
/** deep_student_lib::commands::FrontendLogPayload */
export type FrontendLogPayload = {
  level?: string | null;
  message: string;
  stack?: string | null;
  component?: string | null;
  route?: string | null;
  url?: string | null;
  line?: number | null;
  column?: number | null;
  user_agent?: string | null;
  extra?: unknown | null;
  kind?: string | null;
};
/** dstu_security::secure_store::KeystoreProtectionStatus */
export type KeystoreProtectionStatus = {
  supported: boolean;
  enabled: boolean;
  seedInKeystore: boolean;
};
/** dstu_platform::debug_logger::LogContext */
export type LogContext = {
  userId?: string | null;
  sessionId?: string | null;
  mistakeId?: string | null;
  streamId?: string | null;
  businessId?: string | null;
};
/** dstu_platform::debug_logger::LogEntry */
export type LogEntry = {
  timestamp: string;
  level: LogLevel;
  module: string;
  operation: string;
  data: unknown;
  context?: LogContext | null;
  stackTrace?: string | null;
};
/** dstu_platform::debug_logger::LogLevel */
export type LogLevel = ("DEBUG" | "INFO" | "WARN" | "ERROR" | "TRACE") | {
  DEBUG: null;
} | {
  INFO: null;
} | {
  WARN: null;
} | {
  ERROR: null;
} | {
  TRACE: null;
};
/** deep_student_lib::debug_commands::MigrationRecord */
export type MigrationRecord = {
  version: number;
  name: string;
  applied_at: string;
  success: boolean;
};
/** dstu_sync::cloud_config_commands::SafeCloudStorageConfig */
export type SafeCloudStorageConfig = {
  provider: "webdav";
  webdav: Shared.SafeWebDavConfig;
  root?: string | null;
  allow_insecure?: boolean;
} | {
  provider: "s3";
  s3: SafeS3Config;
  root?: string | null;
  allow_insecure?: boolean;
} | {
  provider: "ftp";
  ftp: SafeFtpConfig;
  root?: string | null;
  allow_insecure?: boolean;
};
/** dstu_sync::cloud_config_commands::SafeFtpConfig */
export type SafeFtpConfig = {
  host: string;
  port: number;
  username: string;
  useTls: boolean;
};
/** dstu_sync::cloud_config_commands::SafeS3Config */
export type SafeS3Config = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  region?: string | null;
  pathStyle: boolean;
};
/** dstu_platform::secret_prompt::SecretPromptHandle */
export type SecretPromptHandle = {
  handleId: string;
  purpose: string;
  expiresInSeconds: number;
  memoryOnly: boolean;
  oneShot: boolean;
  consumerAvailable: boolean;
};
/** dstu_platform::secret_prompt::SecretPromptSubmitRequest */
export type SecretPromptSubmitRequest = {
  purpose: string;
  secret: SecretValue;
  ttlSeconds?: number | null;
};
/** dstu_platform::secret_prompt::SecretValue */
export type SecretValue = string;
/** deep_student_lib::debug_commands::VfsMigrationDiagnostic */
export type VfsMigrationDiagnostic = {
  recorded_version: number;
  expected_version: number;
  migration_history: MigrationRecord[];
  resources_columns: string[];
  missing_index_columns: string[];
  vfs_index_units_exists: boolean;
  vfs_index_segments_exists: boolean;
  vfs_indexing_config_exists: boolean;
  diagnosis: string;
  suggested_fix: string;
};

export interface Commands {
  /** src/commands.rs:7118 `auto_install_package_manager` */
  auto_install_package_manager: {
    args: {
      managerType: string;
    };
    result: unknown;
    error: never;
  };
  /** src/commands.rs:7130 `check_all_package_managers` */
  check_all_package_managers: {
    args: Record<string, never>;
    result: unknown;
    error: never;
  };
  /** src/commands.rs:7097 `check_package_manager` */
  check_package_manager: {
    args: {
      command: string;
    };
    result: unknown;
    error: never;
  };
  /** src/commands.rs:7402 `check_test_dependencies` */
  check_test_dependencies: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/commands.rs:625 `cleanup_old_debug_logs` */
  cleanup_old_debug_logs: {
    args: {
      maxAgeDays: number;
    };
    result: number;
    error: Shared.AppError;
  };
  /** src/backup_config.rs:173 `clear_backup_directory` */
  clear_backup_directory: {
    args: Record<string, never>;
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:615 `clear_debug_logs` */
  clear_debug_logs: {
    args: Record<string, never>;
    result: number;
    error: Shared.AppError;
  };
  /** src/cloud_config_commands.rs:27 `cloud_config_publish` */
  cloud_config_publish: {
    args: {
      config: Shared.SafeCloudStorageConfig__De;
      credentials: Shared.CloudStorageCredentials;
      encryptionPasswordIsPreexisting?: boolean | null;
    };
    result: CloudConfigPublishResponse;
    error: Shared.CommandError;
  };
  /** src/cloud_config_commands.rs:47 `cloud_config_ssot_clear` */
  cloud_config_ssot_clear: {
    args: Record<string, never>;
    result: CloudConfigSsotResponse;
    error: Shared.CommandError;
  };
  /** src/cloud_config_commands.rs:18 `cloud_config_ssot_get` */
  cloud_config_ssot_get: {
    args: Record<string, never>;
    result: CloudConfigSsotResponse;
    error: Shared.CommandError;
  };
  /** src/cloud_config_commands.rs:10 `cloud_config_ssot_save` */
  cloud_config_ssot_save: {
    args: {
      config: Shared.SafeCloudStorageConfig__De;
    };
    result: CloudConfigSsotResponse;
    error: Shared.CommandError;
  };
  /** src/debug_commands.rs:67 `debug_get_database_stats` */
  debug_get_database_stats: {
    args: Record<string, never>;
    result: DebugDatabaseStats;
    error: Shared.AppError;
  };
  /** src/debug_commands.rs:244 `debug_vfs_migration_status` */
  debug_vfs_migration_status: {
    args: Record<string, never>;
    result: VfsMigrationDiagnostic;
    error: string;
  };
  /** src/debug_commands.rs:402 `debug_vfs_textbook_pages` */
  debug_vfs_textbook_pages: {
    args: Record<string, never>;
    result: DebugTextbookPageInfo[];
    error: Shared.AppError;
  };
  /** src/commands.rs:636 `ensure_debug_log_dir` */
  ensure_debug_log_dir: {
    args: Record<string, never>;
    result: string;
    error: Shared.AppError;
  };
  /** src/diagnostics.rs:447 `export_diagnostics_bundle` */
  export_diagnostics_bundle: {
    args: {
      options: DiagnosticsExportOptions;
    };
    result: DiagnosticsExportResult;
    error: string;
  };
  /** src/backup_config.rs:231 `get_auto_backup_status` */
  get_auto_backup_status: {
    args: Record<string, never>;
    result: AutoBackupStatus;
    error: Shared.AppError;
  };
  /** src/backup_config.rs:115 `get_backup_config` */
  get_backup_config: {
    args: Record<string, never>;
    result: BackupConfig;
    error: Shared.AppError;
  };
  /** src/commands.rs:603 `get_debug_logs_info` */
  get_debug_logs_info: {
    args: Record<string, never>;
    result: DebugLogsInfo;
    error: Shared.AppError;
  };
  /** src/backup_config.rs:183 `get_default_backup_directory` */
  get_default_backup_directory: {
    args: Record<string, never>;
    result: string;
    error: Shared.AppError;
  };
  /** src/commands.rs:6296 `get_test_logs` */
  get_test_logs: {
    args: {
      logType: string;
    };
    result: string[];
    error: Shared.AppError;
  };
  /** src/debug_commands.rs:154 `log_debug_message` */
  log_debug_message: {
    args: {
      message: string;
    };
    result: null;
    error: string;
  };
  /** src/commands.rs:6345 `open_log_file` */
  open_log_file: {
    args: {
      logPath: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:6403 `open_logs_folder` */
  open_logs_folder: {
    args: {
      logType: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/backup_config.rs:136 `pick_backup_directory` */
  pick_backup_directory: {
    args: Record<string, never>;
    result: string | null;
    error: Shared.AppError;
  };
  /** src/commands.rs:644 `read_debug_log_file` */
  read_debug_log_file: {
    args: {
      path: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/commands.rs:6519 `report_frontend_log` */
  report_frontend_log: {
    args: {
      payload: FrontendLogPayload;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:6261 `save_test_log` */
  save_test_log: {
    args: {
      fileName: string;
      content: string;
      logType: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** crates/dstu-platform/src/secret_prompt.rs:178 `secret_prompt_capabilities` */
  secret_prompt_capabilities: {
    args: Record<string, never>;
    result: unknown;
    error: never;
  };
  /** crates/dstu-platform/src/secret_prompt.rs:173 `secret_prompt_discard` */
  secret_prompt_discard: {
    args: {
      handleId: string;
    };
    result: boolean;
    error: never;
  };
  /** crates/dstu-platform/src/secret_prompt.rs:161 `secret_prompt_status` */
  secret_prompt_status: {
    args: {
      handleId: string;
    };
    result: unknown;
    error: never;
  };
  /** crates/dstu-platform/src/secret_prompt.rs:138 `secret_prompt_submit` */
  secret_prompt_submit: {
    args: {
      request: SecretPromptSubmitRequest;
    };
    result: SecretPromptHandle;
    error: string;
  };
  /** src/secure_store.rs:66 `secure_clear_cloud_encryption_password` */
  secure_clear_cloud_encryption_password: {
    args: Record<string, never>;
    result: CloudStorageCredentialStatus;
    error: Shared.CommandError;
  };
  /** src/secure_store.rs:59 `secure_delete_cloud_credentials` */
  secure_delete_cloud_credentials: {
    args: Record<string, never>;
    result: null;
    error: Shared.CommandError;
  };
  /** src/secure_store.rs:42 `secure_get_cloud_credentials` */
  secure_get_cloud_credentials: {
    args: Record<string, never>;
    result: CloudStorageCredentialStatus;
    error: Shared.CommandError;
  };
  /** src/secure_store.rs:26 `secure_save_cloud_credentials` */
  secure_save_cloud_credentials: {
    args: {
      credentials: Shared.CloudStorageCredentials;
      encryptionPasswordIsPreexisting?: boolean | null;
    };
    result: CloudStorageCredentialStatus;
    error: Shared.CommandError;
  };
  /** src/secure_store.rs:84 `secure_store_get_keystore_protection` */
  secure_store_get_keystore_protection: {
    args: Record<string, never>;
    result: KeystoreProtectionStatus;
    error: Shared.CommandError;
  };
  /** src/secure_store.rs:77 `secure_store_is_available` */
  secure_store_is_available: {
    args: Record<string, never>;
    result: boolean;
    error: never;
  };
  /** src/secure_store.rs:96 `secure_store_set_keystore_protection` */
  secure_store_set_keystore_protection: {
    args: {
      enabled: boolean;
    };
    result: KeystoreProtectionStatus;
    error: Shared.CommandError;
  };
  /** src/backup_config.rs:121 `set_backup_config` */
  set_backup_config: {
    args: {
      config: BackupConfig__De;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/debug_commands.rs:163 `tauri_lab_frontend_log` */
  tauri_lab_frontend_log: {
    args: {
      level: string;
      message: string;
      stack?: string | null;
    };
    result: null;
    error: string;
  };
  /** src/debug_commands.rs:474 `toggle_devtools` */
  toggle_devtools: {
    args: Record<string, never>;
    result: boolean;
    error: string;
  };
  /** crates/dstu-platform/src/debug_logger.rs:892 `write_debug_logs` */
  write_debug_logs: {
    args: {
      logs: LogEntry[];
    };
    result: null;
    error: string;
  };
  /** src/commands.rs:7436 `write_test_report` */
  write_test_report: {
    args: {
      filename: string;
      content: string;
    };
    result: unknown;
    error: Shared.AppError;
  };
}

export interface Events {
  [name: `${string}_unified_sources`]: {
    stage: string;
    total: number;
    groups: unknown[];
  };
}

export type CommandName = keyof Commands;
export type AutoInstallPackageManagerCommandArgs = Commands['auto_install_package_manager']['args'];
export type AutoInstallPackageManagerCommandResult = Commands['auto_install_package_manager']['result'];
export type CheckAllPackageManagersCommandArgs = Commands['check_all_package_managers']['args'];
export type CheckAllPackageManagersCommandResult = Commands['check_all_package_managers']['result'];
export type CheckPackageManagerCommandArgs = Commands['check_package_manager']['args'];
export type CheckPackageManagerCommandResult = Commands['check_package_manager']['result'];
export type CheckTestDependenciesCommandArgs = Commands['check_test_dependencies']['args'];
export type CheckTestDependenciesCommandResult = Commands['check_test_dependencies']['result'];
export type CleanupOldDebugLogsCommandArgs = Commands['cleanup_old_debug_logs']['args'];
export type CleanupOldDebugLogsCommandResult = Commands['cleanup_old_debug_logs']['result'];
export type ClearBackupDirectoryCommandArgs = Commands['clear_backup_directory']['args'];
export type ClearBackupDirectoryCommandResult = Commands['clear_backup_directory']['result'];
export type ClearDebugLogsCommandArgs = Commands['clear_debug_logs']['args'];
export type ClearDebugLogsCommandResult = Commands['clear_debug_logs']['result'];
export type CloudConfigPublishCommandArgs = Commands['cloud_config_publish']['args'];
export type CloudConfigPublishCommandResult = Commands['cloud_config_publish']['result'];
export type CloudConfigSsotClearCommandArgs = Commands['cloud_config_ssot_clear']['args'];
export type CloudConfigSsotClearCommandResult = Commands['cloud_config_ssot_clear']['result'];
export type CloudConfigSsotGetCommandArgs = Commands['cloud_config_ssot_get']['args'];
export type CloudConfigSsotGetCommandResult = Commands['cloud_config_ssot_get']['result'];
export type CloudConfigSsotSaveCommandArgs = Commands['cloud_config_ssot_save']['args'];
export type CloudConfigSsotSaveCommandResult = Commands['cloud_config_ssot_save']['result'];
export type DebugGetDatabaseStatsCommandArgs = Commands['debug_get_database_stats']['args'];
export type DebugGetDatabaseStatsCommandResult = Commands['debug_get_database_stats']['result'];
export type DebugVfsMigrationStatusCommandArgs = Commands['debug_vfs_migration_status']['args'];
export type DebugVfsMigrationStatusCommandResult = Commands['debug_vfs_migration_status']['result'];
export type DebugVfsTextbookPagesCommandArgs = Commands['debug_vfs_textbook_pages']['args'];
export type DebugVfsTextbookPagesCommandResult = Commands['debug_vfs_textbook_pages']['result'];
export type EnsureDebugLogDirCommandArgs = Commands['ensure_debug_log_dir']['args'];
export type EnsureDebugLogDirCommandResult = Commands['ensure_debug_log_dir']['result'];
export type ExportDiagnosticsBundleCommandArgs = Commands['export_diagnostics_bundle']['args'];
export type ExportDiagnosticsBundleCommandResult = Commands['export_diagnostics_bundle']['result'];
export type GetAutoBackupStatusCommandArgs = Commands['get_auto_backup_status']['args'];
export type GetAutoBackupStatusCommandResult = Commands['get_auto_backup_status']['result'];
export type GetBackupConfigCommandArgs = Commands['get_backup_config']['args'];
export type GetBackupConfigCommandResult = Commands['get_backup_config']['result'];
export type GetDebugLogsInfoCommandArgs = Commands['get_debug_logs_info']['args'];
export type GetDebugLogsInfoCommandResult = Commands['get_debug_logs_info']['result'];
export type GetDefaultBackupDirectoryCommandArgs = Commands['get_default_backup_directory']['args'];
export type GetDefaultBackupDirectoryCommandResult = Commands['get_default_backup_directory']['result'];
export type GetTestLogsCommandArgs = Commands['get_test_logs']['args'];
export type GetTestLogsCommandResult = Commands['get_test_logs']['result'];
export type LogDebugMessageCommandArgs = Commands['log_debug_message']['args'];
export type LogDebugMessageCommandResult = Commands['log_debug_message']['result'];
export type OpenLogFileCommandArgs = Commands['open_log_file']['args'];
export type OpenLogFileCommandResult = Commands['open_log_file']['result'];
export type OpenLogsFolderCommandArgs = Commands['open_logs_folder']['args'];
export type OpenLogsFolderCommandResult = Commands['open_logs_folder']['result'];
export type PickBackupDirectoryCommandArgs = Commands['pick_backup_directory']['args'];
export type PickBackupDirectoryCommandResult = Commands['pick_backup_directory']['result'];
export type ReadDebugLogFileCommandArgs = Commands['read_debug_log_file']['args'];
export type ReadDebugLogFileCommandResult = Commands['read_debug_log_file']['result'];
export type ReportFrontendLogCommandArgs = Commands['report_frontend_log']['args'];
export type ReportFrontendLogCommandResult = Commands['report_frontend_log']['result'];
export type SaveTestLogCommandArgs = Commands['save_test_log']['args'];
export type SaveTestLogCommandResult = Commands['save_test_log']['result'];
export type SecretPromptCapabilitiesCommandArgs = Commands['secret_prompt_capabilities']['args'];
export type SecretPromptCapabilitiesCommandResult = Commands['secret_prompt_capabilities']['result'];
export type SecretPromptDiscardCommandArgs = Commands['secret_prompt_discard']['args'];
export type SecretPromptDiscardCommandResult = Commands['secret_prompt_discard']['result'];
export type SecretPromptStatusCommandArgs = Commands['secret_prompt_status']['args'];
export type SecretPromptStatusCommandResult = Commands['secret_prompt_status']['result'];
export type SecretPromptSubmitCommandArgs = Commands['secret_prompt_submit']['args'];
export type SecretPromptSubmitCommandResult = Commands['secret_prompt_submit']['result'];
export type SecureClearCloudEncryptionPasswordCommandArgs = Commands['secure_clear_cloud_encryption_password']['args'];
export type SecureClearCloudEncryptionPasswordCommandResult = Commands['secure_clear_cloud_encryption_password']['result'];
export type SecureDeleteCloudCredentialsCommandArgs = Commands['secure_delete_cloud_credentials']['args'];
export type SecureDeleteCloudCredentialsCommandResult = Commands['secure_delete_cloud_credentials']['result'];
export type SecureGetCloudCredentialsCommandArgs = Commands['secure_get_cloud_credentials']['args'];
export type SecureGetCloudCredentialsCommandResult = Commands['secure_get_cloud_credentials']['result'];
export type SecureSaveCloudCredentialsCommandArgs = Commands['secure_save_cloud_credentials']['args'];
export type SecureSaveCloudCredentialsCommandResult = Commands['secure_save_cloud_credentials']['result'];
export type SecureStoreGetKeystoreProtectionCommandArgs = Commands['secure_store_get_keystore_protection']['args'];
export type SecureStoreGetKeystoreProtectionCommandResult = Commands['secure_store_get_keystore_protection']['result'];
export type SecureStoreIsAvailableCommandArgs = Commands['secure_store_is_available']['args'];
export type SecureStoreIsAvailableCommandResult = Commands['secure_store_is_available']['result'];
export type SecureStoreSetKeystoreProtectionCommandArgs = Commands['secure_store_set_keystore_protection']['args'];
export type SecureStoreSetKeystoreProtectionCommandResult = Commands['secure_store_set_keystore_protection']['result'];
export type SetBackupConfigCommandArgs = Commands['set_backup_config']['args'];
export type SetBackupConfigCommandResult = Commands['set_backup_config']['result'];
export type TauriLabFrontendLogCommandArgs = Commands['tauri_lab_frontend_log']['args'];
export type TauriLabFrontendLogCommandResult = Commands['tauri_lab_frontend_log']['result'];
export type ToggleDevtoolsCommandArgs = Commands['toggle_devtools']['args'];
export type ToggleDevtoolsCommandResult = Commands['toggle_devtools']['result'];
export type WriteDebugLogsCommandArgs = Commands['write_debug_logs']['args'];
export type WriteDebugLogsCommandResult = Commands['write_debug_logs']['result'];
export type WriteTestReportCommandArgs = Commands['write_test_report']['args'];
export type WriteTestReportCommandResult = Commands['write_test_report']['result'];
