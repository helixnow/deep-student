import type {
  AssetScanResponse, AssetTypeInfo, AssetVerifyErrorResponse, BackupJobResultPayload,
  BackupInfoResponse, BackupJobStartResponse, BackupJobSummary, DataGovernanceOperationKind, DataGovernanceOperationSnapshot,
  dstu_storage__backup_common__ImportProgress as ImportProgress,
} from '../../../contracts/ipc/generated/L21-backup-governance.ts';
import type {
  BackupJobKind, BackupJobPhase, BackupJobStatus, JobCheckpoint, PersistedJob,
} from '../../../contracts/ipc/generated/_shared.ts';
import type { RuntimeCloudStorageConfig } from '../sync-providers/api.ts';

export type {
  AssetScanResponse, AssetTypeInfo, AssetVerifyErrorResponse, BackupJobResultPayload,
  BackupInfoResponse, BackupJobStartResponse, BackupJobSummary, DataGovernanceOperationKind, DataGovernanceOperationSnapshot,
} from '../../../contracts/ipc/generated/L21-backup-governance.ts';
export type {
  dstu_storage__backup_common__ImportProgress as ImportProgress,
} from '../../../contracts/ipc/generated/L21-backup-governance.ts';
export type {
  BackupJobKind, BackupJobPhase, BackupJobStatus, JobCheckpoint, PersistedJob,
} from '../../../contracts/ipc/generated/_shared.ts';

/** backup_job_manager.rs:316; optional fields are omitted when None. */
export interface BackupJobParams {
  backup_type?: string;
  base_version?: string;
  include_assets: boolean;
  asset_types?: string[];
  zip_path?: string;
  backup_id?: string;
  output_path?: string;
  compression_level?: number;
  include_checksums: boolean;
}

/** The unresolved backup-job-progress wire payload is BackupJobEvent (Rust:172). */
export interface BackupJobEvent {
  job_id: string;
  kind: BackupJobKind;
  status: BackupJobStatus;
  phase: BackupJobPhase;
  progress: number;
  message: string | null;
  processed_items: number;
  total_items: number;
  eta_seconds: number | null;
  cancellable: boolean;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  result?: BackupJobResultPayload;
}

export interface BackupJobContext {
  readonly job_id: string;
  isCancelled(): boolean;
  checkContinue(): void;
  markRunning(phase: BackupJobPhase, progress: number, message: string | null, processed: number, total: number): void;
  complete(message: string | null, processed: number, total: number, result: BackupJobResultPayload): void;
  fail(error: string): void;
  cancelled(message: string | null): void;
  emitLegacyProgress(progress: ImportProgress): void;
  setParams(params: BackupJobParams): void;
  initCheckpoint(total: number): void;
  updateCheckpoint(item: string): void;
  updateZipCheckpoint(current: number, total: number): void;
  setPartialOutput(path: string): void;
  getProcessedItems(): string[];
  isItemProcessed(item: string): boolean;
  getCheckpoint(): JobCheckpoint | null;
  restoreCheckpoint(checkpoint: JobCheckpoint): void;
  setMaxDuration(durationMs: number | null): void;
}

export interface BackupJobManager {
  createJob(kind: BackupJobKind): BackupJobContext;
  createJobWithId(id: string, kind: BackupJobKind): BackupJobContext;
  requestCancel(id: string): boolean;
  listJobs(): BackupJobSummary[];
  getJob(id: string): BackupJobSummary | null;
  persistJob(id: string): void;
  loadPersistedJobs(): PersistedJob[];
  deletePersistedJob(id: string): void;
  restoreJobFromPersisted(job: PersistedJob): BackupJobContext;
  listResumableJobs(): PersistedJob[];
  cleanupFinishedPersistedJobs(): number;
  removeJob(id: string): void;
  cleanupCompletedJobs(maxAgeSeconds: number): void;
  markFailure(id: string, error: string): void;
  markCancelled(id: string, message: string | null): void;
}

/** `backup_common::DataGovernanceOperationGuard` 的公开租约（L23 云同步写命令使用）。 */
export interface BackupOperationGuard {
  /** 运行账本快照；`operation_id` 用于进度事件的 operationId。 */
  readonly snapshot: DataGovernanceOperationSnapshot;
  operationId(): string;
  /** 显式释放同进程 semaphore 与跨进程锁（Rust RAII Drop 的等价契约）。 */
  release(): void;
}

/**
 * 共享许可的结构化失败面（C2 P03）。
 *
 * 消费方不应匹配错误文案：
 * - `reason: 'busy'` + `code: 'E_DATA_GOVERNANCE_BUSY'` + `app_error.error_type: 'Validation'`
 *   对应 Rust `try_acquire` 被占用（含跨进程锁被占用）；
 * - `reason: 'lock_io'` + `code: 'E_DATA_GOVERNANCE_LOCK_IO'` + `app_error.error_type: 'FileSystem'`
 *   对应锁目录/账本 IO 失败。
 *
 * `value` 与 `app_error` 是同一个 Rust 同形 `AppError`，可由 L23 直接按原契约传输。
 */
export {
  OPERATION_GUARD_ERROR_CODES,
  OperationBusyError,
  OperationGuardError,
  OperationLockBusyError,
  OperationLockError,
  isOperationGuardError,
} from './src/operation-errors.ts';
export type {
  OperationGuardErrorCode,
  OperationGuardFailureReason,
} from './src/operation-errors.ts';

/** L20 `limiter-needs.ts` 的结构等价面；许可来自本 lane 唯一的全局操作协调器。 */
export interface SyncMutationPermit {
  release(): void;
}

export interface SyncGlobalLimiter {
  tryAcquire(): SyncMutationPermit | null;
}

/**
 * `commands_sync.rs:2583-2594` 的等待型入口。`timeout` 由消费者按 Rust
 * 原文案转成错误；`closed` 预留给协调器关闭，当前实现不会主动关闭。
 */
export interface SyncAwaitingGlobalLimiter extends SyncGlobalLimiter {
  acquire(timeoutMs: number): Promise<SyncMutationPermit | 'timeout' | 'closed'>;
}

/** `commands_sync.rs` 的 Sync 审计输入（L20 `sync-command-needs.ts`）。 */
export interface SyncAuditRequest {
  direction: 'Upload' | 'Download' | 'Bidirectional';
  recordsAffected: number;
  target: string;
  details: Record<string, unknown>;
  outcome:
    | { kind: 'started' }
    | { kind: 'complete'; durationMs: number }
    | { kind: 'failed'; error: string };
}

/**
 * L20 `SyncCommandPorts` 中由 L21 提供的部分。`application` 归 L20（唯一实现
 * `repository/apply-databases.ts`），`tombstones`/`workspaceCoordinator` 由 L20
 * 本地装配，均不在此对象内。
 */
export interface BackupSyncCommandPorts {
  limiter: SyncAwaitingGlobalLimiter;
  /** Rust `load_hydrated_cloud_config_ssot`：未配置返回 null，其它错误上抛。 */
  loadHydratedCloudConfig(): Promise<RuntimeCloudStorageConfig | null>;
  /** Rust `try_save_audit_log`：构造 AuditLog 并 best-effort 写审计库。 */
  saveSyncAudit(request: SyncAuditRequest): void;
}

/** backup@1: job execution context shared by manual and scheduled backups. */
export interface BackupService {
  readonly jobs: BackupJobManager;
  /** 与手动命令共用同一生产备份目录/创建入口，供治理工具调用，不经过IPC回调。 */
  getBackupList(): BackupInfoResponse[];
  runBackup(args: {
    backupType?: string | null; baseVersion?: string | null;
    includeAssets?: boolean | null; assetTypes?: string[] | null;
  }): BackupJobStartResponse;
  /** `hydrate_cloud_config` (cloud_credentials.rs:127): SSOT shape + secure-store secrets. */
  hydrateCloudConfig(config: RuntimeCloudStorageConfig): Promise<void>;
  /** `BackupManager::cleanup_old_backups`：保留最新 keepCount 个完整快照，返回被删除的备份 ID。 */
  cleanupOldBackups(keepCount: number): Promise<string[]>;
  /**
   * `DataGovernanceOperationGuard::try_acquire`：立即尝试取得全局数据治理租约；
   * 已被占用时抛 `OperationGuardError`（`reason: 'busy'`，Rust `Validation`）并保留
   * 原文案 `已有数据治理操作正在运行…`，不排队。
   *
   * kind 使用契约 serde snake_case（`backup`/`auto_backup`/…/`prune`），与 L23
   * 的 `DataGovernanceOperationKind` 完全一致。
   */
  tryAcquireOperation(kind: DataGovernanceOperationKind): BackupOperationGuard;
  /**
   * `commands_sync.rs:2583-2594`：在 `timeoutMs` 内等待同一全局租约；超时抛
   * `等待全局数据治理锁超时（N秒），可能有其他数据治理操作正在执行，请稍后再试。`。
   * 调用方必须在 `try/finally` 中显式 `release()`。
   */
  acquireOperation(kind: DataGovernanceOperationKind, timeoutMs: number): Promise<BackupOperationGuard>;
  /** L20 同步命令需要的共享许可 / 配置 / 审计端口。 */
  syncCommandPorts(): BackupSyncCommandPorts;
}

/** governance@1: asset catalog, active-slot asset inspection and shared operation guards. */
export interface GovernanceService {
  getAssetTypes(): AssetTypeInfo[];
  scanAssets(assetTypes?: string[] | null): Promise<AssetScanResponse>;
  /**
   * C1 工作区删除的正式入口（Rust `coordinator.rs:266-294` 使用 try_acquire）：
   * 立即取得 `DeletePropagation` 租约；忙锁抛业务错误，不排队。
   */
  acquireOperationGuard(kind: DataGovernanceOperationKind): BackupOperationGuard;
  /** 同 `acquireOperationGuard`，函数名明确立即失败语义。 */
  tryAcquireOperationGuard(kind: DataGovernanceOperationKind): BackupOperationGuard;
  /** 等待型别名，与 `backup.acquireOperation` 共用同一协调器。 */
  acquireOperation(kind: DataGovernanceOperationKind, timeoutMs: number): Promise<BackupOperationGuard>;
  /** L20 同步命令端口（按既有服务名可直接从本服务取用）。 */
  syncCommandPorts(): BackupSyncCommandPorts;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    backup: BackupService;
    governance: GovernanceService;
  }
}

/**
 * `chat_v2/tools/data_governance_executor.rs`：执行器由本插件 `index.ts` 注册进 `agentTools`，
 * 这里只发布类型。值不从本文件导出：`governance-tool.ts` 经 cloud-config 依赖桌面专有模块，
 * 而 `sync`、`sync-providers`（移动端核心）从本文件取 `isOperationGuardError`。
 */
export type {
  CloudConfigToolErrorKind, GovernanceSyncExecution, GovernanceToolConcurrency,
  GovernanceToolSensitivity,
} from './src/governance-tool.ts';

/** 服务版本描述（docs/plugins/ARCHITECTURE.md §3）。 */
export const backupService = { name: 'backup', version: '1.0.0' } as const;
export const governanceService = { name: 'governance', version: '1.0.0' } as const;
export const cloudConfigService = { name: 'cloudConfig', version: '1.0.0' } as const;

import type { CloudConfigService } from '../../platform/errors/cloud-config-api.ts';
export type { CloudConfigService } from '../../platform/errors/cloud-config-api.ts';
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** L21：云配置 SSOT 与事务化凭据发布（F4 命令注入点）。 */
    cloudConfig: CloudConfigService;
  }
}
