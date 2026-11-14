/**
 * backup-v2 snapshot restore primitive (`delta_restore.rs`).
 *
 * Not wired: no command, UI, `sync_manager` or other production entry point calls
 * this module; production Cloud restore is still "whole ZIP download -> existing
 * import / A/B slot path". Its presence does not mean incremental restore exists.
 *
 * Input is a backup-v2 repository written by `delta_upload`; output is a complete,
 * verified backup staging (including `manifest.json`) inside the caller-provided
 * **empty** directory. This module never writes user data directories, switches
 * slots or registers importers.
 *
 * Restore order:
 * 1. hold the backup-v2 repository lease;
 * 2. GET this device's index and select the requested/latest version;
 * 3. GET the snapshot descriptor, verify size + ciphertext SHA-256, decrypt
 *    according to the caller's policy, decode and validate;
 * 4. download **all** objects into a temporary directory and verify three layers
 *    (transport SHA-256, AEAD decryption, plaintext SHA-256 + size);
 * 5. cross-check the temporary staging against the descriptor, then atomically
 *    rename it into `destStaging` and check again;
 * 6. optionally write a v1-compatible ZIP only after staging is fully verified.
 *
 * Any failure leaves `destStaging` empty (or clears it); no partial staging is
 * ever exposed. Cloud writes are limited to the lease contender.
 */

import { sha256Hasher, sha256Hex } from './hashing.ts';
import { dirname, join } from '../../../platform/util/path.ts';
import { isEncryptedBackup } from '../../../platform/secrets/dsbk-stream.ts';
import type { FileCipherSession } from '../../../platform/secrets/api.ts';
import type { CloudStorage } from '../api.ts';
import { acquireBackupRepoLease, type BackupRepoLeaseGuard } from './backup_lease.ts';
import { decodeSnapshotDescriptor, type SnapshotDescriptorV2, type SnapshotFileRefV2 } from './delta_format.ts';
import {
  BackupV2DeviceIndex,
  deviceIndexKey,
  type BackupV2IndexEntry,
  type DeltaInventory,
  type DeltaInventoryProvider,
} from './delta_upload.ts';
import { normalizeDeviceId } from './device_id.ts';
import { compareUtf8, utf8Encode } from './bytes.ts';
import { CloudStorageError } from './errors.ts';
import { fs } from './local-fs.ts';
import { defaultLogSink } from './logging.ts';
import { randomUuid } from './random.ts';

/** Restore parameters. */
export interface RestoreParams {
  deviceId: string;
  /** `undefined` means the device index's `latest`. */
  versionId?: string;
  /** Same policy as publish: `Some` requires DSBK, `None` requires plaintext. */
  cipher?: FileCipherSession | null;
  /** Optional v1-compatible ZIP target; must not exist. */
  writeCompatibleZip?: string;
}

/** One successful restore. */
export interface RestoreResult {
  versionId: string;
  snapshotKey: string;
  logicalSize: number;
  fileCount: number;
  zipPath: string | null;
}

function validation(message: string): CloudStorageError {
  return new CloudStorageError('Validation', message);
}

function fileSystem(message: string): CloudStorageError {
  return new CloudStorageError('FileSystem', message);
}

async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const hasher = sha256Hasher();
  let size = 0;
  for await (const chunk of fs.readChunks(path, 64 * 1024)) {
    hasher.update(chunk);
    size += chunk.byteLength;
  }
  return { sha256: hasher.digestHex(), size };
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `dest` must be an empty directory (created when missing). */
async function prepareDest(dest: string): Promise<void> {
  let metadata;
  try {
    metadata = await fs.lstat(dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(dest, { recursive: true }).catch(mkdirError => {
        throw fileSystem(`创建恢复目标目录失败: ${detail(mkdirError)}`);
      });
      return;
    }
    throw fileSystem(`检查恢复目标目录失败 ${dest}: ${detail(error)}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw validation(`恢复目标必须是普通目录（不能是文件或符号链接）: ${dest}`);
  }
  const entries = await fs.readdir(dest).catch(error => {
    throw fileSystem(`读取恢复目标目录失败: ${detail(error)}`);
  });
  if (entries.length > 0) {
    throw validation(`恢复目标目录必须为空（fail-closed，拒绝与既有内容合并）: ${dest}`);
  }
}

/** ZIP target must not exist and its parent must be a directory. */
async function precheckZipTarget(target: string): Promise<void> {
  try {
    await fs.lstat(target);
    throw validation(`兼容 ZIP 目标已存在，拒绝覆盖（fail-closed）: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const parent = dirname(target) || '.';
  const metadata = await fs.lstat(parent).catch(error => {
    throw fileSystem(`兼容 ZIP 目标父目录不可用 ${parent}: ${detail(error)}`);
  });
  if (!metadata.isDirectory()) {
    throw validation(`兼容 ZIP 目标父路径不是目录: ${parent}`);
  }
}

/** Clears every entry inside `dest` while keeping `dest` itself. */
async function clearDest(dest: string): Promise<void> {
  const entries = await fs.readdir(dest).catch(error => {
    throw fileSystem(`清理恢复目标目录失败: ${detail(error)}`);
  });
  for (const entry of entries) {
    await fs.rm(join(dest, entry), { recursive: true, force: true }).catch(error => {
      throw fileSystem(`清理恢复目标条目失败 ${join(dest, entry)}: ${detail(error)}`);
    });
  }
}

/** Last line of defence before writing: reject traversal even though the codec did. */
function rejectUnsafeLogicalPath(logicalPath: string): void {
  const bytes = utf8Encode(logicalPath);
  const unsafe = logicalPath === ''
    || logicalPath.startsWith('/')
    || logicalPath.includes('\\')
    || bytes.includes(0)
    || bytes[1] === 0x3a
    || logicalPath.split('/').some(segment => segment === '' || segment === '.' || segment === '..');
  if (unsafe) {
    throw validation(`descriptor 逻辑路径不安全，拒绝写入（fail-closed）: ${logicalPath}`);
  }
}

function objectError(versionId: string, file: SnapshotFileRefV2, message: string): CloudStorageError {
  return validation(
    `恢复版本 ${versionId} 失败（fail-closed）：对象 ${file.objectKey}（逻辑路径 ${file.logicalPath}）${message}`,
  );
}

async function decodeStoredDescriptor(
  bytes: Uint8Array,
  cipher: FileCipherSession | null | undefined,
  label: string,
): Promise<Uint8Array> {
  if (cipher !== null && cipher !== undefined) {
    if (!isEncryptedBackup(bytes)) {
      throw validation(`已配置加密会话，但 ${label} 不是 DSBK 密文；加密策略不一致，fail-closed`);
    }
    return cipher.decryptBytes(bytes).catch(error => {
      throw validation(`解密 ${label} 失败（密码错或数据损坏），fail-closed：${detail(error)}`);
    });
  }
  if (isEncryptedBackup(bytes)) {
    throw validation(`${label} 是 DSBK 密文，但本次未提供加密会话；不得静默改变加密策略，fail-closed`);
  }
  return bytes;
}

async function loadDescriptor(
  storage: CloudStorage,
  entry: BackupV2IndexEntry,
  deviceId: string,
  cipher: FileCipherSession | null | undefined,
): Promise<SnapshotDescriptorV2> {
  const bytes = await storage.get(entry.snapshotKey);
  if (bytes === null) {
    throw validation(`snapshot descriptor 缺失（${entry.snapshotKey}），fail-closed：拒绝恢复`);
  }
  if (bytes.byteLength !== entry.snapshotSize
    || sha256Hex(bytes).toLowerCase() !== entry.snapshotCipherSha256.toLowerCase()) {
    throw validation(`snapshot descriptor（${entry.snapshotKey}）与索引登记的大小/哈希不符，fail-closed：拒绝恢复`);
  }
  const plaintext = await decodeStoredDescriptor(bytes, cipher, 'snapshot descriptor');
  const descriptor = decodeSnapshotDescriptor(plaintext);
  if (descriptor.deviceId !== deviceId) {
    throw validation('descriptor 的 deviceId 与请求设备不符，fail-closed');
  }
  if (descriptor.versionId !== entry.id) {
    throw validation('descriptor 的 versionId 与索引条目不符，fail-closed');
  }
  return descriptor;
}

async function materializeObject(
  storage: CloudStorage,
  versionId: string,
  file: SnapshotFileRefV2,
  cipher: FileCipherSession | null | undefined,
  stagingRoot: string,
  scratchDir: string,
): Promise<void> {
  rejectUnsafeLogicalPath(file.logicalPath);

  const bytes = await storage.get(file.objectKey);
  if (bytes === null) throw objectError(versionId, file, '在云端缺失');
  if (sha256Hex(bytes).toLowerCase() !== file.objectCipherSha256.toLowerCase()) {
    throw objectError(versionId, file, '传输字节 SHA-256 与 descriptor 登记值不符（截断或被替换）');
  }

  const target = join(stagingRoot, file.logicalPath);
  await fs.mkdir(dirname(target), { recursive: true }).catch(error => {
    throw fileSystem(`创建 staging 子目录失败: ${detail(error)}`);
  });

  if (cipher !== null && cipher !== undefined) {
    if (!isEncryptedBackup(bytes)) {
      throw objectError(versionId, file, '不是 DSBK 密文，但本次配置了加密会话；加密策略不一致');
    }
    const cipherTemp = join(scratchDir, `.delta-restore-object-${randomUuid()}.dsbk`);
    try {
      await fs.writeFile(cipherTemp, bytes).catch(error => {
        throw fileSystem(`写入解密临时文件失败: ${detail(error)}`);
      });
      await cipher.decryptFile(cipherTemp, target).catch(error => {
        throw objectError(versionId, file, `解密失败（密码错或数据损坏）：${detail(error)}`);
      });
    } finally {
      await fs.rm(cipherTemp, { force: true });
    }
  } else {
    if (isEncryptedBackup(bytes)) {
      throw objectError(versionId, file, '是 DSBK 密文，但本次未提供加密会话；加密策略不一致');
    }
    if (bytes.byteLength !== file.size) {
      throw objectError(versionId, file,
        `明文长度 ${bytes.byteLength} 与 descriptor 登记的 ${file.size} 不符`);
    }
    await fs.writeFile(target, bytes).catch(error => {
      throw fileSystem(`写入 staging 文件失败: ${detail(error)}`);
    });
  }

  const disk = await sha256File(target);
  if (disk.size !== file.size || disk.sha256.toLowerCase() !== file.plaintextSha256.toLowerCase()) {
    throw objectError(versionId, file, '明文 SHA-256 / 大小与 descriptor 登记值不符');
  }
}

async function crossCheckStagingAgainstDescriptor(
  stagingRoot: string,
  descriptor: SnapshotDescriptorV2,
  inventoryProvider: DeltaInventoryProvider,
): Promise<void> {
  let inventory: DeltaInventory;
  try {
    inventory = await inventoryProvider.buildCrossChecked(stagingRoot);
  } catch (error) {
    throw validation(`已物化 staging 未通过清单交叉核对，fail-closed：${detail(error)}`);
  }
  if (inventory.entries.length !== descriptor.files.length
    || inventory.logicalSize !== descriptor.logicalSize) {
    throw validation('已物化 staging 的文件数 / 逻辑大小与 descriptor 不符，fail-closed');
  }
  const expected = [...descriptor.files].sort((left, right) => compareUtf8(left.logicalPath, right.logicalPath));
  for (let index = 0; index < inventory.entries.length; index += 1) {
    const entry = inventory.entries[index]!;
    const file = expected[index]!;
    if (entry.logicalPath !== file.logicalPath
      || entry.size !== file.size
      || entry.plaintextSha256.toLowerCase() !== file.plaintextSha256.toLowerCase()) {
      throw validation(`已物化文件与 descriptor 不符（fail-closed）: ${entry.logicalPath}`);
    }
  }
}

// ------------------------------------------------------------------ compatible ZIP

/**
 * Writes a v1-layout compatible ZIP (DEFLATE, staging-relative paths, including
 * `manifest.json`) to a temporary file, then links it into place without
 * overwriting. Any failure leaves no partial ZIP at the target. Entries are
 * streamed from disk through the shared `platform/zip` writer (zip 0.6.6 layout,
 * ZIP64 when needed), mirroring Rust's `std::io::copy` into `ZipWriter`.
 */
async function writeCompatibleZipFile(
  stagingRoot: string,
  target: string,
  inventoryProvider: DeltaInventoryProvider,
): Promise<string> {
  await precheckZipTarget(target);
  let inventory: DeltaInventory;
  try {
    inventory = await inventoryProvider.buildCrossChecked(stagingRoot);
  } catch (error) {
    throw validation(`staging 在打包前未通过验证，fail-closed：${detail(error)}`);
  }

  const parent = dirname(target) || '.';
  const temp = join(parent, `.delta-restore-zip-${randomUuid()}.tmp`);
  const writer = await fs.createZipWriter(temp).catch(error => {
    throw fileSystem(`创建兼容 ZIP 临时文件失败: ${detail(error)}`);
  });
  try {
    for (const entry of inventory.entries) {
      await writer.addFile(entry.logicalPath, join(stagingRoot, entry.logicalPath)).catch(error => {
        const opening = (error as NodeJS.ErrnoException).syscall === 'open';
        throw fileSystem(`${opening ? '读取 staging 文件失败' : '写入兼容 ZIP 内容失败'}: ${detail(error)}`);
      });
    }
    await writer.finish({ sync: true }).catch(error => {
      throw fileSystem(`完成兼容 ZIP 失败: ${detail(error)}`);
    });
  } catch (error) {
    await writer.abort();
    throw error;
  }

  try {
    // `link` is atomic and fails with EEXIST, matching persist_noclobber.
    await fs.link(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw fileSystem(`保存兼容 ZIP 失败: ${detail(error)}`);
  }
  await Promise.allSettled([fs.rm(temp, { force: true })]);
  return target;
}

async function releaseBestEffort(guard: BackupRepoLeaseGuard): Promise<void> {
  const [result] = await Promise.allSettled([guard.release()]);
  if (result.status === 'rejected') {
    defaultLogSink().warn(
      `[delta-restore] 释放备份仓库租约失败（将由 TTL 兜底）: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
    );
  }
}

/**
 * Restores one backup-v2 snapshot version into a complete local backup staging.
 *
 * The whole restore window holds the backup-v2 repository lease (read-only restore
 * also holds it so future GC cannot delete shared objects concurrently). Only the
 * selected descriptor's self-contained object table is materialized; no parent /
 * patch chain. All objects are verified in a temporary directory before the atomic
 * rename into `destStaging`. Cloud writes are limited to the lease.
 */
export async function restoreSnapshotToStaging(
  storage: CloudStorage,
  destStaging: string,
  params: RestoreParams,
  inventoryProvider?: DeltaInventoryProvider,
): Promise<RestoreResult> {
  if (params.deviceId.trim() === '') {
    throw validation('设备 ID 为空，拒绝恢复 backup-v2 快照（fail-closed）');
  }
  if (inventoryProvider === undefined) {
    throw new CloudStorageError('Configuration',
      'backup-v2 恢复需要 L21 的 delta_inventory 服务（build_inventory_cross_checked），'
        + '当前 host/plugins/backup/api.ts 尚未发布；拒绝恢复（fail-closed）');
  }
  const deviceId = normalizeDeviceId(params.deviceId);
  if (deviceId === '') {
    throw validation('设备 ID 规范化后为空，拒绝恢复（fail-closed）');
  }

  await prepareDest(destStaging);
  if (params.writeCompatibleZip !== undefined) {
    await precheckZipTarget(params.writeCompatibleZip);
  }

  const guard = await acquireBackupRepoLease(storage, deviceId);
  try {
    return await restoreLocked(storage, destStaging, params, deviceId, inventoryProvider);
  } finally {
    await releaseBestEffort(guard);
  }
}

async function restoreLocked(
  storage: CloudStorage,
  destStaging: string,
  params: RestoreParams,
  deviceId: string,
  inventoryProvider: DeltaInventoryProvider,
): Promise<RestoreResult> {
  // 1. This device's index: missing / corrupt / device mismatch fails closed.
  const indexKey = deviceIndexKey(deviceId);
  const indexBytes = await storage.get(indexKey);
  if (indexBytes === null) {
    throw validation(`设备 ${deviceId} 没有 backup-v2 版本索引（${indexKey}），无可恢复版本（fail-closed）`);
  }
  const index = BackupV2DeviceIndex.decode(indexBytes);
  if (index.deviceId !== deviceId) {
    throw validation('版本索引 deviceId 与请求设备不符，fail-closed');
  }

  // 2. Selected version entry (`undefined` = latest).
  const wanted = params.versionId ?? index.latest;
  if (wanted === undefined) {
    throw validation('版本索引没有 latest，无可恢复版本（fail-closed）');
  }
  const entry = index.versions.find(candidate => candidate.id === wanted);
  if (entry === undefined) {
    throw validation(`版本 ${wanted} 不在设备 ${deviceId} 的索引中，fail-closed`);
  }

  // 3. Descriptor: size + ciphertext hash -> decrypt -> decode/validate.
  const descriptor = await loadDescriptor(storage, entry, deviceId, params.cipher);

  // 4. Materialize all objects into a temporary directory first.
  const stagingParent = dirname(destStaging) || '.';
  const tempStaging = await fs.mkdtemp(join(stagingParent, '.delta-restore-staging-')).catch(error => {
    throw fileSystem(`创建恢复临时目录失败: ${detail(error)}`);
  });
  const scratch = await fs.mkdtemp(join(stagingParent, '.delta-restore-scratch-')).catch(async error => {
    await fs.rm(tempStaging, { recursive: true, force: true });
    throw fileSystem(`创建解密临时目录失败: ${detail(error)}`);
  });

  try {
    for (const file of descriptor.files) {
      await materializeObject(
        storage, descriptor.versionId, file, params.cipher, tempStaging, scratch,
      );
    }

    // 5. Cross-check before rename: disk hashes must match the descriptor.
    await crossCheckStagingAgainstDescriptor(tempStaging, descriptor, inventoryProvider);

    // 6. Atomic move into dest: remove the verified empty dest, then rename.
    await fs.rmdir(destStaging).catch(error => {
      throw fileSystem(`恢复目标目录不再为空或不可替换: ${detail(error)}`);
    });
    await fs.rename(tempStaging, destStaging).catch(async error => {
      await fs.mkdir(destStaging, { recursive: true }).catch(() => undefined);
      throw fileSystem(`已验证 staging 原子改名到恢复目标失败: ${detail(error)}`);
    });
  } finally {
    await fs.rm(tempStaging, { recursive: true, force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  }

  // 7. Final cross-check after rename (defensive against target filesystem issues).
  try {
    await crossCheckStagingAgainstDescriptor(destStaging, descriptor, inventoryProvider);
  } catch (error) {
    await clearDest(destStaging);
    throw error;
  }

  // 8. Compatible ZIP only after staging is fully verified; failure clears dest.
  let zipPath: string | null = null;
  if (params.writeCompatibleZip !== undefined) {
    try {
      zipPath = await writeCompatibleZipFile(destStaging, params.writeCompatibleZip, inventoryProvider);
    } catch (error) {
      await clearDest(destStaging);
      throw error;
    }
  }

  return {
    versionId: descriptor.versionId,
    snapshotKey: entry.snapshotKey,
    logicalSize: descriptor.logicalSize,
    fileCount: descriptor.files.length,
    zipPath,
  };
}
