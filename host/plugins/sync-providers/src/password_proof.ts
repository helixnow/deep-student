/**
 * [R12-v1-trust] sync_manager.rs password proof before a marker is registered
 * or upgraded: trial-decrypt the newest backup (then the second newest) with the
 * local password, preferring a first-chunk prefix read over a whole download.
 */

import { join } from '../../../platform/util/path.ts';
import type { BackupCrypto } from '../../../platform/secrets/api.ts';
import type { CloudStorage, DownloadResult } from '../api.ts';
import { CloudStorageError, ioError } from './errors.ts';
import { filesService } from './files.ts';
import { fs } from './local-fs.ts';
import { defaultLogSink } from './logging.ts';
import type { CloudManifest, ManifestVersion } from './manifest.ts';
import { SYNC_E2EE_WRONG_PASSWORD_CODE, syncE2eeError } from './mod.ts';
import { randomHex } from './random.ts';

export interface PasswordProofPorts {
  readonly storage: CloudStorage;
  readonly backup: BackupCrypto;
  /** Remote object key of a version (`backups/<id>.zip`). */
  backupObjectKey(versionId: string): string;
  getManifest(): Promise<CloudManifest>;
  downloadVersion(versionId: string, localDir: string): Promise<DownloadResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainZipHead(head: Uint8Array): boolean {
  return head[0] === 0x50 && head[1] === 0x4b
    && ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6) || (head[2] === 7 && head[3] === 8));
}

/** `tempfile::tempdir()`: one `create_dir` under the existing temp root; failures carry tempfile's ` at path {:?}`. */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(fs.tmpDir(), `${prefix}-${randomHex(8)}`);
  try {
    await fs.mkdir(dir);
  } catch (error) {
    throw new CloudStorageError('FileSystem', `创建试解密临时目录失败: ${ioError(error)} at path ${JSON.stringify(dir)}`);
  }
  return dir;
}

function proveTrialFailedError(allowPlaintextZip: boolean, versionId: string, error: unknown): CloudStorageError {
  const prefix = allowPlaintextZip
    ? '云端尚无加密标记但已有旧版加密备份，登记校验子前'
    : '云端加密标记为旧版（无密码校验子），升级前';
  return new CloudStorageError('Configuration', syncE2eeError(SYNC_E2EE_WRONG_PASSWORD_CODE,
    `${prefix}，用本机密码试解最新备份 ${versionId} 未通过：${errorMessage(error)}。`
    + '本次未改动加密标记，也未写入任何备份对象。请核对加密密码后重试；'
    + '若确认密码无误，说明该备份由其他密码加密或已损坏，请人工检查该云端目录。'));
}

export async function provePasswordAgainstExistingBackups(
  ports: PasswordProofPorts,
  password: string,
  allowPlaintextZip: boolean,
): Promise<void> {
  let manifest: CloudManifest;
  try { manifest = await ports.getManifest(); }
  catch (error) {
    throw new CloudStorageError('Configuration',
      '升级云端加密标记前需确认本机密码能解开既有备份，但读取云端备份列表失败：'
      + `${errorMessage(error)}。本次未改动加密标记，请稍后重试。`);
  }
  const newest = (manifest.latest == null
    ? undefined
    : manifest.versions.find(version => version.id === manifest.latest)) ?? manifest.versions[0];
  if (newest === undefined) return;
  const secondNewest = manifest.versions.find(version => version.id !== newest.id);

  let primaryError: CloudStorageError;
  try {
    await provePasswordAgainstVersion(ports, password, allowPlaintextZip, newest);
    return;
  } catch (error) {
    primaryError = error as CloudStorageError;
  }
  if (secondNewest === undefined) throw primaryError;
  defaultLogSink().warn(
    `最新备份 ${newest.id} 试解失败（${primaryError.message}），回退次新版本 ${secondNewest.id} 再试一块`,
  );
  try {
    await provePasswordAgainstVersion(ports, password, allowPlaintextZip, secondNewest);
    defaultLogSink().warn(`次新版本 ${secondNewest.id} 试解通过（最新备份 ${newest.id} 可能已损坏或暂不可读），放行`);
  } catch (fallbackError) {
    defaultLogSink().warn(`次新版本 ${secondNewest.id} 回退试解同样失败: ${errorMessage(fallbackError)}`);
    throw primaryError;
  }
}

async function provePasswordAgainstVersion(
  ports: PasswordProofPorts,
  password: string,
  allowPlaintextZip: boolean,
  version: ManifestVersion,
): Promise<void> {
  if (ports.storage.supportsPrefixRead()) {
    const outcome = await tryProveWithFirstChunk(ports, password, allowPlaintextZip, version);
    if (outcome === 'Settled') return;
  }
  await provePasswordWithWholeFile(ports, password, allowPlaintextZip, version);
}

async function tryProveWithFirstChunk(
  ports: PasswordProofPorts,
  password: string,
  allowPlaintextZip: boolean,
  version: ManifestVersion,
): Promise<'Settled' | 'LegacyV1NeedsWholeFile'> {
  const { storage, backup } = ports;
  // `version.size` stays an exact u64 all the way into the F4 crypto API (number | bigint).
  const size = version.size;
  const remoteKey = ports.backupObjectKey(version.id);
  const readFailure = (error: unknown): CloudStorageError => new CloudStorageError('Configuration',
    `升级云端加密标记前需确认本机密码能解开既有备份，但读取备份 ${version.id} 的首块失败：`
    + `${errorMessage(error)}。本次未改动加密标记，请稍后重试。`);
  const missingObject = (): CloudStorageError => new CloudStorageError('Configuration',
    `升级云端加密标记前需确认本机密码能解开既有备份，但备份对象 ${version.id} 在云端不存在。`
    + '本次未改动加密标记，请稍后重试。');

  const speculative = backup.dsbkFirstChunkSpeculativePrefixLen(size);
  let prefix = await storage.getPrefix(remoteKey, speculative).catch(error => { throw readFailure(error); });
  if (prefix === null) throw missingObject();

  if (allowPlaintextZip) {
    const head = prefix.subarray(0, Math.min(prefix.byteLength, 4));
    if (!backup.isEncryptedBackup(head) && isPlainZipHead(head)) return 'Settled';
  }

  let plan;
  try { plan = backup.planFirstChunkTrial(prefix, size); }
  catch (error) { throw proveTrialFailedError(allowPlaintextZip, version.id, error); }
  if (plan.kind === 'LegacyV1WholeFile') return 'LegacyV1NeedsWholeFile';
  const prefixLen = plan.prefixLen;
  if (prefix.byteLength < prefixLen) {
    const widened = await storage.getPrefix(remoteKey, prefixLen).catch(error => { throw readFailure(error); });
    if (widened === null) throw missingObject();
    prefix = widened;
  }
  if (prefix.byteLength < prefixLen) {
    throw readFailure(new CloudStorageError('Network',
      `前缀读取不完整：需要 ${prefixLen} 字节，实得 ${prefix.byteLength} 字节（对象可能已被并发替换或截断）`));
  }

  try {
    await backup.trialDecryptFirstChunk(prefix, size, password);
  } catch (error) {
    throw proveTrialFailedError(allowPlaintextZip, version.id, error);
  }
  return 'Settled';
}

async function provePasswordWithWholeFile(
  ports: PasswordProofPorts,
  password: string,
  allowPlaintextZip: boolean,
  version: ManifestVersion,
): Promise<void> {
  const dir = await makeTempDir('trial-decrypt');
  try {
    const downloaded = await ports.downloadVersion(version.id, dir).catch(error => {
      throw new CloudStorageError('Configuration',
        `升级云端加密标记前需确认本机密码能解开既有备份，但下载最新备份 ${version.id} 失败：`
        + `${errorMessage(error)}。本次未改动加密标记，请稍后重试。`);
    });

    const encryptedPath = downloaded.localPath;
    if (allowPlaintextZip) {
      const file = await fs.open(encryptedPath, 'r').catch(error => {
        throw new CloudStorageError('Configuration',
          `登记云端加密标记前无法识别最新备份 ${version.id} 的格式：${ioError(error)}。本次未改动加密标记，请稍后重试。`);
      });
      let head: Uint8Array;
      try {
        const buffer = new Uint8Array(4);
        const { bytesRead } = await file.read(buffer, 0, 4, 0).catch(error => {
          throw new CloudStorageError('Configuration',
            `登记云端加密标记前无法读取最新备份 ${version.id} 的格式：${ioError(error)}。本次未改动加密标记，请稍后重试。`);
        });
        head = buffer.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
      if (!ports.backup.isEncryptedBackup(head) && isPlainZipHead(head)) return;
    }
    try {
      await trialDecryptWholeFile(ports.backup, encryptedPath, join(dir, '.trial-decrypt.tmp'), password);
    } catch (error) {
      throw proveTrialFailedError(allowPlaintextZip, version.id, error);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * sync_manager.rs:1462-1476 decrypts the whole file into `.trial-decrypt.tmp` only to prove the password.
 * Without `ctx.files` that path is kept.
 */
async function trialDecryptWholeFile(
  backup: BackupCrypto,
  encryptedPath: string,
  plaintextPath: string,
  password: string,
): Promise<void> {
  const files = filesService();
  if (files === null) {
    await backup.decryptBackupFile(encryptedPath, plaintextPath, password);
    return;
  }
  let input: ReadableStream<Uint8Array>;
  try { input = await files.openRead(encryptedPath); }
  catch (error) { throw new Error(`打开加密文件失败: ${errorMessage(error)}`); }
  // RUST-FIX(RF-W08-password-proof-discards-plaintext): Rust writes the plaintext to a temp file, so a full
  // disk fails the proof as a password mismatch; every v2 chunk is still authenticated before it is discarded.
  await backup.decryptBackupStream(input, new WritableStream<Uint8Array>(), password);
}
