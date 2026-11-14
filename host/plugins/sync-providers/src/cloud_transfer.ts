/**
 * Command-level transfer orchestration extracted from `cloud_storage/mod.rs`
 * (`cloud_sync_upload` 411-540, `cloud_sync_download` 553-710).
 *
 * The wiring in `index.ts` only builds the manager, emits progress and delegates
 * here, so the encryption/temp-file/head-classification/decryption branches are
 * testable production code instead of inline command bodies.
 */

import { dirname, join } from '../../../platform/util/path.ts';
import type { BackupCrypto } from '../../../platform/secrets/api.ts';
import { CloudStorageError, ioError } from './errors.ts';
import { fs } from './local-fs.ts';
import { defaultLogSink, type LogSink } from './logging.ts';
import {
  SYNC_E2EE_PASSWORD_REQUIRED_CODE,
  SYNC_E2EE_WRONG_PASSWORD_CODE,
  ensureDownloadNotDegraded,
  syncE2eeError,
} from './mod.ts';
import { randomHex } from './random.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rust `config.encryption_password.filter(|s| !s.is_empty())` (mod.rs:429,663). */
export function nonEmptyPassword(value: string | null | undefined): string | null {
  return value == null || value === '' ? null : value;
}

export interface PreparedEncryptedUpload {
  path: string;
  /** Rust `TempPath` drop: removes the encrypted temp file on success and error. */
  dispose(): Promise<void>;
}

async function createTempFile(parent: string, prefix: string, suffix: string): Promise<string> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const path = join(parent, `${prefix}${randomHex(8)}${suffix}`);
    try {
      const handle = await fs.open(path, 'wx', 0o600);
      await handle.close();
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('unable to create a unique temporary file');
}

/**
 * cloud/mod.rs:453-460: create the encrypted temp file before encrypting.
 * Creation failure is `FileSystem`; encryption failure stays `Unknown` (Rust
 * `AppError::internal`). The temp file always lives next to the source ZIP.
 */
export async function prepareEncryptedUpload(
  backup: BackupCrypto,
  sourcePath: string,
  password: string,
): Promise<PreparedEncryptedUpload> {
  const parent = dirname(sourcePath) || '.';
  let tempPath: string;
  try {
    tempPath = await createTempFile(parent, '.cloud-upload-', '.dsbk');
  } catch (error) {
    throw new CloudStorageError('FileSystem', `创建加密临时文件失败: ${ioError(error)}`);
  }
  const dispose = async (): Promise<void> => {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  };
  try {
    await backup.encryptBackupFile(sourcePath, tempPath, password);
  } catch (error) {
    await dispose();
    throw new CloudStorageError('Unknown', `加密备份失败: ${errorMessage(error)}`);
  }
  return { path: tempPath, dispose };
}

/** Rust `File::open` (FileSystem) + `read_exact` (Validation, no file removal). */
async function readBackupHead(path: string): Promise<Uint8Array> {
  let handle;
  try {
    handle = await fs.open(path, 'r');
  } catch (error) {
    throw new CloudStorageError('FileSystem',
      `打开已下载备份进行格式识别失败 ${JSON.stringify(path)}: ${ioError(error)}`);
  }
  try {
    const buffer = new Uint8Array(4);
    let filled = 0;
    while (filled < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.byteLength - filled, null);
      if (bytesRead === 0) {
        // `read_exact` reports UnexpectedEof as "failed to fill whole buffer".
        throw new CloudStorageError('Validation',
          `已下载备份过短或无法读取 ${JSON.stringify(path)}: failed to fill whole buffer`);
      }
      filled += bytesRead;
    }
    return buffer;
  } catch (error) {
    if (error instanceof CloudStorageError) throw error;
    throw new CloudStorageError('Validation',
      `已下载备份过短或无法读取 ${JSON.stringify(path)}: ${ioError(error)}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface DownloadedObjectPolicy {
  backup: BackupCrypto;
  downloadedPath: string;
  cloudMarkerPresent: boolean;
  locallyRememberedEncrypted: boolean;
  plaintextHistoryOptIn: boolean;
  encryptionPassword: string | null;
  log?: LogSink;
}

/**
 * cloud/mod.rs:627-700: head classification, anti-downgrade gate, streaming
 * decryption to a sibling temp file and atomic persist.
 */
export async function finishDownloadedObject(policy: DownloadedObjectPolicy): Promise<void> {
  const log = policy.log ?? defaultLogSink();
  const downloadedPath = policy.downloadedPath;
  const head = await readBackupHead(downloadedPath);
  const isEncrypted = policy.backup.isEncryptedBackup(head);

  try {
    ensureDownloadNotDegraded({
      cloudMarkerPresent: policy.cloudMarkerPresent,
      locallyRememberedEncrypted: policy.locallyRememberedEncrypted,
      objectIsEncrypted: isEncrypted,
      plaintextHistoryOptIn: policy.plaintextHistoryOptIn,
    });
  } catch (error) {
    // Suspicious plaintext must not remain usable on disk; the rejection wins.
    await fs.rm(downloadedPath, { force: true }).catch(removeError => {
      log.warn(`[CloudSync] 防降级拒收后清理已下载对象失败 ${JSON.stringify(downloadedPath)}: ${ioError(removeError)}`);
    });
    throw error;
  }

  if (!isEncrypted) return;

  const password = policy.encryptionPassword;
  if (password === null) {
    throw new CloudStorageError('Configuration', syncE2eeError(SYNC_E2EE_PASSWORD_REQUIRED_CODE,
      '云端备份已加密，但未提供解密密码。请在云存储配置里填写相同的加密密码后重试。'));
  }

  log.info('[CloudSync] 检测到加密备份，开始流式解密...');
  const parent = dirname(downloadedPath) || '.';
  let tempPath: string;
  try {
    tempPath = await createTempFile(parent, '.cloud-decrypt-', '.tmp');
  } catch (error) {
    throw new CloudStorageError('FileSystem', `创建解密临时文件失败: ${ioError(error)}`);
  }
  try {
    await policy.backup.decryptBackupFile(downloadedPath, tempPath, password);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw new CloudStorageError('Validation', syncE2eeError(SYNC_E2EE_WRONG_PASSWORD_CODE,
      `解密备份失败（密码错或数据损坏）: ${errorMessage(error)}`));
  }
  try {
    await fs.rename(tempPath, downloadedPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw new CloudStorageError('FileSystem', `保存解密后 ZIP 失败: ${ioError(error)}`);
  }
}
