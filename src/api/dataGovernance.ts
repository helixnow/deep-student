/**
 * 数据治理系统 API 调用层
 *
 * 封装所有数据治理相关的 Tauri 命令调用
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  SchemaRegistryResponse,
  MigrationStatusResponse,
  HealthCheckResponse,
  DatabaseDetailResponse,
  AuditLogResponse,
  AuditLogPagedResponse,
  AuditOperationType,
  AuditStatus,
  BackupResultResponse,
  BackupInfoResponse,
  BackupVerifyResponse,
  RestoreResultResponse,
  TieredBackupResultResponse,
  BackupTier,
  ZipExportResultResponse,
  ZipImportResultResponse,
  SyncStatusResponse,
  ConflictDetectionResponse,
  SyncResultResponse,
  MergeStrategy,
  CloudStorageConfig,
  SyncExecutionResponse,
  SyncExportResponse,
  SyncImportResponse,
  SyncProgress,
  SyncPhase,
  SyncProgressListenerOptions,
  AssetScanResponse,
  AssetType,
  AssetTypeInfo,
  BackupVerifyWithAssetsResponse,
  AutoVerifyResponse,
} from '../types/dataGovernance';
import {
  SYNC_PROGRESS_EVENT,
  isSyncPhaseTerminal,
} from '../types/dataGovernance';

// ==================== 维护模式 API ====================

/**
 * 查询后端维护模式状态
 * 用于应用启动时同步后端维护模式到前端 store
 */
export async function getMaintenanceStatus(): Promise<{ is_in_maintenance_mode: boolean }> {
  return invoke<{ is_in_maintenance_mode: boolean }>('data_governance_get_maintenance_status');
}

// ==================== Schema 相关 API ====================

/**
 * 获取 Schema 注册表
 * 返回所有数据库的版本状态和迁移历史
 */
export async function getSchemaRegistry(): Promise<SchemaRegistryResponse> {
  return invoke<SchemaRegistryResponse>('data_governance_get_schema_registry');
}

/**
 * 获取迁移状态摘要
 * 返回各数据库的当前版本信息
 */
export async function getMigrationStatus(): Promise<MigrationStatusResponse> {
  return invoke<MigrationStatusResponse>('data_governance_get_migration_status');
}

/**
 * 获取特定数据库的详细状态
 * @param databaseId 数据库 ID
 */
export async function getDatabaseStatus(databaseId: string): Promise<DatabaseDetailResponse | null> {
  return invoke<DatabaseDetailResponse | null>('data_governance_get_database_status', {
    databaseId,
  });
}

/**
 * 运行健康检查
 * 检查所有数据库的完整性和依赖关系
 */
export async function runHealthCheck(): Promise<HealthCheckResponse> {
  return invoke<HealthCheckResponse>('data_governance_run_health_check');
}

// ==================== 审计日志 API ====================

/**
 * 获取审计日志（支持分页）
 * @param operationType 操作类型过滤（可选）
 * @param status 状态过滤（可选）
 * @param limit 返回数量限制（可选，默认 100）
 * @param offset 偏移量（可选，用于分页）
 */
export async function getAuditLogs(
  operationType?: AuditOperationType,
  status?: AuditStatus,
  limit?: number,
  offset?: number
): Promise<AuditLogPagedResponse> {
  return invoke<AuditLogPagedResponse>('data_governance_get_audit_logs', {
    operationType,
    status,
    limit,
    offset,
  });
}

/**
 * 清理审计日志
 *
 * 支持两种清理策略：
 * - keepRecent: 保留最近 N 条记录（最少 100 条）
 * - beforeDays: 删除 N 天之前的记录（最少 7 天）
 *
 * 如果都未指定，默认清理 90 天之前的记录。
 *
 * 安全机制：自动生成确认令牌，防止被恶意脚本静默调用。
 *
 * @returns 被删除的记录数量
 */
export async function cleanupAuditLogs(
  keepRecent?: number,
  beforeDays?: number
): Promise<number> {
  const confirmationToken = `AUDIT_CLEANUP_${Math.floor(Date.now() / 1000)}`;
  return invoke<number>('data_governance_cleanup_audit_logs', {
    keepRecent,
    beforeDays,
    confirmationToken,
  });
}

// ==================== 备份配置 API ====================

/**
 * 备份配置
 * 对应后端 BackupConfig (camelCase 序列化)
 */
export interface BackupConfig {
  /** 自定义备份目录（null 表示使用默认目录） */
  backupDirectory: string | null;
  /** 是否启用自动备份 */
  autoBackupEnabled: boolean;
  /** 自动备份间隔（小时），默认 24 */
  autoBackupIntervalHours: number;
  /** 最大备份文件数量（null 表示无限制） */
  maxBackupCount: number | null;
  /** 精简备份模式：仅备份数据库和设置，跳过大文件 */
  slimBackup: boolean;
  /** 分级备份层级（可选） */
  backupTiers?: BackupTier[];
}

/**
 * 获取备份配置
 */
export async function getBackupConfig(): Promise<BackupConfig> {
  return invoke<BackupConfig>('get_backup_config');
}

/**
 * 保存备份配置
 * @param config 备份配置
 */
export async function setBackupConfig(config: BackupConfig): Promise<void> {
  return invoke<void>('set_backup_config', { config });
}

// ==================== 备份 API ====================

/**
 * 执行备份（异步后台任务）
 * 
 * 立即返回任务 ID，备份在后台执行。
 * 进度通过 `backup-job-progress` 事件发送。
 * 
 * @param backupType 备份类型：'full'（完整）或 'incremental'（增量）
 * @param baseVersion 增量备份的基础版本（仅增量备份需要）
 * @param includeAssets 是否包含资产文件
 * @param assetTypes 要备份的资产类型列表
 */
export async function runBackup(
  backupType?: 'full' | 'incremental',
  baseVersion?: string,
  includeAssets?: boolean,
  assetTypes?: string[]
): Promise<BackupJobStartResponse> {
  return invoke<BackupJobStartResponse>('data_governance_run_backup', {
    backupType,
    baseVersion,
    includeAssets,
    assetTypes,
  });
}

/**
 * 获取备份列表
 * 返回所有可用的备份文件列表
 */
export async function getBackupList(): Promise<BackupInfoResponse[]> {
  return invoke<BackupInfoResponse[]>('data_governance_get_backup_list');
}

/**
 * 删除备份
 * @param backupId 要删除的备份 ID
 */
export async function deleteBackup(backupId: string): Promise<boolean> {
  return invoke<boolean>('data_governance_delete_backup', {
    backupId,
  });
}

/**
 * 验证备份
 * @param backupId 要验证的备份 ID
 */
export async function verifyBackup(backupId: string): Promise<BackupVerifyResponse> {
  return invoke<BackupVerifyResponse>('data_governance_verify_backup', {
    backupId,
  });
}

/**
 * 自动验证最新备份完整性
 *
 * 找到最新的备份，执行完整性验证（PRAGMA integrity_check + SHA256 校验和），
 * 并将验证结果写入审计日志。
 */
export async function autoVerifyLatestBackup(): Promise<AutoVerifyResponse> {
  return invoke<AutoVerifyResponse>('data_governance_auto_verify_latest_backup');
}

/**
 * 从备份恢复（异步后台任务）
 * 
 * 立即返回任务 ID，恢复在后台执行。
 * 进度通过 `backup-job-progress` 事件发送。
 * 
 * @param backupId 要恢复的备份 ID
 * @param restoreAssets 是否恢复资产文件（可选：默认根据备份清单自动决定）
 */
export async function restoreBackup(
  backupId: string,
  restoreAssets?: boolean
): Promise<BackupJobStartResponse> {
  return invoke<BackupJobStartResponse>('data_governance_restore_backup', {
    backupId,
    restoreAssets,
  });
}

// ==================== 后台备份任务 API ====================

/**
 * 后台备份任务启动响应
 */
export interface BackupJobStartResponse {
  /** 任务 ID */
  job_id: string;
  /** 任务类型 */
  kind: string;
  /** 初始状态 */
  status: string;
  /** 提示消息 */
  message: string;
}

/**
 * 备份任务摘要
 */
export interface BackupJobSummary {
  job_id: string;
  kind: 'export' | 'import';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  phase: string;
  progress: number;
  message?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  result?: BackupJobResultPayload;
  /** 后端标记：失败且具备检查点时可恢复 */
  resumable?: boolean;
}

/**
 * 备份任务结果
 */
export interface BackupJobResultPayload {
  success: boolean;
  output_path?: string;
  resolved_path?: string;
  message?: string;
  error?: string;
  duration_ms?: number;
  stats?: Record<string, unknown>;
  requires_restart: boolean;
  /** 断点续传：检查点文件路径（可选） */
  checkpoint_path?: string;
  /** 断点续传：可恢复任务 ID（可选） */
  resumable_job_id?: string;
}

/**
 * 备份任务进度事件
 */
export interface BackupJobEvent {
  job_id: string;
  kind: 'export' | 'import';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  phase: string;
  progress: number;
  message?: string;
  processed_items: number;
  total_items: number;
  eta_seconds?: number;
  cancellable: boolean;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  result?: BackupJobResultPayload;
}

/** 备份任务进度事件名称 */
export const BACKUP_JOB_PROGRESS_EVENT = 'backup-job-progress';


/**
 * 取消备份任务
 * @param jobId 任务 ID
 * @returns 是否成功请求取消
 */
export async function cancelBackup(jobId: string): Promise<boolean> {
  return invoke<boolean>('data_governance_cancel_backup', {
    jobId,
  });
}

/**
 * 获取备份任务状态
 * @param jobId 任务 ID
 */
export async function getBackupJob(jobId: string): Promise<BackupJobSummary | null> {
  return invoke<BackupJobSummary | null>('data_governance_get_backup_job', {
    jobId,
  });
}

/**
 * 获取所有备份任务列表
 */
export async function listBackupJobs(): Promise<BackupJobSummary[]> {
  return invoke<BackupJobSummary[]>('data_governance_list_backup_jobs');
}

/**
 * 监听备份任务进度事件
 *
 * @param jobId 要监听的任务 ID（可选，不提供则监听所有任务）
 * @param onProgress 进度回调
 * @returns 取消监听函数
 */
export async function listenBackupProgress(
  jobId: string | null,
  onProgress: (event: BackupJobEvent) => void
): Promise<UnlistenFn> {
  const normalizeBackupJobResultPayload = (payload: unknown): BackupJobResultPayload | undefined => {
    if (!payload || typeof payload !== 'object') return undefined;
    const p = payload as Record<string, unknown>;

    const outputPath = (p.output_path ?? p.outputPath);
    const resolvedPath = (p.resolved_path ?? p.resolvedPath);
    const durationMs = (p.duration_ms ?? p.durationMs);
    const requiresRestart = (p.requires_restart ?? p.requiresRestart);
    const checkpointPath = (p.checkpoint_path ?? p.checkpointPath);
    const resumableJobId = (p.resumable_job_id ?? p.resumableJobId);

    return {
      success: Boolean(p.success),
      output_path: typeof outputPath === 'string' ? outputPath : undefined,
      resolved_path: typeof resolvedPath === 'string' ? resolvedPath : undefined,
      message: typeof p.message === 'string' ? p.message : undefined,
      error: typeof p.error === 'string' ? p.error : undefined,
      duration_ms: typeof durationMs === 'number' ? durationMs : undefined,
      stats: (p.stats && typeof p.stats === 'object') ? (p.stats as Record<string, unknown>) : undefined,
      requires_restart: Boolean(requiresRestart),
      checkpoint_path: typeof checkpointPath === 'string' ? checkpointPath : undefined,
      resumable_job_id: typeof resumableJobId === 'string' ? resumableJobId : undefined,
    };
  };

  const normalizeBackupJobEventPayload = (payload: unknown): BackupJobEvent | null => {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;

    const job_id_raw = (p.job_id ?? p.jobId);
    const kind = p.kind;
    const status = p.status;
    const phase = p.phase;
    const progress_raw = p.progress;

    const job_id = typeof job_id_raw === 'string' ? job_id_raw : (job_id_raw != null ? String(job_id_raw) : '');
    const progress = typeof progress_raw === 'number' ? progress_raw : Number(progress_raw);

    if (!job_id) return null;
    if (kind !== 'export' && kind !== 'import') return null;
    if (status !== 'queued' && status !== 'running' && status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
      return null;
    }
    if (typeof phase !== 'string' || !Number.isFinite(progress)) return null;

    const processed_items_raw = (p.processed_items ?? p.processedItems);
    const total_items_raw = (p.total_items ?? p.totalItems);
    const eta_seconds_raw = (p.eta_seconds ?? p.etaSeconds);

    const processed_items = typeof processed_items_raw === 'number' ? processed_items_raw : Number(processed_items_raw ?? 0);
    const total_items = typeof total_items_raw === 'number' ? total_items_raw : Number(total_items_raw ?? 0);
    const eta_seconds = typeof eta_seconds_raw === 'number'
      ? eta_seconds_raw
      : (eta_seconds_raw != null && eta_seconds_raw !== '' ? Number(eta_seconds_raw) : undefined);

    const created_at_raw = (p.created_at ?? p.createdAt);
    const started_at_raw = (p.started_at ?? p.startedAt);
    const finished_at_raw = (p.finished_at ?? p.finishedAt);

    const created_at = typeof created_at_raw === 'string' ? created_at_raw : (created_at_raw != null ? String(created_at_raw) : '');

    const cancellable_raw = p.cancellable;
    const cancellable = typeof cancellable_raw === 'boolean'
      ? cancellable_raw
      : !(status === 'completed' || status === 'failed' || status === 'cancelled');

    return {
      job_id,
      kind,
      status,
      phase,
      progress,
      message: typeof p.message === 'string' ? p.message : undefined,
      processed_items: Number.isFinite(processed_items) ? processed_items : 0,
      total_items: Number.isFinite(total_items) ? total_items : 0,
      eta_seconds: Number.isFinite(Number(eta_seconds)) ? Number(eta_seconds) : undefined,
      cancellable,
      created_at,
      started_at: typeof started_at_raw === 'string' ? started_at_raw : undefined,
      finished_at: typeof finished_at_raw === 'string' ? finished_at_raw : undefined,
      result: normalizeBackupJobResultPayload(p.result),
    };
  };

  return listen<unknown>(BACKUP_JOB_PROGRESS_EVENT, (event) => {
    const normalized = normalizeBackupJobEventPayload((event as { payload?: unknown })?.payload);
    if (!normalized) return;

    // 如果指定了 jobId，只处理该任务的事件（兼容 camelCase/snake_case）
    if (jobId && normalized.job_id !== jobId) {
      return;
    }
    onProgress(normalized);
  });
}

/**
 * 判断备份任务是否已完成（终态）
 */
export function isBackupJobTerminal(status: BackupJobEvent['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

// ==================== 任务恢复 API ====================

/**
 * 可恢复任务信息
 */
export interface ResumableJob {
  /** 任务 ID */
  job_id: string;
  /** 任务类型 */
  kind: 'export' | 'import';
  /** 当前阶段 */
  phase: string;
  /** 进度百分比 (0-100) */
  progress: number;
  /** 创建时间 */
  created_at: string;
  /** 状态消息 */
  message?: string;
}

/**
 * 恢复备份任务
 *
 * 恢复一个之前中断的备份任务。
 * 任务将从中断点继续执行。
 *
 * @param jobId 要恢复的任务 ID
 * @returns 任务启动响应
 */
export async function resumeBackupJob(jobId: string): Promise<BackupJobStartResponse> {
  return invoke<BackupJobStartResponse>('data_governance_resume_backup_job', {
    jobId,
  });
}

/**
 * 获取可恢复任务列表
 *
 * 返回所有可以恢复的任务（中断的、失败的等）。
 *
 * @returns 可恢复任务列表
 */
export async function listResumableJobs(): Promise<ResumableJob[]> {
  const normalizeResumableJobPayload = (payload: unknown): ResumableJob | null => {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;

    const job_id_raw = (p.job_id ?? p.jobId);
    const kind = p.kind;
    const phase = p.phase;
    const progress_raw = p.progress;
    const created_at_raw = (p.created_at ?? p.createdAt);

    const job_id = typeof job_id_raw === 'string' ? job_id_raw : (job_id_raw != null ? String(job_id_raw) : '');
    const progress = typeof progress_raw === 'number' ? progress_raw : Number(progress_raw);
    const created_at = typeof created_at_raw === 'string' ? created_at_raw : (created_at_raw != null ? String(created_at_raw) : '');

    if (!job_id) return null;
    if (kind !== 'export' && kind !== 'import') return null;
    if (typeof phase !== 'string' || !Number.isFinite(progress)) return null;

    const message_raw = (p.message ?? p.error_message ?? p.errorMessage);
    const message = typeof message_raw === 'string' ? message_raw : undefined;

    return {
      job_id,
      kind,
      phase,
      progress,
      created_at,
      message,
    };
  };

  const raw = await invoke<unknown>('data_governance_list_resumable_jobs');
  if (!Array.isArray(raw)) return [];

  return raw
    .map(normalizeResumableJobPayload)
    .filter((v): v is ResumableJob => Boolean(v));
}

/**
 * 清理已完成任务的持久化文件
 *
 * 删除已成功完成任务的持久化状态文件，释放存储空间。
 *
 * @returns 清理的文件数量
 */
export async function cleanupPersistedJobs(): Promise<number> {
  return invoke<number>('data_governance_cleanup_persisted_jobs');
}

// ==================== 分层备份 API ====================

/**
 * 执行分层备份（异步后台任务）
 *
 * 立即返回任务 ID，备份在后台执行。
 * 进度通过 `backup-job-progress` 事件发送。
 *
 * @param tiers 要备份的层级列表（可选，默认仅 core）
 *   - 'core': 核心数据（聊天记录、文件系统、错题本）
 *   - 'important': 重要数据（LLM 使用统计等）
 *   - 'rebuildable': 可重建数据（向量索引等）
 *   - 'large_assets': 大型资产（图片、文档、视频）
 * @param includeDatabases 显式包含的数据库（可选）
 * @param excludeDatabases 显式排除的数据库（可选）
 * @param includeAssets 是否包含资产文件（可选，默认 false）
 * @param maxAssetSize 最大资产文件大小（字节）（可选，默认 100MB）
 */
export async function backupTiered(
  tiers?: BackupTier[],
  includeDatabases?: string[],
  excludeDatabases?: string[],
  includeAssets?: boolean,
  maxAssetSize?: number,
  assetTypes?: AssetType[]
): Promise<BackupJobStartResponse> {
  return invoke<BackupJobStartResponse>('data_governance_backup_tiered', {
    tiers,
    includeDatabases,
    excludeDatabases,
    includeAssets,
    maxAssetSize,
    assetTypes,
  });
}

/**
 * 一步完成备份并导出 ZIP（异步后台任务）
 *
 * 默认执行完整备份（数据库 + 资产）并导出 ZIP 到用户指定路径。
 * 若 useTiered=true，则按分层配置执行备份后导出。
 */
export async function backupAndExportZip(
  outputPath: string,
  compressionLevel?: number,
  addToBackupList?: boolean,
  useTiered?: boolean,
  tiers?: BackupTier[],
  includeAssets?: boolean,
  assetTypes?: AssetType[],
): Promise<BackupJobStartResponse> {
  return invoke<BackupJobStartResponse>('data_governance_backup_and_export_zip', {
    outputPath,
    compressionLevel,
    addToBackupList,
    useTiered,
    tiers,
    includeAssets,
    assetTypes,
  });
}


// ==================== ZIP 导出 API ====================

/**
 * 将备份导出为 ZIP 文件（异步后台任务）
 *
 * 立即返回任务 ID，导出在后台执行。
 * 进度通过 `backup-job-progress` 事件发送。
 *
 * @param backupId 要导出的备份 ID
 * @param outputPath 输出 ZIP 文件路径（可选，默认自动生成）
 * @param compressionLevel 压缩级别 0-9（可选，默认 6）
 *   - 0: 不压缩（存储模式）
 *   - 1-3: 快速压缩
 *   - 4-6: 平衡（推荐）
 *   - 7-9: 最大压缩
 * @param includeChecksums 是否包含校验和文件（可选，默认 true）
 */
export async function exportZip(
  backupId: string,
  outputPath?: string,
  compressionLevel?: number,
  includeChecksums?: boolean
): Promise<BackupJobStartResponse> {
  return invoke<BackupJobStartResponse>('data_governance_export_zip', {
    backupId,
    outputPath,
    compressionLevel,
    includeChecksums,
  });
}


/**
 * 从 ZIP 文件导入备份（异步后台任务）
 *
 * 立即返回任务 ID，导入在后台执行。
 * 进度通过 `backup-job-progress` 事件发送。
 *
 * @param zipPath ZIP 文件路径
 * @param backupId 解压后的备份 ID（可选，默认从时间戳生成）
 */
export async function importZip(
  zipPath: string,
  backupId?: string
): Promise<BackupJobStartResponse> {
  return invoke<BackupJobStartResponse>('data_governance_import_zip', {
    zipPath,
    backupId,
  });
}


// ==================== 同步 API ====================

/**
 * 获取同步状态
 * 返回当前设备的同步状态信息
 */
export async function getSyncStatus(): Promise<SyncStatusResponse> {
  return invoke<SyncStatusResponse>('data_governance_get_sync_status');
}

/**
 * 检测同步冲突
 * @param cloudManifestJson 云端同步清单的 JSON 字符串（可选）
 */
export async function detectConflicts(
  cloudManifestJson?: string,
  cloudConfig?: CloudStorageConfig
): Promise<ConflictDetectionResponse> {
  return invoke<ConflictDetectionResponse>('data_governance_detect_conflicts', {
    cloudManifestJson,
    cloudConfig,
  });
}

/**
 * 解决同步冲突
 * @param strategy 合并策略
 * @param cloudManifestJson 云端同步清单的 JSON 字符串
 */
export async function resolveConflicts(
  strategy: MergeStrategy,
  cloudManifestJson: string
): Promise<SyncResultResponse> {
  return invoke<SyncResultResponse>('data_governance_resolve_conflicts', {
    strategy,
    cloudManifestJson,
  });
}

/**
 * 执行云存储同步
 * @param direction 同步方向：upload（上传）、download（下载）、bidirectional（双向）
 * @param cloudConfig 云存储配置
 * @param strategy 合并策略
 */
export async function runSync(
  direction: 'upload' | 'download' | 'bidirectional',
  cloudConfig?: CloudStorageConfig,
  strategy?: MergeStrategy
): Promise<SyncExecutionResponse> {
  return invoke<SyncExecutionResponse>('data_governance_run_sync', {
    direction,
    cloudConfig,
    strategy,
  });
}

/**
 * 导出同步数据到本地文件
 * @param outputPath 输出文件路径（可选，默认自动生成）
 */
export async function exportSyncData(outputPath?: string): Promise<SyncExportResponse> {
  return invoke<SyncExportResponse>('data_governance_export_sync_data', {
    outputPath,
  });
}

/**
 * 从本地文件导入同步数据
 * @param inputPath 输入文件路径
 * @param strategy 合并策略
 */
export async function importSyncData(
  inputPath: string,
  strategy?: MergeStrategy
): Promise<SyncImportResponse> {
  return invoke<SyncImportResponse>('data_governance_import_sync_data', {
    inputPath,
    strategy,
  });
}

// ==================== 带进度回调的同步 API ====================

/**
 * 监听同步进度事件
 *
 * @param options 监听器选项
 * @returns 取消监听函数
 *
 * @example
 * ```typescript
 * const unlisten = await listenSyncProgress({
 *   onProgress: (progress) => {
 *     console.log(`Phase: ${progress.phase}, Progress: ${progress.percent}%`);
 *   },
 *   onComplete: () => console.log('同步完成'),
 *   onError: (error) => console.error('同步失败:', error),
 * });
 *
 * // 开始同步
 * await runSyncWithProgress('bidirectional', cloudConfig);
 *
 * // 完成后取消监听
 * unlisten();
 * ```
 */
export async function listenSyncProgress(
  options: SyncProgressListenerOptions
): Promise<UnlistenFn> {
  let prevPhase: SyncPhase | null = null;

  return listen<SyncProgress>(SYNC_PROGRESS_EVENT, (event) => {
    const progress = event.payload;

    // 阶段变化回调
    if (options.onPhaseChange && progress.phase !== prevPhase) {
      options.onPhaseChange(progress.phase, prevPhase);
      prevPhase = progress.phase;
    }

    // 进度回调
    if (options.onProgress) {
      options.onProgress(progress);
    }

    // 完成回调
    if (progress.phase === 'completed' && options.onComplete) {
      options.onComplete();
    }

    // 失败回调
    if (progress.phase === 'failed' && options.onError && progress.error) {
      options.onError(progress.error);
    }
  });
}

/**
 * 执行带进度回调的云存储同步
 *
 * 与 `runSync` 类似，但会通过事件通道发送进度更新。
 * 建议先调用 `listenSyncProgress` 设置监听器。
 *
 * @param direction 同步方向：upload（上传）、download（下载）、bidirectional（双向）
 * @param cloudConfig 云存储配置
 * @param strategy 合并策略
 *
 * @example
 * ```typescript
 * // 设置进度监听
 * const unlisten = await listenSyncProgress({
 *   onProgress: (progress) => {
 *     setProgressPercent(progress.percent);
 *     setPhase(progress.phase);
 *   },
 *   onComplete: () => toast.success('同步完成'),
 *   onError: (error) => toast.error(`同步失败: ${error}`),
 * });
 *
 * try {
 *   const result = await runSyncWithProgress('bidirectional', cloudConfig, 'keep_latest');
 *   console.log('同步结果:', result);
 * } finally {
 *   unlisten();
 * }
 * ```
 */
export async function runSyncWithProgress(
  direction: 'upload' | 'download' | 'bidirectional',
  cloudConfig?: CloudStorageConfig,
  strategy?: MergeStrategy
): Promise<SyncExecutionResponse> {
  return invoke<SyncExecutionResponse>('data_governance_run_sync_with_progress', {
    direction,
    cloudConfig,
    strategy,
  });
}

/**
 * 执行同步并自动管理进度监听
 *
 * 这是一个便捷函数，自动设置和清理进度监听器。
 *
 * @param direction 同步方向
 * @param cloudConfig 云存储配置
 * @param options 进度监听选项
 * @param strategy 合并策略
 *
 * @example
 * ```typescript
 * const result = await runSyncWithProgressTracking(
 *   'bidirectional',
 *   cloudConfig,
 *   {
 *     onProgress: (progress) => updateUI(progress),
 *     onPhaseChange: (phase) => console.log('阶段:', phase),
 *   },
 *   'keep_latest'
 * );
 * ```
 */
export async function runSyncWithProgressTracking(
  direction: 'upload' | 'download' | 'bidirectional',
  cloudConfig: CloudStorageConfig | undefined,
  options: SyncProgressListenerOptions,
  strategy?: MergeStrategy
): Promise<SyncExecutionResponse> {
  // 设置监听器
  const unlisten = await listenSyncProgress(options);

  try {
    // 执行同步
    return await runSyncWithProgress(direction, cloudConfig, strategy);
  } finally {
    // 清理监听器
    unlisten();
  }
}

/**
 * 创建同步进度 Hook 状态管理器
 *
 * 返回一个对象，包含当前进度状态和控制函数。
 * 适用于 React 等框架集成。
 *
 * @example
 * ```typescript
 * // 在 React 组件中使用
 * const [syncState, setSyncState] = useState(createSyncProgressState());
 *
 * const handleSync = async () => {
 *   await runSyncWithProgressTracking('bidirectional', config, {
 *     onProgress: (progress) => setSyncState(prev => ({
 *       ...prev,
 *       progress,
 *       isRunning: !isSyncPhaseTerminal(progress.phase),
 *     })),
 *     onComplete: () => setSyncState(prev => ({ ...prev, isRunning: false })),
 *     onError: (error) => setSyncState(prev => ({ ...prev, isRunning: false, error })),
 *   });
 * };
 * ```
 */
export function createSyncProgressState() {
  return {
    /** 当前进度 */
    progress: null as SyncProgress | null,
    /** 是否正在同步 */
    isRunning: false,
    /** 错误信息 */
    error: null as string | null,
  };
}

// ==================== 资产管理 API ====================

/**
 * 扫描资产目录
 * @param assetTypes 要扫描的资产类型列表（可选，为空则扫描全部）
 */
export async function scanAssets(assetTypes?: string[]): Promise<AssetScanResponse> {
  return invoke<AssetScanResponse>('data_governance_scan_assets', {
    assetTypes,
  });
}

/**
 * 获取支持的资产类型
 * 返回系统支持的所有资产类型及其信息
 */
export async function getAssetTypes(): Promise<AssetTypeInfo[]> {
  return invoke<AssetTypeInfo[]>('data_governance_get_asset_types');
}

/**
 * 包含资产的恢复响应
 */
export interface RestoreWithAssetsResponse {
  success: boolean;
  backup_id: string;
  duration_ms: number;
  databases_restored: string[];
  pre_restore_backup_path?: string;
  error_message?: string;
  assets_restored?: number;
}

/**
 * 从备份恢复（含资产）
 * @param backupId 要恢复的备份 ID
 * @param restoreAssets 是否恢复资产文件
 */
export async function restoreWithAssets(
  backupId: string,
  restoreAssets?: boolean
): Promise<RestoreWithAssetsResponse> {
  return invoke<RestoreWithAssetsResponse>('data_governance_restore_with_assets', {
    backupId,
    restoreAssets,
  });
}

/**
 * 验证备份完整性（含资产）
 * @param backupId 要验证的备份 ID
 */
export async function verifyBackupWithAssets(
  backupId: string
): Promise<BackupVerifyWithAssetsResponse> {
  return invoke<BackupVerifyWithAssetsResponse>('data_governance_verify_backup_with_assets', {
    backupId,
  });
}

// ==================== Chat V2 迁移 API ====================

/**
 * Chat V2 迁移检查结果
 */
export interface ChatMigrationCheckResult {
  needsMigration: boolean;
  pendingMessages: number;
  pendingSessions: number;
  migratedMessages: number;
  canRollback: boolean;
  lastMigrationAt: number | null;
}

/**
 * Chat V2 迁移报告
 */
export interface ChatMigrationReport {
  status: 'not_started' | 'in_progress' | 'completed' | 'rolled_back' | 'failed';
  sessionsCreated: number;
  messagesMigrated: number;
  blocksCreated: number;
  attachmentsCreated: number;
  messagesSkipped: number;
  errors: string[];
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

/**
 * 检查 Chat V2 迁移状态
 * 返回是否需要迁移以及当前迁移进度
 */
export async function checkChatMigrationStatus(): Promise<ChatMigrationCheckResult> {
  return invoke<ChatMigrationCheckResult>('chat_v2_check_migration_status');
}

/**
 * 执行旧版聊天数据迁移到 Chat V2
 * 返回迁移报告
 */
export async function migrateLegacyChat(): Promise<ChatMigrationReport> {
  return invoke<ChatMigrationReport>('chat_v2_migrate_legacy_chat');
}

/**
 * 回滚 Chat V2 迁移
 * 返回回滚报告
 */
export async function rollbackChatMigration(): Promise<ChatMigrationReport> {
  return invoke<ChatMigrationReport>('chat_v2_rollback_migration');
}

// ==================== 媒体缓存 API ====================

/**
 * 媒体缓存统计信息
 */
export interface MediaCacheStats {
  pdfPreviewCount: number;
  pdfPreviewSize: number;
  compressedImageCount: number;
  compressedImageSize: number;
  ocrTextCount: number;
  vectorIndexCount: number;
  vectorIndexSize: number;
  totalSize: number;
}

/**
 * 清理媒体缓存选项
 */
export interface ClearMediaCacheOptions {
  clearPdfPreview: boolean;
  clearCompressedImages: boolean;
  clearOcrText: boolean;
  clearVectorIndex: boolean;
}

/**
 * 清理媒体缓存结果
 */
export interface ClearMediaCacheResult {
  pdfPreviewCleared: number;
  compressedImagesCleared: number;
  ocrTextCleared: number;
  vectorIndexCleared: number;
  totalBytesFreed: number;
  filesReset: number;
}

/**
 * 获取媒体缓存统计信息
 * 返回 PDF 预览、压缩图片、OCR 文本、向量索引等缓存的统计数据
 */
export async function getMediaCacheStats(): Promise<MediaCacheStats> {
  return invoke<MediaCacheStats>('vfs_get_media_cache_stats');
}

/**
 * 清理媒体缓存
 * @param options 指定要清理的缓存类型（可选，默认全部清理）
 */
export async function clearMediaCache(options?: ClearMediaCacheOptions): Promise<ClearMediaCacheResult> {
  return invoke<ClearMediaCacheResult>('vfs_clear_media_cache', {
    params: options,
  });
}

// ==================== 磁盘空间检查 API ====================

/**
 * 磁盘空间检查响应
 */
export interface DiskSpaceCheckResponse {
  /** 是否有足够空间 */
  has_enough_space: boolean;
  /** 可用空间（字节） */
  available_bytes: number;
  /** 需要空间（字节，含安全余量） */
  required_bytes: number;
  /** 备份大小（字节） */
  backup_size: number;
}

export interface SlotMigrationTestResponse {
  success: boolean;
  report: string;
}

/**
 * 检查恢复备份所需的磁盘空间
 *
 * 在恢复操作前调用，检查目标磁盘是否有足够空间。
 * 后端会计算备份大小 + 预恢复备份空间 + 20% 安全余量。
 *
 * @param backupId 要恢复的备份 ID
 * @returns 磁盘空间检查结果
 */
export async function checkDiskSpaceForRestore(
  backupId: string
): Promise<DiskSpaceCheckResponse> {
  try {
    return await invoke<DiskSpaceCheckResponse>('data_governance_check_disk_space_for_restore', {
      backupId,
    });
  } catch {
    // 如果后端尚未实现该命令，返回"空间足够"以不阻塞流程
    return {
      has_enough_space: true,
      available_bytes: 0,
      required_bytes: 0,
      backup_size: 0,
    };
  }
}

// ==================== 迁移诊断 API ====================

/**
 * 获取迁移诊断报告
 * 收集所有数据库状态、错误信息、迁移历史、磁盘空间等，返回格式化文本
 */
export async function getMigrationDiagnosticReport(): Promise<string> {
  return invoke<string>('data_governance_get_migration_diagnostic_report');
}

/**
 * 手动触发 Slot C 空库迁移测试
 */
export async function runSlotCEmptyDbTest(): Promise<SlotMigrationTestResponse> {
  return invoke<SlotMigrationTestResponse>('data_governance_run_slot_c_empty_db_test');
}

/**
 * 手动触发 Slot D 克隆库迁移测试
 */
export async function runSlotDCloneDbTest(): Promise<SlotMigrationTestResponse> {
  return invoke<SlotMigrationTestResponse>('data_governance_run_slot_d_clone_db_test');
}

// ==================== 导出统一的 API 对象 ====================

export const DataGovernanceApi = {
  // Schema 相关
  getSchemaRegistry,
  getMigrationStatus,
  getDatabaseStatus,
  runHealthCheck,

  // 审计日志
  getAuditLogs,
  cleanupAuditLogs,

  // 备份配置
  getBackupConfig,
  setBackupConfig,

  // 备份管理
  runBackup,
  getBackupList,
  deleteBackup,
  verifyBackup,
  autoVerifyLatestBackup,
  restoreBackup,

  // 后台备份任务
  cancelBackup,
  getBackupJob,
  listBackupJobs,
  listenBackupProgress,
  isBackupJobTerminal,

  // 任务恢复
  resumeBackupJob,
  listResumableJobs,
  cleanupPersistedJobs,

  // 分层备份
  backupTiered,
  backupAndExportZip,

  // ZIP 导出/导入
  exportZip,
  importZip,

  // 资产管理
  scanAssets,
  getAssetTypes,
  restoreWithAssets,
  verifyBackupWithAssets,

  // 磁盘空间检查
  checkDiskSpaceForRestore,

  // 迁移诊断
  getMigrationDiagnosticReport,
  runSlotCEmptyDbTest,
  runSlotDCloneDbTest,

  // 维护模式
  getMaintenanceStatus,

  // Chat V2 迁移
  checkChatMigrationStatus,
  migrateLegacyChat,
  rollbackChatMigration,

  // 媒体缓存
  getMediaCacheStats,
  clearMediaCache,

  // 同步管理
  getSyncStatus,
  detectConflicts,
  resolveConflicts,
  runSync,
  exportSyncData,
  importSyncData,

  // 带进度的同步
  listenSyncProgress,
  runSyncWithProgress,
  runSyncWithProgressTracking,
  createSyncProgressState,
};

export default DataGovernanceApi;
