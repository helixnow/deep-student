/**
 * Shared backup helpers (dstu-storage/src/backup_common.rs): hashing, secret
 * stripping, ZIP bomb checks, symlink guards, disk space and directory copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from '../errors/api.ts';
import { ZipFileReader, type ZipEntry } from '../zip/index.ts';
import { copyDirectorySafe as copyDirectorySafeBytes, getAvailableDiskSpace } from './data-space-files.ts';
import { storageLog } from './logging.ts';
import { rustTrim } from '../util/portable.ts';

const LOG_TARGET = 'dstu_storage::backup_common';

export const MAX_UNCOMPRESSED_SIZE = 10 * 1024 * 1024 * 1024;
export const MAX_SINGLE_FILE_SIZE = 2 * 1024 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 100;
export const EXTREME_COMPRESSION_RATIO = 1000;
export const MAX_FILE_COUNT = 500_000;

export interface EntryResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** backup_common.rs:28. */
export function logAndSkipEntryErr<T>(result: EntryResult<T>): T | undefined {
  if (result.ok) return result.value;
  storageLog(LOG_TARGET, 'warn', `[BackupCommon] Directory entry read error (skipped): ${result.error ?? ''}`);
  return undefined;
}

/** backup_common.rs:310. */
export function calculateFileHash(file: string): string {
  const hash = createHash('sha256');
  let fd: number;
  try { fd = fs.openSync(file, 'r'); }
  catch (error) { throw AppError.file_system(`打开文件计算哈希失败 ${JSON.stringify(file)}: ${errorText(error)}`); }
  const buffer = Buffer.alloc(8192);
  try {
    for (;;) {
      let read: number;
      try { read = fs.readSync(fd, buffer, 0, buffer.length, null); }
      catch (error) { throw AppError.file_system(`读取文件失败 ${JSON.stringify(file)}: ${errorText(error)}`); }
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/** backup_common.rs:341. */
export function calculateBytesHash(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

const BACKUP_CRYPTO_SECRET_PATHS = ['crypto', '.secure', '.master_key', '.key_seed'];

/** backup_common.rs:356. */
export function isCryptoSecretBackupRelativePath(relativePath: string): boolean {
  const first = relativePath.split(/[/\\]/).filter((part) => part !== '' && part !== '.')[0];
  if (first === undefined) return false;
  // Rust `eq_ignore_ascii_case` only folds ASCII.
  const lower = first.replace(/[A-Z]/g, (char) => char.toLowerCase());
  return BACKUP_CRYPTO_SECRET_PATHS.some((name) => lower === name);
}

export type SecretRemover = (file: string, stats: fs.Stats) => void;

function removeSensitiveEntry(file: string, stats: fs.Stats): void {
  if (stats.isSymbolicLink()) {
    // Rust `remove_sensitive_entry`: Windows directory symlinks need remove_dir.
    if (process.platform === 'win32' && fs.statSync(file).isDirectory()) {
      fs.rmdirSync(file);
    } else {
      fs.unlinkSync(file);
    }
    return;
  }
  if (stats.isDirectory()) fs.rmSync(file, { recursive: true, force: true });
  else fs.unlinkSync(file);
}

/** backup_common.rs:387. */
export function stripCryptoSecretsFromBackupDir(backupDir: string): number {
  return stripCryptoSecretsFromBackupDirWith(backupDir, removeSensitiveEntry);
}

/** backup_common.rs:409. */
export function stripCryptoSecretsFromBackupDirWith(backupDir: string, remover: SecretRemover): number {
  let backupMetadata: fs.Stats;
  try { backupMetadata = fs.lstatSync(backupDir); }
  catch (error) { throw AppError.file_system(`检查备份目录失败 ${JSON.stringify(backupDir)}: ${errorText(error)}`); }
  if (backupMetadata.isSymbolicLink() || !backupMetadata.isDirectory()) {
    throw AppError.file_system(`备份目录必须是普通目录，不能是文件或符号链接: ${JSON.stringify(backupDir)}`);
  }

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(backupDir, { withFileTypes: true }); }
  catch (error) { throw AppError.file_system(`扫描备份敏感条目失败 ${JSON.stringify(backupDir)}: ${errorText(error)}`); }
  const sensitivePaths: string[] = [];
  for (const entry of entries) {
    if (isCryptoSecretBackupRelativePath(entry.name)) sensitivePaths.push(path.join(backupDir, entry.name));
  }
  sensitivePaths.sort();

  let removed = 0;
  for (const file of sensitivePaths) {
    let metadata: fs.Stats;
    try { metadata = fs.lstatSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw AppError.file_system(`检查备份敏感条目失败 ${JSON.stringify(file)}: ${errorText(error)}`);
    }
    try { remover(file, metadata); }
    catch (error) { throw AppError.file_system(`剥离备份敏感条目失败 ${JSON.stringify(file)}: ${errorText(error)}`); }
    storageLog(LOG_TARGET, 'info', `[BackupCommon] 已从备份产物剥离敏感条目: ${JSON.stringify(file)}`);
    removed += 1;
  }

  let verify: fs.Dirent[];
  try { verify = fs.readdirSync(backupDir, { withFileTypes: true }); }
  catch (error) { throw AppError.file_system(`验证备份敏感条目失败 ${JSON.stringify(backupDir)}: ${errorText(error)}`); }
  for (const entry of verify) {
    if (isCryptoSecretBackupRelativePath(entry.name)) {
      throw AppError.file_system(`备份敏感条目删除后仍然存在: ${JSON.stringify(path.join(backupDir, entry.name))}`);
    }
  }
  return removed;
}

export class ZipSecurityCheck {
  total_uncompressed_size: number;
  total_compressed_size: number;
  file_count: number;
  compression_ratio: number;
  largest_file_size: number;
  largest_file_name: string;

  constructor(fields: {
    total_uncompressed_size: number;
    total_compressed_size: number;
    file_count: number;
    compression_ratio: number;
    largest_file_size: number;
    largest_file_name: string;
  }) {
    this.total_uncompressed_size = fields.total_uncompressed_size;
    this.total_compressed_size = fields.total_compressed_size;
    this.file_count = fields.file_count;
    this.compression_ratio = fields.compression_ratio;
    this.largest_file_size = fields.largest_file_size;
    this.largest_file_name = fields.largest_file_name;
  }

  /** backup_common.rs:489. */
  validate(): void {
    if (this.total_uncompressed_size > MAX_UNCOMPRESSED_SIZE) {
      throw AppError.validation(
        `ZIP 文件解压后大小 (${(this.total_uncompressed_size / 1024 / 1024 / 1024).toFixed(2)} GB) 超过最大限制 (${(MAX_UNCOMPRESSED_SIZE / 1024 / 1024 / 1024).toFixed(2)} GB)，可能是 ZIP 炸弹`,
      );
    }
    if (this.largest_file_size > MAX_SINGLE_FILE_SIZE) {
      throw AppError.validation(
        `ZIP 中文件 '${this.largest_file_name}' 大小 (${(this.largest_file_size / 1024 / 1024 / 1024).toFixed(2)} GB) 超过单文件限制 (${(MAX_SINGLE_FILE_SIZE / 1024 / 1024 / 1024).toFixed(2)} GB)`,
      );
    }
    if (this.compression_ratio > EXTREME_COMPRESSION_RATIO) {
      throw AppError.validation(
        `ZIP 炸弹检测：压缩比 ${this.compression_ratio.toFixed(1)} 超过极限阈值 ${EXTREME_COMPRESSION_RATIO}，这极可能是恶意文件`,
      );
    }
    if (this.compression_ratio > MAX_COMPRESSION_RATIO) {
      storageLog(LOG_TARGET, 'warn', `[BackupCommon] ZIP 压缩比较高 (${this.compression_ratio.toFixed(1)} > ${MAX_COMPRESSION_RATIO})，可能是正常的重复数据，也可能是潜在威胁`);
    }
    if (this.file_count > MAX_FILE_COUNT) {
      throw AppError.validation(`ZIP 文件包含 ${this.file_count} 个文件，超过最大限制 ${MAX_FILE_COUNT}`);
    }
  }
}

/**
 * `backup_common.rs:542`：只读中央目录（`ZipArchive::new` + `by_index().size()`），不解压、不整包读入；
 * 支持 ZIP64 与超过 2GiB 的归档。
 */
export async function checkZipSecurity(zipPath: string): Promise<ZipSecurityCheck> {
  let compressedSize: number;
  try {
    const handle = await fs.promises.open(zipPath, 'r');
    try { compressedSize = (await handle.stat()).size; }
    catch { compressedSize = 0; }
    finally { await handle.close(); }
  } catch (error) { throw AppError.file_system(`打开 ZIP 文件失败: ${errorText(error)}`); }
  let entries: readonly ZipEntry[];
  try {
    const reader = await ZipFileReader.open(zipPath);
    entries = reader.entries;
    await reader.close();
  } catch (error) { throw AppError.file_system(`解析 ZIP 文件失败: ${errorText(error)}`); }

  let totalUncompressed = 0;
  let largestSize = 0;
  let largestName = '';
  for (const entry of entries) {
    const size = entry.size;
    totalUncompressed += size;
    if (size > largestSize) {
      largestSize = size;
      largestName = entry.name;
    }
  }
  return new ZipSecurityCheck({
    total_uncompressed_size: totalUncompressed,
    total_compressed_size: compressedSize,
    file_count: entries.length,
    compression_ratio: compressedSize > 0 ? totalUncompressed / compressedSize : 0,
    largest_file_size: largestSize,
    largest_file_name: largestName,
  });
}

/** backup_common.rs:596. */
export function isSymlink(file: string): boolean {
  try { return fs.lstatSync(file).isSymbolicLink(); }
  catch (error) {
    storageLog(LOG_TARGET, 'warn', `[BackupCommon] 无法读取路径元数据 ${JSON.stringify(file)}: ${errorText(error)}。安全优先：视为符号链接并跳过。`);
    return true;
  }
}

/** backup_common.rs:613. */
export function checkPathNotSymlink(file: string): void {
  if (isSymlink(file)) {
    throw AppError.validation(`安全检查失败: 路径 ${JSON.stringify(file)} 是符号链接，已跳过以防止符号链接攻击`);
  }
}

/** `backup_common.rs:632`（判定在 disk-space.ts，Node 系统调用在 data-space-files.ts）。 */
export { getAvailableDiskSpace };

/** backup_common.rs:910: 20% safety margin, GB error text, overflow fail-closed. */
export function checkDiskSpace(target: string, requiredBytes: number): void {
  const available = getAvailableDiskSpace(target);
  const safetyMargin = Math.floor((requiredBytes + 4) / 5);
  if (!Number.isSafeInteger(safetyMargin) || !Number.isSafeInteger(requiredBytes + safetyMargin)) {
    throw AppError.validation('磁盘空间预算溢出');
  }
  const requiredWithMargin = requiredBytes + safetyMargin;
  if (available < requiredWithMargin) {
    throw AppError.validation(
      `磁盘空间不足: 需要 ${(requiredWithMargin / 1024 / 1024 / 1024).toFixed(2)} GB，可用 ${(available / 1024 / 1024 / 1024).toFixed(2)} GB`,
    );
  }
}

/** backup_common.rs:947 (symlink checks/logging live in the shared copy helper). */
export function copyDirectorySafe(src: string, dst: string): number {
  return copyDirectorySafeBytes(src, dst);
}

/** `DataGovernanceOperationKind` serde shape (`rename_all = "snake_case"`). */
export type DataGovernanceOperationKind =
  | 'backup'
  | 'auto_backup'
  | 'verify'
  | 'zip_export'
  | 'zip_import'
  | 'restore'
  | 'sync'
  | 'delete_propagation'
  | 'prune';

export interface DataGovernanceOperationSnapshot {
  operation_id: string;
  kind: DataGovernanceOperationKind;
  started_at: string;
  process_id: number;
}

export interface ProcessOperationLock {
  snapshot: DataGovernanceOperationSnapshot;
  release(): void;
}

let currentOperation: DataGovernanceOperationSnapshot | null = null;

export function currentDataGovernanceOperation(): DataGovernanceOperationSnapshot | null {
  return currentOperation;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/**
 * backup_common.rs:232. Rust uses an advisory fs2 lock; the Host uses an
 * exclusive lock file with stale-owner detection (crash recovery).
 */
export function acquireProcessOperationLockAt(
  lockPath: string,
  snapshot: DataGovernanceOperationSnapshot,
): ProcessOperationLock {
  const parent = path.dirname(lockPath);
  try { fs.mkdirSync(parent, { recursive: true }); }
  catch (error) { throw AppError.file_system(`创建数据治理跨进程锁目录失败 ${JSON.stringify(parent)}: ${errorText(error)}`); }
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw AppError.file_system(`打开数据治理跨进程锁失败 ${JSON.stringify(lockPath)}: ${errorText(error)}`);
      }
      let holder = '';
      try { holder = rustTrim(fs.readFileSync(lockPath, 'utf8')); }
      catch (readError) {
        storageLog(LOG_TARGET, 'warn', `读取数据治理操作锁账本失败 ${JSON.stringify(lockPath)}: ${errorText(readError)}`);
      }
      let existing: DataGovernanceOperationSnapshot | null = null;
      try { existing = holder === '' ? null : JSON.parse(holder) as DataGovernanceOperationSnapshot; }
      catch (parseError) {
        storageLog(LOG_TARGET, 'warn', `解析数据治理操作锁账本失败 ${JSON.stringify(lockPath)}: ${errorText(parseError)}`);
      }
      if (existing && !processAlive(existing.process_id)) {
        try { fs.unlinkSync(lockPath); }
        catch (unlinkError) { storageLog(LOG_TARGET, 'warn', `清理失效数据治理操作锁失败 ${JSON.stringify(lockPath)}: ${errorText(unlinkError)}`); }
        continue;
      }
      const detail = holder === '' ? '' : `（holder=${holder}）`;
      throw AppError.validation(`另一个客户端进程正在执行数据治理操作${detail}: 锁文件已存在`);
    }
    try {
      fs.writeFileSync(fd, JSON.stringify(snapshot));
      fs.fsyncSync(fd);
    } catch (error) {
      fs.closeSync(fd);
      throw AppError.file_system(`写入数据治理操作锁账本失败 ${JSON.stringify(lockPath)}: ${errorText(error)}`);
    }
    currentOperation = snapshot;
    let released = false;
    return {
      snapshot,
      release() {
        if (released) return;
        released = true;
        try { fs.closeSync(fd); }
        catch (closeError) { storageLog(LOG_TARGET, 'warn', `关闭数据治理操作锁失败 ${JSON.stringify(lockPath)}: ${errorText(closeError)}`); }
        // The Host uses create-exclusive instead of an advisory lock, so the
        // file must be removed to let the next operation acquire it.
        try { fs.unlinkSync(lockPath); }
        catch (unlinkError) { storageLog(LOG_TARGET, 'warn', `释放数据治理操作锁失败 ${JSON.stringify(lockPath)}: ${errorText(unlinkError)}`); }
        if (currentOperation?.operation_id === snapshot.operation_id) currentOperation = null;
      },
    };
  }
  throw AppError.validation('另一个客户端进程正在执行数据治理操作');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
