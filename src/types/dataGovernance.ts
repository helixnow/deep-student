/**
 * 数据治理系统类型定义
 *
 * 对应后端 Tauri 命令的请求/响应类型
 */

// ==================== Schema 相关类型 ====================

/** Schema 注册表响应 */
export interface SchemaRegistryResponse {
  /** 全局版本号 */
  global_version: number;
  /** 聚合时间 */
  aggregated_at: string;
  /** 数据库状态列表 */
  databases: DatabaseStatusResponse[];
}

/** 数据库状态响应 */
export interface DatabaseStatusResponse {
  /** 数据库 ID */
  id: string;
  /** Schema 版本 */
  schema_version: number;
  /** 最小兼容版本 */
  min_compatible_version: number;
  /** 最大兼容版本 */
  max_compatible_version: number;
  /** 数据契约版本 */
  data_contract_version: string;
  /** 迁移历史数量 */
  migration_count: number;
  /** 校验和 */
  checksum: string;
  /** 更新时间 */
  updated_at: string;
}

/** 迁移状态响应 */
export interface MigrationStatusResponse {
  /** 全局版本号 */
  global_version: number;
  /** 是否全部健康 */
  all_healthy: boolean;
  /** 数据库迁移状态列表 */
  databases: MigrationDatabaseStatus[];
  /** 待执行迁移总数 */
  pending_migrations_total: number;
  /** 是否有待执行迁移 */
  has_pending_migrations: boolean;
  /** 最后的迁移错误（如果有） */
  last_error: string | null;
}

/** 迁移数据库状态 */
export interface MigrationDatabaseStatus {
  /** 数据库 ID */
  id: string;
  /** 当前版本 */
  current_version: number;
  /** 目标版本（最新可用迁移版本） */
  target_version: number;
  /** 是否已初始化 */
  is_initialized: boolean;
  /** 上次迁移时间 */
  last_migration_at: string | null;
  /** 待执行迁移数量 */
  pending_count: number;
  /** 是否有待执行迁移 */
  has_pending: boolean;
}

/** 健康检查响应 */
export interface HealthCheckResponse {
  /** 整体是否健康 */
  overall_healthy: boolean;
  /** 数据库总数 */
  total_databases: number;
  /** 已初始化数量 */
  initialized_count: number;
  /** 未初始化数量 */
  uninitialized_count: number;
  /** 依赖检查是否通过 */
  dependency_check_passed: boolean;
  /** 依赖错误信息 */
  dependency_error: string | null;
  /** 数据库健康状态列表 */
  databases: DatabaseHealthStatus[];
  /** 检查时间 */
  checked_at: string;
  /** 待执行迁移总数 */
  pending_migrations_count: number;
  /** 是否有待执行迁移 */
  has_pending_migrations: boolean;
  /** 审计写入是否健康 */
  audit_log_healthy: boolean;
  /** 审计写入错误（如果有） */
  audit_log_error: string | null;
  /** 审计写入错误时间（如果有） */
  audit_log_error_at: string | null;
}

/** 数据库健康状态 */
export interface DatabaseHealthStatus {
  /** 数据库 ID */
  id: string;
  /** 是否健康 */
  is_healthy: boolean;
  /** 依赖是否满足 */
  dependencies_met: boolean;
  /** Schema 版本 */
  schema_version: number;
  /** 目标版本（最新可用迁移版本） */
  target_version: number;
  /** 待执行迁移数量 */
  pending_count: number;
  /** 问题列表 */
  issues: string[];
}

/** 数据库详情响应 */
export interface DatabaseDetailResponse {
  /** 数据库 ID */
  id: string;
  /** Schema 版本 */
  schema_version: number;
  /** 最小兼容版本 */
  min_compatible_version: number;
  /** 最大兼容版本 */
  max_compatible_version: number;
  /** 数据契约版本 */
  data_contract_version: string;
  /** 校验和 */
  checksum: string;
  /** 更新时间 */
  updated_at: string;
  /** 迁移历史 */
  migration_history: MigrationRecordResponse[];
  /** 依赖列表 */
  dependencies: string[];
}

/** 迁移记录响应 */
export interface MigrationRecordResponse {
  /** 版本号 */
  version: number;
  /** 迁移名称 */
  name: string;
  /** 校验和 */
  checksum: string;
  /** 应用时间 */
  applied_at: string;
  /** 执行耗时（毫秒） */
  duration_ms: number | null;
  /** 是否成功 */
  success: boolean;
}

// ==================== 审计日志类型 ====================

/** 审计日志响应 */
export interface AuditLogResponse {
  /** 日志 ID */
  id: string;
  /** 时间戳 */
  timestamp: string;
  /** 操作类型 */
  operation_type: AuditOperationType;
  /** 目标 */
  target: string;
  /** 状态 */
  status: AuditStatus;
  /** 执行耗时（毫秒） */
  duration_ms: number | null;
  /** 错误信息 */
  error_message: string | null;
}

/** 审计操作类型 */
export type AuditOperationType = 'Migration' | 'Backup' | 'Restore' | 'Sync' | 'Maintenance';

/** 审计状态 */
export type AuditStatus = 'Started' | 'Completed' | 'Failed' | 'Partial';

/** 审计日志过滤器 */
export interface AuditLogFilter {
  /** 操作类型 */
  operation_type?: AuditOperationType;
  /** 状态 */
  status?: AuditStatus;
  /** 限制数量 */
  limit?: number;
  /** 偏移量（用于分页） */
  offset?: number;
}

/** 审计日志分页响应 */
export interface AuditLogPagedResponse {
  /** 当前页的审计日志列表 */
  logs: AuditLogResponse[];
  /** 满足过滤条件的总记录数（不受 limit/offset 影响） */
  total: number;
}

// ==================== 备份相关类型 ====================

/** 备份类型 */
export type BackupType = 'full' | 'incremental';

/** 备份结果响应 */
export interface BackupResultResponse {
  /** 是否成功 */
  success: boolean;
  /** 备份路径/ID */
  backup_path: string;
  /** 备份大小（字节） */
  backup_size: number;
  /** 执行耗时（毫秒） */
  duration_ms: number;
  /** 已备份的数据库列表 */
  databases_backed_up: string[];
  /** 资产备份摘要（如果包含资产备份） */
  assets_backed_up?: AssetBackupSummary;
}

/** 资产备份摘要 */
export interface AssetBackupSummary {
  /** 备份的文件总数 */
  total_files: number;
  /** 备份的总大小（字节） */
  total_size: number;
  /** 按资产类型统计 */
  by_type: Record<string, AssetTypeStats>;
}

/** 资产类型统计 */
export interface AssetTypeStats {
  /** 文件数量 */
  file_count: number;
  /** 总大小（字节） */
  total_size: number;
}

/** 备份信息响应 */
export interface BackupInfoResponse {
  /** 备份路径/ID */
  path: string;
  /** 创建时间 */
  created_at: string;
  /** 备份大小（字节） */
  size: number;
  /** 备份类型 */
  backup_type: BackupType;
  /** 包含的数据库列表 */
  databases: string[];
}

/** 备份验证响应 */
export interface BackupVerifyResponse {
  /** 是否有效 */
  is_valid: boolean;
  /** 校验和是否匹配 */
  checksum_match: boolean;
  /** 数据库验证状态 */
  databases_verified: DatabaseVerifyStatus[];
  /** 错误列表 */
  errors: string[];
}

/** 数据库验证状态 */
export interface DatabaseVerifyStatus {
  /** 数据库 ID */
  id: string;
  /** 是否有效 */
  is_valid: boolean;
  /** 错误信息 */
  error: string | null;
}

/** 自动验证响应 */
export interface AutoVerifyResponse {
  /** 被验证的备份 ID */
  backup_id: string;
  /** 是否通过验证 */
  is_valid: boolean;
  /** 验证时间 (ISO 8601) */
  verified_at: string;
  /** 验证耗时（毫秒） */
  duration_ms: number;
  /** 数据库验证状态 */
  databases_verified: DatabaseVerifyStatus[];
  /** 错误列表 */
  errors: string[];
}

/** 恢复结果响应 */
export interface RestoreResultResponse {
  /** 是否成功 */
  success: boolean;
  /** 备份 ID */
  backup_id: string;
  /** 执行耗时（毫秒） */
  duration_ms: number;
  /** 已恢复的数据库列表 */
  databases_restored: string[];
  /** 预恢复备份路径 */
  pre_restore_backup_path: string | null;
  /** 错误信息 */
  error_message: string | null;
  /** 恢复的资产文件数量 */
  assets_restored?: number;
}

// ==================== 分层备份类型 ====================

/**
 * 备份层级
 *
 * 2026-02 更新：
 * - core: chat_v2.db, vfs.db, mistakes.db（核心用户数据）
 * - important: llm_usage.db + notes_assets/（LLM 使用统计）
 * - rebuildable: lance/（向量索引，可重建）
 * - large_assets: images/, documents/, videos/（大型文件）
 *
 * 注意：mistakes.db 为主数据库（历史命名），包含 anki_cards、settings 等活跃表
 */
export type BackupTier = 'core' | 'important' | 'rebuildable' | 'large_assets';

/** Translation function type for i18n integration — uses i18next TFunction for compatibility */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DataGovernanceTFn = (...args: any[]) => any;

/** 获取备份层级显示名称（i18n） */
export function getBackupTierDisplayName(tier: BackupTier, t: DataGovernanceTFn): string {
  const keys: Record<BackupTier, string> = {
    core: 'data:governance.backup_tier_name.core',
    important: 'data:governance.backup_tier_name.important',
    rebuildable: 'data:governance.backup_tier_name.rebuildable',
    large_assets: 'data:governance.backup_tier_name.large_assets',
  };
  return t(keys[tier]);
}

/** 获取备份层级描述（i18n） */
export function getBackupTierDescription(tier: BackupTier, t: DataGovernanceTFn): string {
  const keys: Record<BackupTier, string> = {
    core: 'data:governance.backup_tier_desc.core',
    important: 'data:governance.backup_tier_desc.important',
    rebuildable: 'data:governance.backup_tier_desc.rebuildable',
    large_assets: 'data:governance.backup_tier_desc.large_assets',
  };
  return t(keys[tier]);
}

/** 分层备份结果响应 */
export interface TieredBackupResultResponse {
  /** 是否成功 */
  success: boolean;
  /** 备份 ID */
  backup_id: string;
  /** 备份路径 */
  backup_path: string;
  /** 备份的层级 */
  backed_up_tiers: string[];
  /** 各层级的文件数量 */
  tier_file_counts: Record<string, number>;
  /** 各层级的大小（字节） */
  tier_sizes: Record<string, number>;
  /** 总文件数 */
  total_files: number;
  /** 总大小（字节） */
  total_size: number;
  /** 跳过的文件数量 */
  skipped_files_count: number;
  /** 执行耗时（毫秒） */
  duration_ms: number;
}

// ==================== ZIP 导出类型 ====================

/** ZIP 导出结果响应 */
export interface ZipExportResultResponse {
  /** 是否成功 */
  success: boolean;
  /** ZIP 文件路径 */
  zip_path: string;
  /** 原始总大小（字节） */
  total_size: number;
  /** 压缩后大小（字节） */
  compressed_size: number;
  /** 压缩率（0.0-1.0） */
  compression_ratio: number;
  /** 文件数量 */
  file_count: number;
  /** 执行耗时（毫秒） */
  duration_ms: number;
  /** ZIP 文件的 SHA256 校验和 */
  zip_checksum: string;
}

/** ZIP 导入结果响应 */
export interface ZipImportResultResponse {
  /** 是否成功 */
  success: boolean;
  /** 备份 ID */
  backup_id: string;
  /** 备份路径 */
  backup_path: string;
  /** 导入的文件数量 */
  file_count: number;
}

/** 格式化压缩率 */
export function formatCompressionRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

// ==================== 同步相关类型 ====================

/** 同步状态响应 */
export interface SyncStatusResponse {
  /** 是否有待同步的变更 */
  has_pending_changes: boolean;
  /** 待同步变更总数 */
  total_pending_changes: number;
  /** 已同步变更总数 */
  total_synced_changes: number;
  /** 各数据库的同步状态 */
  databases: DatabaseSyncStatusResponse[];
  /** 上次同步时间 */
  last_sync_at: string | null;
  /** 设备 ID */
  device_id: string;
}

/** 数据库同步状态响应 */
export interface DatabaseSyncStatusResponse {
  /** 数据库 ID */
  id: string;
  /** 是否有变更日志表 */
  has_change_log: boolean;
  /** 待同步变更数量 */
  pending_changes: number;
  /** 已同步变更数量 */
  synced_changes: number;
  /** 上次同步时间 */
  last_sync_at: string | null;
}

/** 冲突检测响应 */
export interface ConflictDetectionResponse {
  /** 是否有冲突 */
  has_conflicts: boolean;
  /** 是否需要迁移 */
  needs_migration: boolean;
  /** 数据库级冲突列表 */
  database_conflicts: DatabaseConflictResponse[];
  /** 记录级冲突数量 */
  record_conflict_count: number;
  /** 本地清单 JSON */
  local_manifest_json: string | null;
  /** 云端清单 JSON（可能为空：未配置云存储或云端没有清单） */
  cloud_manifest_json?: string | null;
}

/** 数据库冲突响应 */
export interface DatabaseConflictResponse {
  /** 数据库名称 */
  database_name: string;
  /** 冲突类型 */
  conflict_type: string;
  /** 本地数据版本 */
  local_version: number | null;
  /** 云端数据版本 */
  cloud_version: number | null;
  /** 本地 Schema 版本 */
  local_schema_version: number | null;
  /** 云端 Schema 版本 */
  cloud_schema_version: number | null;
}

/** 合并策略 */
export type MergeStrategy = 'keep_local' | 'use_cloud' | 'keep_latest' | 'manual';

/** 同步结果响应 */
export interface SyncResultResponse {
  /** 是否成功 */
  success: boolean;
  /** 使用的合并策略 */
  strategy: string;
  /** 同步的数据库数量 */
  synced_databases: number;
  /** 解决的冲突数量 */
  resolved_conflicts: number;
  /** 待手动处理的冲突数量 */
  pending_manual_conflicts: number;
  /** 需要推送到云端的记录 ID 列表 */
  records_to_push: string[];
  /** 需要从云端拉取的记录 ID 列表 */
  records_to_pull: string[];
  /** 执行耗时（毫秒） */
  duration_ms: number;
  /** 错误信息 */
  error_message: string | null;
}

// ==================== 资产备份类型 ====================

/** 资产类型 */
export type AssetType =
  | 'images'
  | 'notes_assets'
  | 'documents'
  | 'vfs_blobs'
  | 'subjects'
  | 'workspaces'
  | 'audio'
  | 'videos';

/** 资产类型信息 */
export interface AssetTypeInfo {
  /** 资产类型 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 相对路径 */
  relative_path: string;
  /** 优先级（0 为最高） */
  priority: number;
}

/** 获取资产类型显示名称（i18n），未知 type 返回原值 */
export function getAssetTypeDisplayName(type: AssetType | string, t: DataGovernanceTFn): string {
  const keys: Record<AssetType, string> = {
    images: 'data:governance.asset_type.images',
    notes_assets: 'data:governance.asset_type.notes_assets',
    documents: 'data:governance.asset_type.documents',
    vfs_blobs: 'data:governance.asset_type.vfs_blobs',
    subjects: 'data:governance.asset_type.subjects',
    workspaces: 'data:governance.asset_type.workspaces',
    audio: 'data:governance.asset_type.audio',
    videos: 'data:governance.asset_type.videos',
  };
  const key = (keys as Record<string, string>)[type];
  return key ? t(key) : type;
}

/** 资产扫描响应 */
export interface AssetScanResponse {
  /** 按资产类型统计 */
  by_type: Record<string, AssetTypeStats>;
  /** 总文件数 */
  total_files: number;
  /** 总大小（字节） */
  total_size: number;
}

/** 资产备份配置 */
export interface AssetBackupConfig {
  /** 要备份的资产类型 */
  asset_types: AssetType[];
  /** 是否计算校验和 */
  compute_checksum: boolean;
  /** 单文件最大大小（字节） */
  max_file_size: number;
  /** 总大小限制（字节） */
  max_total_size: number;
  /** 跳过符号链接 */
  skip_symlinks: boolean;
  /** 跳过敏感文件 */
  skip_sensitive_files: boolean;
}

/** 备份验证响应（含资产） */
export interface BackupVerifyWithAssetsResponse {
  /** 是否全部有效 */
  is_valid: boolean;
  /** 数据库验证错误 */
  database_errors: string[];
  /** 资产验证错误 */
  asset_errors: AssetVerifyErrorResponse[];
  /** 是否包含资产 */
  has_assets: boolean;
  /** 资产文件数量 */
  asset_file_count: number;
}

/** 资产验证错误响应 */
export interface AssetVerifyErrorResponse {
  /** 文件路径 */
  path: string;
  /** 错误类型 */
  error_type: string;
  /** 错误信息 */
  message: string;
}

/** 备份的资产文件 */
export interface BackedUpAsset {
  /** 资产类型 */
  asset_type: AssetType;
  /** 相对路径（相对于备份目录） */
  relative_path: string;
  /** 原始路径（相对于应用数据目录） */
  original_path: string;
  /** 文件大小 */
  size: number;
  /** SHA256 校验和（可选） */
  checksum?: string;
  /** 修改时间 */
  modified_at?: string;
  /** 是否是目录 */
  is_directory: boolean;
}

// ==================== UI 相关类型 ====================

/** Dashboard Tab 类型 */
export type DashboardTab = 'overview' | 'backup' | 'sync' | 'audit' | 'cache' | 'debug';

/**
 * 数据库 ID 类型（治理范围内的数据库）
 *
 * 治理覆盖：vfs, chat_v2, mistakes, llm_usage
 *
 * 明确豁免（不纳入数据治理）：
 * - message_queue.db — 运行时临时队列，重启后自动重建
 * - ws_*.db — 工作空间独立数据库，随工作空间生命周期管理
 * - resources.db — 已废弃的兼容期资源数据库，仅读不写
 */
export type DatabaseId = 'vfs' | 'chat_v2' | 'mistakes' | 'llm_usage';

/** 获取数据库显示名称（i18n），未知 id 返回原值 */
export function getDatabaseDisplayName(id: DatabaseId | string, t: DataGovernanceTFn): string {
  const keys: Record<DatabaseId, string> = {
    vfs: 'data:governance.database_name.vfs',
    chat_v2: 'data:governance.database_name.chat_v2',
    mistakes: 'data:governance.database_name.mistakes',
    llm_usage: 'data:governance.database_name.llm_usage',
  };
  const key = (keys as Record<string, string>)[id];
  return key ? t(key) : id;
}

/** 格式化字节大小 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes === 0) return '0 B';
  if (bytes < 0) bytes = Math.abs(bytes);
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/** 格式化时间戳 */
export function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return timestamp;
  }
}

/** 格式化持续时间 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

// ==================== 云存储同步类型 ====================

/** 云存储提供商类型（与后端 `StorageProvider` 对齐） */
export type CloudStorageProvider = 'webdav' | 's3';

/** WebDAV 配置（与后端 `WebDavConfig` 对齐，camelCase） */
export interface WebDavConfig {
  endpoint: string;
  username: string;
  /** 密码或应用专用密码（可为空：某些 WebDAV 支持匿名） */
  password: string;
}

/** S3 兼容存储配置（与后端 `S3Config` 对齐，camelCase） */
export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** 是否使用 path-style 地址（MinIO 等需要） */
  pathStyle?: boolean;
}

/** 云存储配置（与后端 `CloudStorageConfig` 对齐，camelCase） */
export interface CloudStorageConfig {
  provider: CloudStorageProvider;
  webdav?: WebDavConfig;
  s3?: S3Config;
  /** 根目录路径（所有操作都在此目录下） */
  root?: string;
}

/** 同步执行响应 */
export interface SyncExecutionResponse {
  /** 是否成功 */
  success: boolean;
  /** 同步方向 */
  direction: string;
  /** 上传的变更数 */
  changes_uploaded: number;
  /** 下载的变更数 */
  changes_downloaded: number;
  /** 检测到的冲突数 */
  conflicts_detected: number;
  /** 耗时（毫秒） */
  duration_ms: number;
  /** 设备 ID */
  device_id: string;
  /** 错误/警告信息 */
  error_message: string | null;
  /** 被跳过的变更数量（如旧格式数据不完整），0 表示全部成功 */
  skipped_changes: number;
}

/** 同步导出响应 */
export interface SyncExportResponse {
  /** 是否成功 */
  success: boolean;
  /** 输出文件路径 */
  output_path: string;
  /** 清单中的数据库数 */
  databases_count: number;
  /** 待同步变更数 */
  pending_changes_count: number;
  /** 错误信息 */
  error_message: string | null;
}

/** 同步导入响应 */
export interface SyncImportResponse {
  /** 是否成功 */
  success: boolean;
  /** 导入的变更数 */
  imported_changes: number;
  /** 检测到的冲突数 */
  conflicts_detected: number;
  /** 是否需要手动解决 */
  needs_manual_resolution: boolean;
  /** 错误信息 */
  error_message: string | null;
}

// ==================== 同步进度类型 ====================

/** 同步进度事件名称 */
export const SYNC_PROGRESS_EVENT = 'data-governance-sync-progress';

/** 同步阶段 */
export type SyncPhase =
  | 'preparing'
  | 'detecting_changes'
  | 'uploading'
  | 'downloading'
  | 'applying'
  | 'completed'
  | 'failed';

/** 获取同步阶段显示名称（i18n），未知 phase 返回原值 */
export function getSyncPhaseName(phase: SyncPhase | string, t: DataGovernanceTFn): string {
  const keys: Record<SyncPhase, string> = {
    preparing: 'data:governance.sync_phase.preparing',
    detecting_changes: 'data:governance.sync_phase.detecting_changes',
    uploading: 'data:governance.sync_phase.uploading',
    downloading: 'data:governance.sync_phase.downloading',
    applying: 'data:governance.sync_phase.applying',
    completed: 'data:governance.sync_phase.completed',
    failed: 'data:governance.sync_phase.failed',
  };
  const key = (keys as Record<string, string>)[phase];
  return key ? t(key) : phase;
}

/** 同步进度 */
export interface SyncProgress {
  /** 当前阶段 */
  phase: SyncPhase;
  /** 进度百分比 (0-100) */
  percent: number;
  /** 当前处理的项目数 */
  current: number;
  /** 总项目数 */
  total: number;
  /** 当前处理的文件/记录名 */
  current_item: string | null;
  /** 传输速度（字节/秒） */
  speed_bytes_per_sec: number | null;
  /** 预计剩余时间（秒） */
  eta_seconds: number | null;
  /** 错误信息（如果有） */
  error: string | null;
}

/** 判断是否为终止状态 */
export function isSyncPhaseTerminal(phase: SyncPhase): boolean {
  return phase === 'completed' || phase === 'failed';
}

/** 格式化传输速度 */
export function formatSpeed(bytesPerSec: number | null): string {
  if (bytesPerSec === null || bytesPerSec === 0) return '-';

  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let unitIndex = 0;
  let speed = bytesPerSec;

  while (speed >= 1024 && unitIndex < units.length - 1) {
    speed /= 1024;
    unitIndex++;
  }

  return `${speed.toFixed(1)} ${units[unitIndex]}`;
}

/** 格式化剩余时间（纯数字格式，无 i18n 依赖） */
export function formatEta(seconds: number | null): string {
  if (seconds === null) return '-';

  if (seconds < 60) {
    return `${seconds}s`;
  }

  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** 同步进度事件回调 */
export type SyncProgressCallback = (progress: SyncProgress) => void;

/** 同步进度监听器选项 */
export interface SyncProgressListenerOptions {
  /** 进度回调 */
  onProgress?: SyncProgressCallback;
  /** 完成回调 */
  onComplete?: () => void;
  /** 失败回调 */
  onError?: (error: string) => void;
  /** 阶段变化回调 */
  onPhaseChange?: (phase: SyncPhase, prevPhase: SyncPhase | null) => void;
}
