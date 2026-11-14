/**
 * Command-level cloud sync workflows. `index.ts` only performs registration and
 * dependency wiring; upload/download/delete ordering lives here so it can be
 * exercised directly without a kernel (R4-P09).
 */

import type { BackupCrypto } from '../../../platform/secrets/api.ts';
import type { CloudSyncProgressEvent } from '../../../../contracts/ipc/generated/L23-sync-providers.ts';
import type { DownloadResult, UploadResult } from '../api.ts';
import { finishDownloadedObject, nonEmptyPassword, prepareEncryptedUpload, type PreparedEncryptedUpload } from './cloud_transfer.ts';
import { CloudStorageError, ioError } from './errors.ts';
import { fs } from './local-fs.ts';
import type { LogSink } from './logging.ts';
import type { CloudSyncManager } from './sync_manager.ts';

export interface CloudProgress {
  transferring(
    operationId: string,
    operation: 'upload' | 'download',
    stageLabel: string,
    done: number,
    total: number,
  ): void;
  done(operationId: string, operation: 'upload' | 'download', stageLabel: string, bytes: number): void;
}

function toPercent(done: number, total: number): number {
  return total > 0 ? Math.min((done / total) * 95, 95) : 0;
}

/** Event emission is best-effort, matching the previous inline wiring. */
export function createCloudProgress(
  emit: (event: CloudSyncProgressEvent) => void,
  log: LogSink,
): CloudProgress {
  const send = (event: CloudSyncProgressEvent): void => {
    try { emit(event); }
    catch (error) {
      log.warn(`[CloudSync] 进度事件发射失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    transferring(operationId, operation, stageLabel, done, total) {
      send({
        operationId, operation, stage: 'transferring', stageLabel: stageLabel,
        bytesDone: done, bytesTotal: total, percent: toPercent(done, total),
      });
    },
    done(operationId, operation, stageLabel, bytes) {
      send({
        operationId, operation, stage: 'done', stageLabel,
        bytesDone: bytes, bytesTotal: bytes, percent: 100,
      });
    },
  };
}

export interface UploadCommandOptions {
  manager: CloudSyncManager;
  backup: BackupCrypto;
  sourcePath: string;
  appVersion: string | null | undefined;
  note: string | null | undefined;
  recoveryKind: string | null | undefined;
  encryptionPassword: string | null | undefined;
  operationId: string;
  progress: CloudProgress;
  log: LogSink;
}

/**
 * Rust `cloud_sync_upload` (mod.rs:411-540): encryption policy → temp file →
 * progress → upload → remove temp → emit `done`.
 *
 * The encrypted temp file must be gone before success is announced; it is also
 * removed on every failure path.
 */
export async function runUploadCommand(options: UploadCommandOptions): Promise<UploadResult> {
  const { manager, backup, progress, log } = options;
  const password = nonEmptyPassword(options.encryptionPassword);

  await manager.enforceEncryptionPolicyBeforeUploadWithPassword(password);

  let uploadPath = options.sourcePath;
  let encryptedTemp: PreparedEncryptedUpload | null = null;
  if (password !== null) {
    log.info('[CloudSync] 端到端加密已启用，流式加密上传...');
    encryptedTemp = await prepareEncryptedUpload(backup, options.sourcePath, password);
    uploadPath = encryptedTemp.path;
  }

  let fileSize: number;
  try {
    try { fileSize = (await fs.stat(uploadPath)).size; }
    catch (error) {
      throw new CloudStorageError('FileSystem',
        `读取待上传备份大小失败 ${JSON.stringify(uploadPath)}: ${ioError(error)}`);
    }
    progress.transferring(options.operationId, 'upload', '正在上传文件...', 0, fileSize);

    const result = await manager.uploadWithProgress(
      uploadPath,
      options.appVersion ?? null,
      options.note ?? null,
      options.recoveryKind ?? null,
      (done, total) => progress.transferring(
        options.operationId, 'upload', '正在上传文件...', done, total,
      ),
    );

    // P07: cleanup first, then announce success.
    await disposeTemp(encryptedTemp);
    encryptedTemp = null;
    progress.done(options.operationId, 'upload', '上传完成', fileSize);
    return result;
  } finally {
    await disposeTemp(encryptedTemp);
  }
}

async function disposeTemp(temp: { dispose(): Promise<void> } | null): Promise<void> {
  if (temp !== null) await temp.dispose();
}

export interface DownloadCommandOptions {
  manager: CloudSyncManager;
  backup: BackupCrypto;
  versionId: string | null | undefined;
  localDir: string;
  allowPlaintextHistory: boolean | null | undefined;
  encryptionPassword: string | null | undefined;
  operationId: string;
  progress: CloudProgress;
  log: LogSink;
}

/** Rust `cloud_sync_download` (mod.rs:553-710). */
export async function runDownloadCommand(options: DownloadCommandOptions): Promise<DownloadResult> {
  const { manager, backup, progress, log } = options;
  const cloudMarkerPresent = (await manager.readEncryptionMarker()) !== null;
  const locallyRemembered = await manager.encryptedRootRememberedLocally();

  progress.transferring(options.operationId, 'download', '正在下载备份...', 0, 0);
  const result = await manager.downloadWithProgress(
    options.versionId ?? null,
    options.localDir,
    (done, total) => progress.transferring(
      options.operationId, 'download', '正在下载备份...', done, total,
    ),
  );

  await finishDownloadedObject({
    backup,
    downloadedPath: result.localPath,
    cloudMarkerPresent,
    locallyRememberedEncrypted: locallyRemembered,
    plaintextHistoryOptIn: options.allowPlaintextHistory ?? false,
    encryptionPassword: nonEmptyPassword(options.encryptionPassword),
    log,
  });

  progress.done(options.operationId, 'download', '下载完成', result.version.size);
  return result;
}

/** Rust `cloud_sync_delete_version` (mod.rs:714-727): guard holder deletes, then releases. */
export async function runDeleteVersionCommand(
  manager: CloudSyncManager,
  versionId: string,
  log: LogSink,
): Promise<null> {
  try {
    await manager.deleteVersion(versionId);
    return null;
  } catch (error) {
    log.warn(`[CloudSync] 删除云备份版本 ${JSON.stringify(versionId)} 失败: `
      + `${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
