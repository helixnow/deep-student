import type { Context } from '@deepseek-ai/cordis';
import type { CloudStorageConfig } from '../../../contracts/ipc/generated/_shared.ts';
import type { FileInfo } from '../../../contracts/ipc/generated/L23-sync-providers.ts';

export type { Context, CloudStorageConfig, FileInfo };
export type { StorageProvider, WebDavConfig, S3Config, FtpConfig } from '../../../contracts/ipc/generated/_shared.ts';
export type { BackupVersion, DownloadResult, UploadResult, SyncStatus } from '../../../contracts/ipc/generated/L23-sync-providers.ts';

export type UploadProgressCallback = (done: number, total: number) => void;
export type DownloadProgressCallback = (done: number, total: number) => void;
export type StatusHook = (message: string) => void;
export interface ListOutcome { files: FileInfo[]; truncated: boolean }

/** `ListOutcome::complete`: a non-truncated listing. */
export function completeListOutcome(files: FileInfo[]): ListOutcome {
  return { files, truncated: false };
}
export interface PlatformStorageCapabilities { ftpSupported: boolean; s3Supported: boolean }

/** Backend-only transport authorization, corresponding to config.rs #[serde(skip)]. */
export const insecureTransportAuthorized: unique symbol = Symbol('insecureTransportAuthorized');
export type RuntimeCloudStorageConfig = CloudStorageConfig & { [insecureTransportAuthorized]?: boolean };

/** traits.rs:293–664. Paths are local filesystem paths; bytes never cross IPC as this interface. */
export interface CloudStorage {
  providerName(): string;
  instanceBindingHint(): string;
  checkConnection(): Promise<void>;
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  getBounded(key: string, maxBytes: number): Promise<Uint8Array | null>;
  /** Recursive, lastModified descending. */
  list(prefix: string): Promise<FileInfo[]>;
  listOutcome(prefix: string): Promise<ListOutcome>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<FileInfo | null>;
  exists(key: string): Promise<boolean>;
  putFile(key: string, localPath: string, progress?: UploadProgressCallback | null): Promise<string>;
  verifyRemoteObjectSize(key: string, expectedSize: number): Promise<void>;
  supportsConditionalPut(): boolean;
  putIfAbsent(key: string, data: Uint8Array): Promise<boolean>;
  supportsResumableDownload(): boolean;
  /** Returns the actual starting offset; interrupted calls preserve a correct prefix. */
  getFileResumable(key: string, dest: string, resumeFrom: number, progress?: DownloadProgressCallback | null): Promise<number>;
  supportsPrefixRead(): boolean;
  getPrefix(key: string, prefixLen: number): Promise<Uint8Array | null>;
  getFile(key: string, localPath: string, expectedChecksum?: string | null, progress?: DownloadProgressCallback | null): Promise<string>;
}

/** Versioned provider factory. Configuration is already hydrated by the caller (L21). */
export interface SyncProviderService {
  createStorage(config: RuntimeCloudStorageConfig): Promise<CloudStorage>;
  setStatusHook(hook: StatusHook): void;
  clearStatusHook(): void;
  setCancelToken(signal: AbortSignal): void;
  clearCancelToken(): void;
  isSyncCancelled(): boolean;
}

/** 服务版本描述（docs/plugins/ARCHITECTURE.md §3）。 */
export const syncProviderService = { name: 'syncProvider', version: '1.0.0' } as const;

// ------------------------------------------------------------------ 公开辅助（DRAFT 中 L20/L21 生产引用的符号）

export {
  CLOUD_RATE_LIMITED_CODE,
  SYNC_E2EE_DOWNGRADE_REJECTED_CODE,
  SYNC_E2EE_MARKER_CORRUPTED_CODE,
  SYNC_E2EE_MEMORY_PERSIST_FAILED_CODE,
  SYNC_E2EE_PASSWORD_REQUIRED_CODE,
  SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
  SYNC_E2EE_WRONG_PASSWORD_CODE,
  ensureDownloadNotDegraded,
  isCloudRateLimited,
  syncE2eeError,
} from './src/mod.ts';
export type { DowngradeDecision } from './src/mod.ts';
export {
  calculateFileHash,
  cleanupStaleParts,
  contentKeyedPartPath,
  destResumeLen,
  getFileWithOptionalResume,
  persistDownload,
} from './src/resume.ts';
export { deviceIdShortHash, normalizeDeviceId } from './src/device_id.ts';
export { CloudSyncManager } from './src/sync_manager.ts';
export type { CloudSyncManagerOptions } from './src/sync_manager.ts';
export type { CloudManifest } from './src/manifest.ts';
export { decodePasswordVerifierBytes, encodePasswordVerifier } from './src/marker.ts';
export { SerdeJsonError } from './src/serde_struct.ts';
export type { EncryptionMarker } from './src/marker.ts';
export { dsbkHeaderError, runRepoCheck, versionIdIsValid } from './src/repo_check.ts';
export {
  BACKUP_LEASE_HELD_ERROR_CODE,
  BACKUP_REPO_LEASE_FORMAT_VERSION,
  BACKUP_REPO_LEASE_PREFIX,
  DEFAULT_BACKUP_LEASE_TTL_MS,
  acquireBackupRepoLease,
  acquireBackupRepoLeaseWithTtl,
} from './src/backup_lease.ts';
export type { BackupRepoLease, BackupRepoLeaseGuard } from './src/backup_lease.ts';
export {
  DEFAULT_SYNC_LEASE_TTL_MS,
  SYNC_LEASE_HELD_BY_SELF_ERROR_CODE,
  SYNC_LEASE_HELD_ERROR_CODE,
  SYNC_TARGET_LEASE_FORMAT_VERSION,
  SYNC_TARGET_LEASE_PREFIX,
  acquireSyncTargetLease,
  acquireSyncTargetLeaseWithTtl,
} from './src/sync_lease.ts';
export type { SyncTargetLease, SyncTargetLeaseGuard } from './src/sync_lease.ts';
export {
  BACKUP_V2_FORMAT,
  DELTA_FORMAT_VERSION,
  MAX_IDENTIFIER_BYTES,
  MAX_LOGICAL_PATH_BYTES,
  MAX_OBJECT_KEY_BYTES,
  MAX_SNAPSHOT_FILES,
  SNAPSHOT_V2_FORMAT,
  decodeBackupV2RepoConfig,
  decodeSnapshotDescriptor,
  encodeBackupV2RepoConfig,
  encodeSnapshotDescriptor,
  validateBackupV2RepoConfig,
  validateSnapshotDescriptor,
  validateSnapshotFileRef,
} from './src/delta_format.ts';
export type {
  BackupV2RepoConfig,
  SnapshotDescriptorV2,
  SnapshotFileRefV2,
} from './src/delta_format.ts';
export {
  BACKUP_V2_CONFIG_KEY,
  BACKUP_V2_INDEX_FORMAT,
  BACKUP_V2_MANIFESTS_PREFIX,
  BACKUP_V2_OBJECTS_PREFIX,
  BACKUP_V2_SNAPSHOTS_PREFIX,
  DEFAULT_BACKUP_V2_MAX_VERSIONS,
  BackupV2DeviceIndex,
  deviceIndexKey,
  diffInventories,
  publishVerifiedStaging,
} from './src/delta_upload.ts';
export type {
  BackupV2IndexEntry,
  DeltaInventory,
  DeltaInventoryEntry,
  DeltaInventoryProvider,
  PublishParams,
  PublishResult,
} from './src/delta_upload.ts';
export {
  BACKUP_V2_GC_CANDIDATES_PREFIX,
  DEFAULT_GC_GRACE_MS,
  GC_CANDIDATE_FORMAT,
  GC_CANDIDATE_FORMAT_VERSION,
  GcCandidateV2,
  collectGcCandidates,
  sweepGcCandidates,
} from './src/delta_gc.ts';
export type { GcCollectResult, GcParams, GcSweepResult } from './src/delta_gc.ts';
export { restoreSnapshotToStaging } from './src/delta_restore.ts';
export type { RestoreParams, RestoreResult } from './src/delta_restore.ts';
export type {
  RepoCheckProblem,
  RepoCheckProblemKind,
  RepoCheckReport,
  RepoCheckStatus,
} from './src/repo_check.ts';
export {
  ANDROID_CAPABILITIES,
  CloudStorageConfigError,
  DESKTOP_CAPABILITIES,
  DESKTOP_ONLY_PROVIDERS,
  FTP_UNSUPPORTED_ON_ANDROID_CODE,
  FTP_UNSUPPORTED_ON_ANDROID_MESSAGE,
  S3_UNSUPPORTED_IN_BUILD_CODE,
  S3_UNSUPPORTED_IN_THIS_BUILD_MESSAGE,
  configErrorToAppError,
  configRoot,
  isLocalEndpoint,
  isLoopbackHost,
  providerDisplay,
  providerKey,
  s3EnabledForCapabilities,
  validateConfig,
} from './src/config.ts';
export * from './src/v5_keyring.ts';
export * from './src/v5_framed_pack.ts';
export * from './src/v5_index_and_checkpoint.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    syncProvider: SyncProviderService;
  }
}
