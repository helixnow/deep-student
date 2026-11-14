// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/F3-storage.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** dstu_storage::llm_usage::types::CallerType */
export type CallerType = "chat_v2" | "translation" | "anki" | "analysis" | "exam_sheet" | "memory" | "vfs_indexing" | "embedding" | "reranker" | "voice_input" | "media_transcription" | {
  other: string;
};
/** dstu_storage::llm_usage::types::CallerTypeSummary */
export type CallerTypeSummary = {
  callerType: CallerType;
  displayName: string;
  requestCount: number;
  totalTokens: number;
  estimatedCostUsd?: number | null;
  percentage?: number | null;
};
/** dstu_storage::llm_usage::types::DailySummary */
export type DailySummary = {
  date: string;
  callerType?: CallerType | null;
  modelId?: string | null;
  requestCount: number;
  successCount: number;
  errorCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalReasoningTokens?: number | null;
  totalCachedTokens?: number | null;
  totalEstimatedCostUsd?: number | null;
  avgDurationMs?: number | null;
};
/** dstu_storage::data_space::DataSpaceInfo */
export type DataSpaceInfo = {
  active_slot: string;
  inactive_slot: string;
  pending_slot: string | null;
  active_dir: string;
  inactive_dir: string;
};
/** dstu_storage::llm_usage::types::ModelSummary */
export type ModelSummary = {
  modelId: string;
  requestCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd?: number | null;
  percentage?: number | null;
  avgTokensPerRequest?: number | null;
};
/** dstu_storage::llm_usage::types::SessionUsageSummary */
export type SessionUsageSummary = {
  sessionId: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number | null;
};
/** dstu_storage::staged_upload::StagedFromPath */
export type StagedFromPath = {
  uploadId: string;
  size: number;
};
/** dstu_storage::data_space::StartupRecoveryCandidate */
export type StartupRecoveryCandidate = {
  id: string;
  exists: boolean;
  has_data: boolean;
  has_database: boolean;
  size_bytes: number;
  latest_modified: string | null;
  database_filenames: string[];
  core_database_filenames: string[];
  valid_core_database_filenames: string[];
  selectable: boolean;
  selection_block_reason?: string | null;
  recommended: boolean;
  recommendation_reason: string;
};
/** dstu_storage::data_space::StartupRecoveryIncident */
export type StartupRecoveryIncident = {
  incident_id: string;
  created_at: string;
  resolved: boolean;
  resolved_at?: string | null;
  selected_candidate?: string | null;
  recovery_error?: string | null;
  failed_operation?: string | null;
  retry_requires_restart: boolean;
  candidates: StartupRecoveryCandidate[];
  legacy_entries: string[];
};
/** dstu_storage::data_space::StartupRecoveryResolveResponse */
export type StartupRecoveryResolveResponse = {
  resolved: boolean;
  restart_required: boolean;
  selected_candidate: string;
  incident_id: string;
};
/** dstu_storage::data_space::StartupRecoveryStatus */
export type StartupRecoveryStatus = {
  recovery_required: boolean;
  incident?: StartupRecoveryIncident | null;
};
/** dstu_storage::data_space::TestSlotInfo */
export type TestSlotInfo = {
  slot_c_dir: string;
  slot_d_dir: string;
  slot_c_exists: boolean;
  slot_d_exists: boolean;
  slot_c_file_count: number;
  slot_d_file_count: number;
};
/** dstu_storage::llm_usage::types::UsageRecord */
export type UsageRecord = {
  id: string;
  callerType: CallerType;
  callerId?: string | null;
  variantId?: string | null;
  runId?: string | null;
  modelId: string;
  configId?: string | null;
  providerId?: string | null;
  adapter?: string | null;
  tokenSource?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  cacheWriteTokens?: number | null;
  estimatedCostUsd?: number | null;
  durationMs?: number | null;
  success: boolean;
  errorMessage?: string | null;
  createdAt: string;
};
/** dstu_storage::llm_usage::types::UsageSummary */
export type UsageSummary = {
  startDate: string;
  endDate: string;
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalReasoningTokens?: number | null;
  totalCachedTokens?: number | null;
  totalEstimatedCostUsd?: number | null;
  avgTokensPerRequest?: number | null;
  avgDurationMs?: number | null;
  byCallerType?: CallerTypeSummary[] | null;
  byModel?: ModelSummary[] | null;
  trendPoints?: UsageTrendPoint[] | null;
};
/** dstu_storage::llm_usage::types::UsageTrendPoint */
export type UsageTrendPoint = {
  timeLabel: string;
  timestamp: number;
  requestCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd?: number | null;
  successRate?: number | null;
};

export interface Commands {
  /** crates/dstu-storage/src/data_space.rs:2598 `clear_test_slots` */
  clear_test_slots: {
    args: Record<string, never>;
    result: string;
    error: Shared.AppError;
  };
  /** crates/dstu-storage/src/data_space.rs:2231 `export_startup_recovery_incident` */
  export_startup_recovery_incident: {
    args: {
      incidentId: string;
      destination: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** crates/dstu-storage/src/data_space.rs:2269 `export_startup_recovery_report` */
  export_startup_recovery_report: {
    args: {
      destination: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** crates/dstu-storage/src/data_space.rs:2493 `get_data_space_info` */
  get_data_space_info: {
    args: Record<string, never>;
    result: DataSpaceInfo;
    error: Shared.AppError;
  };
  /** src/commands.rs:7308 `get_database_info` */
  get_database_info: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** crates/dstu-storage/src/data_space.rs:2616 `get_slot_directory` */
  get_slot_directory: {
    args: {
      slotName: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** crates/dstu-storage/src/data_space.rs:2169 `get_startup_recovery_status` */
  get_startup_recovery_status: {
    args: Record<string, never>;
    result: StartupRecoveryStatus;
    error: Shared.AppError;
  };
  /** crates/dstu-storage/src/data_space.rs:2576 `get_test_slot_info` */
  get_test_slot_info: {
    args: Record<string, never>;
    result: TestSlotInfo;
    error: Shared.AppError;
  };
  /** crates/dstu-storage/src/data_space.rs:2469 `list_startup_recovery_incidents` */
  list_startup_recovery_incidents: {
    args: Record<string, never>;
    result: StartupRecoveryIncident[];
    error: Shared.AppError;
  };
  /** crates/dstu-storage/src/llm_usage/handlers.rs:39 `llm_usage_by_caller` */
  llm_usage_by_caller: {
    args: {
      startDate: string;
      endDate: string;
    };
    result: CallerTypeSummary[];
    error: string;
  };
  /** crates/dstu-storage/src/llm_usage/handlers.rs:29 `llm_usage_by_model` */
  llm_usage_by_model: {
    args: {
      startDate: string;
      endDate: string;
    };
    result: ModelSummary[];
    error: string;
  };
  /** crates/dstu-storage/src/llm_usage/handlers.rs:89 `llm_usage_cleanup` */
  llm_usage_cleanup: {
    args: {
      beforeDate: string;
    };
    result: number;
    error: string;
  };
  /** crates/dstu-storage/src/llm_usage/handlers.rs:79 `llm_usage_daily` */
  llm_usage_daily: {
    args: {
      startDate: string;
      endDate: string;
    };
    result: DailySummary[];
    error: string;
  };
  /** crates/dstu-storage/src/llm_usage/handlers.rs:11 `llm_usage_get_trends` */
  llm_usage_get_trends: {
    args: {
      days: number;
      granularity: string;
    };
    result: UsageTrendPoint[];
    error: string;
  };
  /** crates/dstu-storage/src/llm_usage/handlers.rs:70 `llm_usage_recent` */
  llm_usage_recent: {
    args: {
      limit?: number | null;
    };
    result: UsageRecord[];
    error: string;
  };
  /** crates/dstu-storage/src/llm_usage/handlers.rs:61 `llm_usage_session_summary` */
  llm_usage_session_summary: {
    args: {
      sessionId: string;
    };
    result: SessionUsageSummary;
    error: string;
  };
  /** crates/dstu-storage/src/llm_usage/handlers.rs:49 `llm_usage_summary` */
  llm_usage_summary: {
    args: {
      startDate?: string | null;
      endDate?: string | null;
    };
    result: UsageSummary;
    error: string;
  };
  /** crates/dstu-storage/src/data_space.rs:2523 `mark_data_space_pending_switch_to_inactive` */
  mark_data_space_pending_switch_to_inactive: {
    args: Record<string, never>;
    result: string;
    error: Shared.AppError;
  };
  /** crates/dstu-storage/src/data_space.rs:2197 `open_startup_recovery_incident_folder` */
  open_startup_recovery_incident_folder: {
    args: {
      incidentId: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** crates/dstu-storage/src/data_space.rs:2552 `purge_active_data_dir_now` */
  purge_active_data_dir_now: {
    args: Record<string, never>;
    result: string;
    error: Shared.AppError;
  };
  /** crates/dstu-storage/src/data_space.rs:2539 `purge_all_database_files` */
  purge_all_database_files: {
    args: Record<string, never>;
    result: string;
    error: Shared.AppError;
  };
  /** src/commands.rs:7215 `reset_test_database` */
  reset_test_database: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** crates/dstu-storage/src/data_space.rs:2478 `resolve_startup_recovery` */
  resolve_startup_recovery: {
    args: {
      candidateId: string;
    };
    result: StartupRecoveryResolveResponse;
    error: Shared.AppError;
  };
  /** crates/dstu-storage/src/data_space.rs:2610 `restart_app` */
  restart_app: {
    args: Record<string, never>;
    result: null;
    error: never;
  };
  /** crates/dstu-storage/src/data_space.rs:2190 `retry_startup_recovery_preflight` */
  retry_startup_recovery_preflight: {
    args: Record<string, never>;
    result: StartupRecoveryStatus;
    error: Shared.AppError;
  };
  /** src/commands.rs:7330 `seed_test_database` */
  seed_test_database: {
    args: {
      config?: unknown | null;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/commands.rs:7424 `set_test_run_id` */
  set_test_run_id: {
    args: {
      testRunId: string;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** crates/dstu-storage/src/staged_upload.rs:510 `staged_upload_abort` */
  staged_upload_abort: {
    args: {
      uploadId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-storage/src/staged_upload.rs:461 `staged_upload_append` */
  staged_upload_append: {
    args: Record<string, never>;
    result: number;
    error: string;
  };
  /** crates/dstu-storage/src/staged_upload.rs:446 `staged_upload_begin` */
  staged_upload_begin: {
    args: {
      name: string;
      totalSize: number;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-storage/src/staged_upload.rs:490 `staged_upload_from_path` */
  staged_upload_from_path: {
    args: {
      path: string;
    };
    result: StagedFromPath;
    error: string;
  };
  /** src/commands.rs:7276 `switch_to_production_database` */
  switch_to_production_database: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/commands.rs:7169 `switch_to_test_database` */
  switch_to_test_database: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
}

export interface Events {
}

export type CommandName = keyof Commands;
export type ClearTestSlotsCommandArgs = Commands['clear_test_slots']['args'];
export type ClearTestSlotsCommandResult = Commands['clear_test_slots']['result'];
export type ExportStartupRecoveryIncidentCommandArgs = Commands['export_startup_recovery_incident']['args'];
export type ExportStartupRecoveryIncidentCommandResult = Commands['export_startup_recovery_incident']['result'];
export type ExportStartupRecoveryReportCommandArgs = Commands['export_startup_recovery_report']['args'];
export type ExportStartupRecoveryReportCommandResult = Commands['export_startup_recovery_report']['result'];
export type GetDataSpaceInfoCommandArgs = Commands['get_data_space_info']['args'];
export type GetDataSpaceInfoCommandResult = Commands['get_data_space_info']['result'];
export type GetDatabaseInfoCommandArgs = Commands['get_database_info']['args'];
export type GetDatabaseInfoCommandResult = Commands['get_database_info']['result'];
export type GetSlotDirectoryCommandArgs = Commands['get_slot_directory']['args'];
export type GetSlotDirectoryCommandResult = Commands['get_slot_directory']['result'];
export type GetStartupRecoveryStatusCommandArgs = Commands['get_startup_recovery_status']['args'];
export type GetStartupRecoveryStatusCommandResult = Commands['get_startup_recovery_status']['result'];
export type GetTestSlotInfoCommandArgs = Commands['get_test_slot_info']['args'];
export type GetTestSlotInfoCommandResult = Commands['get_test_slot_info']['result'];
export type ListStartupRecoveryIncidentsCommandArgs = Commands['list_startup_recovery_incidents']['args'];
export type ListStartupRecoveryIncidentsCommandResult = Commands['list_startup_recovery_incidents']['result'];
export type LlmUsageByCallerCommandArgs = Commands['llm_usage_by_caller']['args'];
export type LlmUsageByCallerCommandResult = Commands['llm_usage_by_caller']['result'];
export type LlmUsageByModelCommandArgs = Commands['llm_usage_by_model']['args'];
export type LlmUsageByModelCommandResult = Commands['llm_usage_by_model']['result'];
export type LlmUsageCleanupCommandArgs = Commands['llm_usage_cleanup']['args'];
export type LlmUsageCleanupCommandResult = Commands['llm_usage_cleanup']['result'];
export type LlmUsageDailyCommandArgs = Commands['llm_usage_daily']['args'];
export type LlmUsageDailyCommandResult = Commands['llm_usage_daily']['result'];
export type LlmUsageGetTrendsCommandArgs = Commands['llm_usage_get_trends']['args'];
export type LlmUsageGetTrendsCommandResult = Commands['llm_usage_get_trends']['result'];
export type LlmUsageRecentCommandArgs = Commands['llm_usage_recent']['args'];
export type LlmUsageRecentCommandResult = Commands['llm_usage_recent']['result'];
export type LlmUsageSessionSummaryCommandArgs = Commands['llm_usage_session_summary']['args'];
export type LlmUsageSessionSummaryCommandResult = Commands['llm_usage_session_summary']['result'];
export type LlmUsageSummaryCommandArgs = Commands['llm_usage_summary']['args'];
export type LlmUsageSummaryCommandResult = Commands['llm_usage_summary']['result'];
export type MarkDataSpacePendingSwitchToInactiveCommandArgs = Commands['mark_data_space_pending_switch_to_inactive']['args'];
export type MarkDataSpacePendingSwitchToInactiveCommandResult = Commands['mark_data_space_pending_switch_to_inactive']['result'];
export type OpenStartupRecoveryIncidentFolderCommandArgs = Commands['open_startup_recovery_incident_folder']['args'];
export type OpenStartupRecoveryIncidentFolderCommandResult = Commands['open_startup_recovery_incident_folder']['result'];
export type PurgeActiveDataDirNowCommandArgs = Commands['purge_active_data_dir_now']['args'];
export type PurgeActiveDataDirNowCommandResult = Commands['purge_active_data_dir_now']['result'];
export type PurgeAllDatabaseFilesCommandArgs = Commands['purge_all_database_files']['args'];
export type PurgeAllDatabaseFilesCommandResult = Commands['purge_all_database_files']['result'];
export type ResetTestDatabaseCommandArgs = Commands['reset_test_database']['args'];
export type ResetTestDatabaseCommandResult = Commands['reset_test_database']['result'];
export type ResolveStartupRecoveryCommandArgs = Commands['resolve_startup_recovery']['args'];
export type ResolveStartupRecoveryCommandResult = Commands['resolve_startup_recovery']['result'];
export type RestartAppCommandArgs = Commands['restart_app']['args'];
export type RestartAppCommandResult = Commands['restart_app']['result'];
export type RetryStartupRecoveryPreflightCommandArgs = Commands['retry_startup_recovery_preflight']['args'];
export type RetryStartupRecoveryPreflightCommandResult = Commands['retry_startup_recovery_preflight']['result'];
export type SeedTestDatabaseCommandArgs = Commands['seed_test_database']['args'];
export type SeedTestDatabaseCommandResult = Commands['seed_test_database']['result'];
export type SetTestRunIdCommandArgs = Commands['set_test_run_id']['args'];
export type SetTestRunIdCommandResult = Commands['set_test_run_id']['result'];
export type StagedUploadAbortCommandArgs = Commands['staged_upload_abort']['args'];
export type StagedUploadAbortCommandResult = Commands['staged_upload_abort']['result'];
export type StagedUploadAppendCommandArgs = Commands['staged_upload_append']['args'];
export type StagedUploadAppendCommandResult = Commands['staged_upload_append']['result'];
export type StagedUploadBeginCommandArgs = Commands['staged_upload_begin']['args'];
export type StagedUploadBeginCommandResult = Commands['staged_upload_begin']['result'];
export type StagedUploadFromPathCommandArgs = Commands['staged_upload_from_path']['args'];
export type StagedUploadFromPathCommandResult = Commands['staged_upload_from_path']['result'];
export type SwitchToProductionDatabaseCommandArgs = Commands['switch_to_production_database']['args'];
export type SwitchToProductionDatabaseCommandResult = Commands['switch_to_production_database']['result'];
export type SwitchToTestDatabaseCommandArgs = Commands['switch_to_test_database']['args'];
export type SwitchToTestDatabaseCommandResult = Commands['switch_to_test_database']['result'];
