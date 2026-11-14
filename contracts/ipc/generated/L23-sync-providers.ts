// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L23-sync-providers.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** dstu_sync::cloud_storage::sync_manager::BackupVersion */
export type BackupVersion = {
  id: string;
  timestamp: string;
  size: number;
  checksum: string;
  deviceId: string;
  appVersion?: string | null;
  note?: string | null;
  recoveryKind?: string | null;
};
/** dstu_sync::cloud_storage::CloudSyncProgressEvent */
export type CloudSyncProgressEvent = {
  operationId: string;
  operation: string;
  stage: string;
  stageLabel: string;
  bytesDone: number;
  bytesTotal: number;
  percent: number;
};
/** dstu_sync::cloud_storage::sync_manager::DownloadResult */
export type DownloadResult = {
  version: BackupVersion;
  localPath: string;
};
/** dstu_sync::cloud_storage::sync_manager::EncryptionMemoryPersistFailure */
export type EncryptionMemoryPersistFailure = {
  code: string;
  at: string;
};
/** dstu_sync::cloud_storage::traits::FileInfo */
export type FileInfo = {
  key: string;
  size: number;
  lastModified: string;
  etag?: string | null;
};
/** dstu_sync::cloud_storage::sync_manager::SyncStatus */
export type SyncStatus = {
  connected: boolean;
  cloudVersionCount: number;
  latestVersion?: BackupVersion | null;
  lastSyncTime?: string | null;
  error?: string | null;
  encryptionMemoryPersistFailure?: EncryptionMemoryPersistFailure | null;
};
/** dstu_sync::cloud_storage::sync_manager::UploadResult */
export type UploadResult = {
  version: BackupVersion;
  prunedVersions: string[];
};

export interface Commands {
  /** crates/dstu-sync/src/cloud_storage/mod.rs:297 `cloud_storage_check_connection` */
  cloud_storage_check_connection: {
    args: {
      config: Shared.CloudStorageConfig;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** crates/dstu-sync/src/cloud_storage/mod.rs:346 `cloud_storage_delete` */
  cloud_storage_delete: {
    args: {
      config: Shared.CloudStorageConfig;
      key: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** crates/dstu-sync/src/cloud_storage/mod.rs:370 `cloud_storage_exists` */
  cloud_storage_exists: {
    args: {
      config: Shared.CloudStorageConfig;
      key: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** crates/dstu-sync/src/cloud_storage/mod.rs:322 `cloud_storage_get` */
  cloud_storage_get: {
    args: {
      config: Shared.CloudStorageConfig;
      key: string;
    };
    result: number[] | null;
    error: Shared.AppError;
  };
  /** crates/dstu-sync/src/cloud_storage/mod.rs:737 `cloud_storage_is_s3_enabled` */
  cloud_storage_is_s3_enabled: {
    args: Record<string, never>;
    result: boolean;
    error: never;
  };
  /** crates/dstu-sync/src/cloud_storage/mod.rs:334 `cloud_storage_list` */
  cloud_storage_list: {
    args: {
      config: Shared.CloudStorageConfig;
      prefix: string;
    };
    result: FileInfo[];
    error: Shared.AppError;
  };
  /** crates/dstu-sync/src/cloud_storage/mod.rs:309 `cloud_storage_put` */
  cloud_storage_put: {
    args: {
      config: Shared.CloudStorageConfig;
      key: string;
      data: number[];
    };
    result: null;
    error: Shared.AppError;
  };
  /** crates/dstu-sync/src/cloud_storage/mod.rs:358 `cloud_storage_stat` */
  cloud_storage_stat: {
    args: {
      config: Shared.CloudStorageConfig;
      key: string;
    };
    result: FileInfo | null;
    error: Shared.AppError;
  };
  /** crates/dstu-sync/src/cloud_storage/mod.rs:714 `cloud_sync_delete_version` */
  cloud_sync_delete_version: {
    args: {
      config: Shared.CloudStorageConfig;
      versionId: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** crates/dstu-sync/src/cloud_storage/mod.rs:552 `cloud_sync_download` */
  cloud_sync_download: {
    args: {
      config: Shared.CloudStorageConfig;
      versionId?: string | null;
      localDir: string;
      allowPlaintextHistory?: boolean | null;
    };
    result: DownloadResult;
    error: Shared.AppError;
  };
  /** crates/dstu-sync/src/cloud_storage/mod.rs:731 `cloud_sync_get_device_id` */
  cloud_sync_get_device_id: {
    args: Record<string, never>;
    result: string;
    error: never;
  };
  /** crates/dstu-sync/src/cloud_storage/mod.rs:384 `cloud_sync_get_status` */
  cloud_sync_get_status: {
    args: {
      config: Shared.CloudStorageConfig;
    };
    result: SyncStatus;
    error: Shared.AppError;
  };
  /** crates/dstu-sync/src/cloud_storage/mod.rs:396 `cloud_sync_list_versions` */
  cloud_sync_list_versions: {
    args: {
      config: Shared.CloudStorageConfig;
    };
    result: BackupVersion[];
    error: Shared.AppError;
  };
  /** crates/dstu-sync/src/cloud_storage/mod.rs:410 `cloud_sync_upload` */
  cloud_sync_upload: {
    args: {
      config: Shared.CloudStorageConfig;
      zipPath: string;
      appVersion?: string | null;
      note?: string | null;
      recoveryKind?: string | null;
    };
    result: UploadResult;
    error: Shared.AppError;
  };
}

export interface Events {
  "cloud-sync-progress": CloudSyncProgressEvent;
}

export type CommandName = keyof Commands;
export type CloudStorageCheckConnectionCommandArgs = Commands['cloud_storage_check_connection']['args'];
export type CloudStorageCheckConnectionCommandResult = Commands['cloud_storage_check_connection']['result'];
export type CloudStorageDeleteCommandArgs = Commands['cloud_storage_delete']['args'];
export type CloudStorageDeleteCommandResult = Commands['cloud_storage_delete']['result'];
export type CloudStorageExistsCommandArgs = Commands['cloud_storage_exists']['args'];
export type CloudStorageExistsCommandResult = Commands['cloud_storage_exists']['result'];
export type CloudStorageGetCommandArgs = Commands['cloud_storage_get']['args'];
export type CloudStorageGetCommandResult = Commands['cloud_storage_get']['result'];
export type CloudStorageIsS3EnabledCommandArgs = Commands['cloud_storage_is_s3_enabled']['args'];
export type CloudStorageIsS3EnabledCommandResult = Commands['cloud_storage_is_s3_enabled']['result'];
export type CloudStorageListCommandArgs = Commands['cloud_storage_list']['args'];
export type CloudStorageListCommandResult = Commands['cloud_storage_list']['result'];
export type CloudStoragePutCommandArgs = Commands['cloud_storage_put']['args'];
export type CloudStoragePutCommandResult = Commands['cloud_storage_put']['result'];
export type CloudStorageStatCommandArgs = Commands['cloud_storage_stat']['args'];
export type CloudStorageStatCommandResult = Commands['cloud_storage_stat']['result'];
export type CloudSyncDeleteVersionCommandArgs = Commands['cloud_sync_delete_version']['args'];
export type CloudSyncDeleteVersionCommandResult = Commands['cloud_sync_delete_version']['result'];
export type CloudSyncDownloadCommandArgs = Commands['cloud_sync_download']['args'];
export type CloudSyncDownloadCommandResult = Commands['cloud_sync_download']['result'];
export type CloudSyncGetDeviceIdCommandArgs = Commands['cloud_sync_get_device_id']['args'];
export type CloudSyncGetDeviceIdCommandResult = Commands['cloud_sync_get_device_id']['result'];
export type CloudSyncGetStatusCommandArgs = Commands['cloud_sync_get_status']['args'];
export type CloudSyncGetStatusCommandResult = Commands['cloud_sync_get_status']['result'];
export type CloudSyncListVersionsCommandArgs = Commands['cloud_sync_list_versions']['args'];
export type CloudSyncListVersionsCommandResult = Commands['cloud_sync_list_versions']['result'];
export type CloudSyncUploadCommandArgs = Commands['cloud_sync_upload']['args'];
export type CloudSyncUploadCommandResult = Commands['cloud_sync_upload']['result'];
