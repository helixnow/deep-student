import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { FileError, type FilesService } from '../../../platform/files/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import {
  ZipEntrySizeMismatchError, ZipFormatError, fileZipSink, fileZipSource, nodeZipCodec,
  type ZipCompressionMethod, type ZipEntry,
} from '../../../platform/zip/index.ts';
import { verifyAssets } from './assets.ts';
import {
  ArchiveReader, ArchiveWriter, allowPath, writeStreamToFile, type ArchiveFiles, type ArchiveIo,
} from './zip-io.ts';
import {
  ENCRYPTED_SECRETS_ENTRY, SEALED_BACKUP_DECRYPT_FAILED_CODE,
  SEALED_BACKUP_PASSWORD_REQUIRED_CODE,
} from './zip-codes.ts';
import {
  loadManifest, markPartial, sha256FileFullAsync, validateForSlotRestore, validateLegacyCandidateForUpgrade,
  validateUntrusted, type BackupFile, type BackupManifest, type BackupKeyPolicy,
} from './manifest.ts';
import { verifyDirectoryWithAssets } from './backup-manager.ts';
import { ioMessage, isPathWithin } from './io.ts';
import {
  MAX_ARCHIVE_FILES, MAX_ARCHIVE_UNCOMPRESSED_BYTES, archiveEntries, copyWithActualSizeBudget,
  isPortableExcludedRelativePath, tooManyEntries, validateImportArchive, validateSecretsArchive,
} from './zip-policy.ts';

export { ENCRYPTED_SECRETS_ENTRY, SEALED_BACKUP_DECRYPT_FAILED_CODE, SEALED_BACKUP_PASSWORD_REQUIRED_CODE };
export {
  archivePolicyLimits, copyWithActualSizeBudget, isCryptoSecretRelativePath, isPortableExcludedRelativePath,
  isUnsafeArchivePath, portableExclusionSummary, validateSecretsArchive, type ArchiveEntryInfo,
} from './zip-policy.ts';

export const PORTABLE_ZIP_PASSWORD_NOT_NEEDED_MESSAGE =
  '该 ZIP 不是加密全保真备份，无需提供备份密码；请去掉密码后重试导入';

const KEY_SEED_RELATIVE_PATH = 'crypto/.secure/.key_seed';
const MIN_ENCRYPTION_PASSWORD_CHARS = 8;

/** Rust zip_export.rs:1005-1009 / :2059-2062：Io(Interrupted)，保留自定义 Display 而非 OS errno 文案。 */
function zipCancelled(action: '导出' | '导入'): NodeJS.ErrnoException {
  return Object.assign(new Error(`IO error: 用户取消${action}`), { code: 'EINTR' });
}

/** `ZipExportError::{Zip, Io}` 的 Display：归档结构错误为 `ZIP error: …`，读写错误为 `IO error: …`。 */
function zipError(error: unknown): Error {
  if (error instanceof ZipFormatError) {
    return new Error(error.kind === 'Io' ? `IO error: ${error.message}` : `ZIP error: ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface ZipExportOptions {
  compressionLevel: number;
  outputPath?: string | null;
  includeChecksums: boolean;
  encryptionPassword?: string | null;
  deleteSourceOnSuccess?: boolean;
}

export interface ZipExportResult {
  zipPath: string;
  totalSize: number;
  compressedSize: number;
  fileCount: number;
  durationMs: number;
  zipChecksum: string;
}

export type ZipExportPhase = 'seal' | 'scan' | 'compress' | 'finalize' | 'completed';

export interface ZipExportProgress {
  phase: ZipExportPhase;
  progress: number;
  processedFiles: number;
  totalFiles: number;
  currentFile: string | null;
  message: string;
}

export type ZipImportPhase = 'scan' | 'extract' | 'verify' | 'completed';

export interface ZipImportProgress {
  phase: ZipImportPhase;
  progress: number;
  processedFiles: number;
  totalFiles: number;
  currentFile: string | null;
  message: string;
}

export function compressionRatio(result: Pick<ZipExportResult, 'totalSize' | 'compressedSize'>): number {
  if (result.totalSize === 0) return 0;
  return 1 - result.compressedSize / result.totalSize;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 没装 `files` 服务的宿主直接用 fs 句柄（不做根限制），即改用 `ctx.files` 之前的行为。 */
const directFiles: ArchiveFiles = {
  async openFile(path, options = {}) {
    const handle = await open(path, options.mode === 'exclusive' ? 'wx' : 'r');
    try {
      const info = await handle.stat();
      if (info.isDirectory()) throw new FileError('IsADirectory', 'openFile', path, 'Is a directory (os error 21)', { osCode: 'EISDIR' });
      const source = fileZipSource(handle, info.size);
      const sink = fileZipSink(handle);
      return { size: info.size, read: source.read, write: sink.write, sync: () => handle.sync(), close: () => handle.close() };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  },
  rm: (path, options) => rm(path, options),
};

function archiveIo(ctx: Context): ArchiveIo {
  return { files: (ctx.get('files') as FilesService | undefined) ?? directFiles, codec: nodeZipCodec };
}

/**
 * `tempfile::NamedTempFile` 的 Drop / `let _ = fs::remove_file(...)`：临时文件清理失败
 * 不能掩盖主错误，只记录日志。ENOENT 视为已清理。
 */
async function removeTempFile(ctx: Context, path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    ctx.logger('backup').warn(`清理临时文件失败 ${path}: ${ioMessage(error)}`);
  }
}

function portableManifestObject(manifest: BackupManifest): BackupManifest {
  const copy = structuredClone(manifest);
  copy.files = copy.files.filter(file => !isPortableExcludedRelativePath(file.path));
  if (copy.coverage) {
    for (const domain of Object.values(copy.coverage.domains)) {
      if (domain.encrypted || domain.restore_target === 'databases/audit.db') {
        domain.status = 'excluded';
        domain.paths = [];
        domain.file_count = 0;
        domain.total_size = 0;
        domain.detail = 'excluded from unencrypted portable archive';
      }
    }
  }
  if (copy.assets) {
    copy.assets.files = copy.assets.files.filter(asset =>
      !isPortableExcludedRelativePath(asset.relative_path)
      && !isPortableExcludedRelativePath(asset.original_path));
    copy.assets.total_files = copy.assets.files.length;
    copy.assets.total_size = copy.assets.files.reduce((sum, asset) => sum + asset.size, 0);
  }
  copy.key_policy = 'excluded_portable';
  markPartial(copy);
  validateUntrusted(copy);
  return copy;
}

function portableManifestBytes(
  manifest: BackupManifest,
  keyPolicy: BackupKeyPolicy,
  exclusionDetail: string,
  sealedPayload: BackupFile | null,
): Buffer {
  const copy = portableManifestObject(manifest);
  copy.key_policy = keyPolicy;
  if (sealedPayload) copy.files.push(sealedPayload);
  if (copy.coverage) {
    for (const domain of Object.values(copy.coverage.domains)) {
      if (domain.encrypted || domain.restore_target === 'databases/audit.db') {
        domain.detail = exclusionDetail;
      }
    }
  }
  validateUntrusted(copy);
  return Buffer.from(JSON.stringify(copy, null, 2), 'utf8');
}

interface WalkEntry {
  relative: string;
  absolute: string;
  isDirectory: boolean;
  size: number;
}

async function walkExportEntries(root: string, options: { includePortableExcluded?: boolean } = {}): Promise<WalkEntry[]> {
  const entries: WalkEntry[] = [];
  const includePortableExcluded = options.includePortableExcluded === true;
  const visit = async (dir: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const absolute = join(dir, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (!includePortableExcluded && isPortableExcludedRelativePath(rel)) continue;
      if (rel.toLowerCase() === 'checksums.sha256') continue;
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`导出期间发现符号链接: ${absolute}`);
      if (metadata.isDirectory()) {
        entries.push({ relative: rel, absolute, isDirectory: true, size: 0 });
        await visit(absolute, rel);
      } else if (metadata.isFile()) {
        entries.push({ relative: rel, absolute, isDirectory: false, size: metadata.size });
      } else {
        throw new Error(`备份目录包含非常规文件: ${absolute}`);
      }
    }
  };
  await visit(root, '');
  return entries;
}

interface SealedPayload {
  payloadPath: string;
  entry: BackupFile;
  cleanup(): Promise<void>;
}

async function buildSealedSecretsPayload(
  ctx: Context,
  io: ArchiveIo,
  backupDir: string,
  password: string,
  isCancelled: () => boolean,
): Promise<SealedPayload> {
  if (rustTrim(password) === '' || Array.from(password).length < MIN_ENCRYPTION_PASSWORD_CHARS) {
    throw new Error(`[E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT] 备份密码至少需要 ${MIN_ENCRYPTION_PASSWORD_CHARS} 个字符（不能为空白）`);
  }
  if (isCancelled()) throw zipCancelled('导出');

  const original = loadManifest(join(backupDir, 'manifest.json'));
  if (original.snapshot_kind === 'legacy_candidate') {
    throw new Error('旧版备份缺少 coverage ledger，不支持加密全保真导出；请先在本机创建一次新版完整备份');
  }
  const sealedFiles: Array<{ absolute: string; relative: string; size: number }> = [];
  let sealedBytes = 0n;
  for (const entry of await walkExportEntries(backupDir, { includePortableExcluded: true })) {
    if (isCancelled()) throw zipCancelled('导出');
    if (entry.isDirectory || !isPortableExcludedRelativePath(entry.relative)) continue;
    sealedBytes += BigInt(entry.size);
    if (sealedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error('敏感数据总大小超出归档策略上限');
    sealedFiles.push({ absolute: entry.absolute, relative: entry.relative, size: entry.size });
    if (sealedFiles.length > MAX_ARCHIVE_FILES) throw new Error('敏感数据文件数量超出归档策略上限');
  }

  const innerManifest = structuredClone(original);
  const seed = sealedFiles.find(file => file.relative === KEY_SEED_RELATIVE_PATH);
  let seedPlaintext: Buffer | null = null;
  if (seed) {
    const plaintext = await ctx.secrets.resolveSeedFilePlaintext(seed.absolute);
    seedPlaintext = Buffer.from(plaintext, 'utf8');
    const record = innerManifest.files.find(file => file.path === KEY_SEED_RELATIVE_PATH);
    if (record) {
      const previousSize = record.size;
      record.size = seedPlaintext.length;
      record.sha256 = sha256Bytes(seedPlaintext);
      const coverage = innerManifest.coverage;
      if (coverage) {
        for (const evidence of Object.values(coverage.domains)) {
          if (evidence.paths.includes(KEY_SEED_RELATIVE_PATH)) {
            // Rust 使用 saturating_sub：旧清单大小可能大于实际明文（DPAPI 封装）。
            evidence.total_size = Math.max(0, evidence.total_size - previousSize) + seedPlaintext.length;
          }
        }
      }
    }
  }

  const tempDir = join(ctx.app.dataDir, 'temp_zip_export');
  await mkdir(tempDir, { recursive: true });
  const innerPath = join(tempDir, `zip-seal-inner-${randomUUID()}.zip`);
  const payloadPath = join(tempDir, `zip-seal-payload-${randomUUID()}.dsbk`);
  try {
    // Rust zip_export.rs:313-337：内层只有 start_file 条目（无目录条目），全部 Deflated。
    const inner = await ArchiveWriter.create(io, innerPath);
    try {
      await inner.addBuffer('manifest.json', JSON.stringify(innerManifest));
      for (const file of sealedFiles) {
        if (isCancelled()) throw zipCancelled('导出');
        if (file.relative === KEY_SEED_RELATIVE_PATH && seedPlaintext) {
          await inner.addBuffer(file.relative, seedPlaintext);
        } else {
          await inner.addFile(file.relative, file.absolute);
        }
      }
      await inner.finish();
    } catch (error) {
      await inner.abort();
      throw error;
    }
    // Rust zip_export.rs:339-348：最后一个可中断点；一旦进入加密则运行到完成。
    if (isCancelled()) throw zipCancelled('导出');
    await ctx.secrets.backup.encryptBackupFile(innerPath, payloadPath, password);
  } catch (error) {
    await removeTempFile(ctx, payloadPath);
    throw error;
  } finally {
    await removeTempFile(ctx, innerPath);
  }
  const payloadSize = (await stat(payloadPath)).size;
  return {
    payloadPath,
    entry: {
      path: ENCRYPTED_SECRETS_ENTRY,
      size: payloadSize,
      sha256: await sha256FileFullAsync(payloadPath),
    },
    cleanup: () => removeTempFile(ctx, payloadPath),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** `canonicalize`，但允许末尾若干级尚不存在：解析最深的已存在祖先，再拼回其余组件。 */
// RUST-FIX(RF-W08-zip-export-creates-missing-output-parent): Rust 对不存在的输出父目录直接报 IO 错，导出失败。
async function canonicalizeAllowingMissing(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      const parent = dirname(current);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** `zip_export::ensure_zip_output_outside_source`。 */
export async function ensureZipOutputOutsideSource(sourceDir: string, outputPath: string): Promise<void> {
  const canonicalSource = await realpath(sourceDir);
  const resolvedOutput = join(await canonicalizeAllowingMissing(dirname(resolve(outputPath))), basename(outputPath));
  if (isPathWithin(canonicalSource, resolvedOutput)) {
    throw new Error(`ZIP 输出路径不能位于备份源目录内: ${outputPath}`);
  }
  if (await pathExists(outputPath)) {
    if (isPathWithin(canonicalSource, await realpath(outputPath))) {
      throw new Error(`ZIP 输出路径不能指向备份源目录内: ${outputPath}`);
    }
  }
}

/** `zip_export::export_backup_to_zip_with_progress`。 */
export async function exportBackupToZip(
  ctx: Context,
  backupDir: string,
  options: ZipExportOptions,
  onProgress: (progress: ZipExportProgress) => void,
  isCancelled: () => boolean,
): Promise<ZipExportResult> {
  const start = performance.now();
  let metadata;
  try { metadata = await lstat(backupDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Backup directory not found: ${backupDir}`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('备份路径必须是普通目录，不能是文件或符号链接');
  }
  if (options.compressionLevel > 9) {
    throw new Error(`Invalid compression level: ${options.compressionLevel} (must be 0-9)`);
  }
  if (isCancelled()) throw zipCancelled('导出');

  const io = archiveIo(ctx);
  const revokes: Array<() => void> = [];
  let sealed: SealedPayload | null = null;
  try {
    revokes.push(await allowPath(io.files, backupDir));
    if (options.encryptionPassword) {
      onProgress({
        phase: 'seal', progress: 2, processedFiles: 0, totalFiles: 0, currentFile: null,
        message: '正在密封敏感数据为加密载荷...',
      });
      sealed = await buildSealedSecretsPayload(ctx, io, backupDir, options.encryptionPassword, isCancelled);
    }

    onProgress({
      phase: 'scan', progress: 5, processedFiles: 0, totalFiles: 0, currentFile: null,
      message: '正在生成便携清单并预检导出源...',
    });
    const sourceManifest = loadManifest(join(backupDir, 'manifest.json'));
    const manifestBytes = portableManifestBytes(
      sourceManifest,
      sealed ? 'included_encrypted' : 'excluded_portable',
      sealed ? 'sealed into password-encrypted portable payload' : 'excluded from unencrypted portable archive',
      sealed?.entry ?? null,
    );
    const entries = await walkExportEntries(backupDir);
    let totalEntries = entries.length + (sealed ? 1 : 0);
    let uncompressed = 0n;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      uncompressed += BigInt(entry.relative === 'manifest.json' ? manifestBytes.length : entry.size);
    }
    if (sealed) uncompressed += BigInt(sealed.entry.size);
    if (totalEntries > MAX_ARCHIVE_FILES) throw new Error(`ZIP 文件数量超限: ${totalEntries} > ${MAX_ARCHIVE_FILES}`);
    if (uncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error(`ZIP 解压后总大小超限: ${uncompressed} > ${MAX_ARCHIVE_UNCOMPRESSED_BYTES}`);
    }
    if (options.includeChecksums) totalEntries += 1;
    onProgress({
      phase: 'scan', progress: 10, processedFiles: 0, totalFiles: totalEntries, currentFile: null,
      message: `导出预检完成: ${totalEntries} 个条目, ${uncompressed} 字节`,
    });
    if (isCancelled()) throw zipCancelled('导出');

    const zipPath = options.outputPath ?? join(dirname(backupDir), `${basename(backupDir)}.zip`);
    await ensureZipOutputOutsideSource(backupDir, zipPath);
    await mkdir(dirname(zipPath), { recursive: true });
    revokes.push(await allowPath(io.files, dirname(zipPath)));

    // Rust：`FileOptions::default().compression_method(..)`，压缩级别不传入（flate2 默认级别）。
    const compression: ZipCompressionMethod = options.compressionLevel === 0 ? 'stored' : 'deflated';
    const tempPath = join(dirname(zipPath), `.${basename(zipPath)}.${randomUUID()}.tmp`);
    const writer = await ArchiveWriter.create(io, tempPath);
    const checksums: Array<[string, string]> = [];
    let totalSize = 0n;
    let fileCount = 0;
    let processed = 0;
    const progressFor = (): number => 10 + (processed / Math.max(1, totalEntries)) * 80;
    try {
      for (const entry of entries) {
        if (isCancelled()) throw zipCancelled('导出');
        if (entry.isDirectory) {
          await writer.addDirectory(entry.relative);
          processed += 1;
          continue;
        }
        const isManifest = entry.relative === 'manifest.json';
        const size = isManifest ? manifestBytes.length : entry.size;
        totalSize += BigInt(size);
        fileCount += 1;
        if (isManifest) {
          await writer.addBuffer(entry.relative, manifestBytes, { compression });
          if (options.includeChecksums) checksums.push([entry.relative, sha256Bytes(manifestBytes)]);
        } else {
          const current = await lstat(entry.absolute);
          if (current.isSymbolicLink() || !current.isFile()) {
            throw new Error(`导出文件在读取前变为非常规条目: ${entry.absolute}`);
          }
          // RUST-FIX(RF-W08-zip-export-single-read-checksums): Rust 先整读一遍算哈希再读一遍写 ZIP，I/O 翻倍且两次读取之间可不一致。
          const hash = options.includeChecksums ? createHash('sha256') : null;
          const written = await writer.addFile(entry.relative, entry.absolute, {
            compression,
            verifyOpened: (openedSize, isFile) => {
              if (!isFile || openedSize !== entry.size) throw new Error(`导出文件在打开期间发生变化: ${entry.absolute}`);
            },
            ...(hash === null ? {} : { onData: (chunk: Uint8Array) => { hash.update(chunk); } }),
          });
          if (written.size !== entry.size) {
            throw new Error(`导出文件读取大小变化: ${entry.absolute} expected=${entry.size}, actual=${written.size}`);
          }
          if (hash !== null) checksums.push([entry.relative, hash.digest('hex')]);
        }
        processed += 1;
        onProgress({
          phase: 'compress', progress: progressFor(), processedFiles: processed, totalFiles: totalEntries,
          currentFile: entry.relative, message: `正在压缩: ${entry.relative} (${processed}/${totalEntries})`,
        });
      }

      if (sealed) {
        if (isCancelled()) throw zipCancelled('导出');
        // 密文不可再压缩，使用存储模式。
        const written = await writer.addFile(ENCRYPTED_SECRETS_ENTRY, sealed.payloadPath, { compression: 'stored' });
        if (written.size !== sealed.entry.size) {
          throw new Error(`密封载荷写入大小不一致: expected=${sealed.entry.size}, actual=${written.size}`);
        }
        totalSize += BigInt(sealed.entry.size);
        fileCount += 1;
        if (options.includeChecksums) checksums.push([ENCRYPTED_SECRETS_ENTRY, sealed.entry.sha256]);
        processed += 1;
        onProgress({
          phase: 'compress', progress: progressFor(), processedFiles: processed, totalFiles: totalEntries,
          currentFile: ENCRYPTED_SECRETS_ENTRY, message: '已写入加密敏感数据载荷',
        });
      }

      if (options.includeChecksums && checksums.length > 0) {
        const content = checksums.map(([path, hash]) => `${hash}  ${path}`).join('\n');
        await writer.addBuffer('checksums.sha256', content, { compression });
        fileCount += 1;
        processed += 1;
      }
      if (isCancelled()) throw zipCancelled('导出');

      onProgress({
        phase: 'finalize', progress: 90, processedFiles: processed, totalFiles: totalEntries,
        currentFile: null, message: '正在自检并发布 ZIP 文件...',
      });
      await writer.finish({ sync: true });
      await validateArchivePath(io, tempPath);
      // 原子发布前的最后一个取消检查点：临时文件删除，已有目标 ZIP 保持原样。
      if (isCancelled()) throw zipCancelled('导出');
      await rename(tempPath, zipPath);
    } catch (error) {
      await writer.abort();
      await removeTempFile(ctx, tempPath);
      throw error;
    }

    onProgress({
      phase: 'finalize', progress: 95, processedFiles: processed, totalFiles: totalEntries,
      currentFile: null, message: '正在计算 ZIP 校验和...',
    });
    const compressedSize = (await stat(zipPath)).size;
    const zipChecksum = await sha256FileFullAsync(zipPath);
    const durationMs = Math.trunc(performance.now() - start);

    if (options.deleteSourceOnSuccess) {
      try { await rm(backupDir, { recursive: true, force: true }); }
      catch (error) { ctx.logger('backup').warn(`删除原始备份目录失败: ${ioMessage(error)}`); }
    }

    onProgress({
      phase: 'completed', progress: 100, processedFiles: processed, totalFiles: totalEntries,
      currentFile: null, message: `ZIP 导出完成，共 ${fileCount} 个文件`,
    });
    return { zipPath, totalSize: Number(totalSize), compressedSize, fileCount, durationMs, zipChecksum };
  } finally {
    await sealed?.cleanup();
    for (const revoke of revokes) revoke();
  }
}

async function openArchive(io: ArchiveIo, path: string): Promise<ArchiveReader> {
  try {
    return await ArchiveReader.open(io, path, { maxEntries: MAX_ARCHIVE_FILES, tooManyEntries });
  } catch (error) {
    if (error instanceof ZipFormatError) throw zipError(error);
    throw error;
  }
}

/** `zip_export::validate_archive_path`：导出发布前对产物做与导入相同的自检。 */
async function validateArchivePath(io: ArchiveIo, path: string): Promise<void> {
  const reader = await openArchive(io, path);
  try { validateImportArchive(archiveEntries(reader)); }
  finally { await reader.close(); }
}

/** `zip_export::zip_contains_encrypted_secrets`。 */
export async function zipContainsEncryptedSecrets(ctx: Context, zipPath: string): Promise<boolean> {
  const io = archiveIo(ctx);
  const revoke = await allowPath(io.files, zipPath);
  try {
    const reader = await openArchive(io, zipPath);
    try { return reader.has(ENCRYPTED_SECRETS_ENTRY); }
    finally { await reader.close(); }
  } finally {
    revoke();
  }
}

async function prepareImportDestination(targetDir: string, relative: string, isDirectory: boolean): Promise<string> {
  let destination = targetDir;
  const components = relative.split('/');
  for (let index = 0; index < components.length; index++) {
    const component = components[index]!;
    if (component === '' || component === '.' || component === '..') {
      throw new Error(`ZIP 包含不安全路径: ${relative}`);
    }
    destination = join(destination, component);
    const isLast = index + 1 === components.length;
    let metadata;
    try { metadata = await lstat(destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (!isLast || isDirectory)) {
        await mkdir(destination);
        const created = await lstat(destination);
        if (created.isSymbolicLink() || !created.isDirectory()) {
          throw new Error(`ZIP 解压目录创建后校验失败: ${destination}`);
        }
        continue;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && isLast) return destination;
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new Error(`ZIP 解压目标路径不允许包含符号链接: ${relative}`);
    if (!isLast && !metadata.isDirectory()) throw new Error(`ZIP 解压目标父路径不是目录: ${destination}`);
    if (isLast && isDirectory && !metadata.isDirectory()) throw new Error(`ZIP 目录条目与现有文件冲突: ${destination}`);
    if (isLast && !isDirectory && !metadata.isFile()) throw new Error(`ZIP 文件条目与现有目录冲突: ${destination}`);
  }
  return destination;
}

/** 跨条目的实际解压预算（`copy_with_actual_size_budget` 的 `total_written`）。 */
interface ExtractBudget {
  written: bigint;
}

/**
 * `extract_zip_file_atomically`：同目录临时文件 → 流式写入（预算 + 中央目录大小 + CRC）→
 * `sync_all` → 原子改名。
 */
// RUST-FIX(RF-W08-zip-entry-overflow-aborts-early): Rust 解压到 EOF（最多 20GiB 预算）才比较声明大小，伪造的小声明可先写满磁盘。
async function extractEntryAtomically(
  ctx: Context,
  io: ArchiveIo,
  reader: ArchiveReader,
  entry: ZipEntry,
  destination: string,
  budget: ExtractBudget,
): Promise<number> {
  const parent = dirname(destination);
  const temp = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
  const remaining = MAX_ARCHIVE_UNCOMPRESSED_BYTES > budget.written ? MAX_ARCHIVE_UNCOMPRESSED_BYTES - budget.written : 0n;
  const handle = await io.files.openFile(temp, { mode: 'exclusive' });
  let closed = false;
  try {
    const source = await reader.openEntry(entry, {
      onData: (_bytes, total) => {
        if (BigInt(total) > remaining) throw new Error(`ZIP 实际解压总量超限: > ${MAX_ARCHIVE_UNCOMPRESSED_BYTES} bytes`);
      },
    });
    const position = await writeStreamToFile(source, handle);
    if (position !== entry.size) {
      throw new Error(`ZIP 条目实际大小与中央目录不一致: ${destination} expected=${entry.size}, actual=${position}`);
    }
    budget.written = copyWithActualSizeBudget(BigInt(position), budget.written, MAX_ARCHIVE_UNCOMPRESSED_BYTES);
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(temp, destination);
    return position;
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await removeTempFile(ctx, temp);
    if (error instanceof ZipEntrySizeMismatchError) {
      throw new Error(`ZIP 条目实际大小与中央目录不一致: ${destination} expected=${error.expected}, actual=${error.actual}`);
    }
    throw zipError(error);
  }
}

/**
 * `portable_precheck::trial_decrypt_sealed_entry`：把密封条目复制到临时文件（`take(declared + 1)`
 * 后比较字节数），再试解密；不改动导入目标。
 */
async function trialDecryptSealedEntry(
  ctx: Context,
  io: ArchiveIo,
  reader: ArchiveReader,
  password: string,
): Promise<void> {
  const entry = reader.find(ENCRYPTED_SECRETS_ENTRY);
  if (!entry) return;
  if (entry.isDirectory) throw new Error(`密封载荷必须是普通文件条目: ${ENCRYPTED_SECRETS_ENTRY}`);
  const tempDir = join(ctx.app.dataDir, 'temp_zip_export');
  await mkdir(tempDir, { recursive: true });
  const input = join(tempDir, `zip-precheck-${randomUUID()}.dsbk`);
  const output = join(tempDir, `zip-precheck-${randomUUID()}.zip`);
  try {
    const handle = await io.files.openFile(input, { mode: 'exclusive' });
    try {
      await writeStreamToFile(await reader.openEntry(entry), handle);
    } catch (error) {
      if (error instanceof ZipEntrySizeMismatchError) {
        const actual = error.truncated ? Math.min(error.actual, error.expected + 1) : error.actual;
        throw new Error(`密封载荷实际大小与中央目录不一致: expected=${error.expected}, actual=${actual}`);
      }
      throw zipError(error);
    } finally {
      await handle.close();
    }
    try {
      await ctx.secrets.backup.decryptBackupFile(input, output, password);
    } catch (error) {
      throw new Error(`[${SEALED_BACKUP_DECRYPT_FAILED_CODE}] 解封加密备份失败（备份密码错误或载荷损坏）: ${ioMessage(error)}`);
    }
  } finally {
    await removeTempFile(ctx, input);
    await removeTempFile(ctx, output);
  }
}

async function precheckSealedPayloadPassword(
  ctx: Context,
  io: ArchiveIo,
  reader: ArchiveReader,
  password: string | null,
  resumable: boolean,
): Promise<void> {
  const hasSealed = reader.has(ENCRYPTED_SECRETS_ENTRY);
  if (password !== null) {
    if (!hasSealed) throw new Error(PORTABLE_ZIP_PASSWORD_NOT_NEEDED_MESSAGE);
    if (!resumable) await trialDecryptSealedEntry(ctx, io, reader, password);
    return;
  }
  if (!hasSealed) return;
  const message = resumable
    ? '这是加密全保真备份 ZIP：断点续传必须携带导出时设置的备份密码。请提供备份密码后重新恢复导入任务'
    : '这是加密全保真备份 ZIP：请提供导出时设置的备份密码后重试导入';
  throw new Error(`[${SEALED_BACKUP_PASSWORD_REQUIRED_CODE}] ${message}`);
}

async function unsealEncryptedSecrets(
  ctx: Context,
  io: ArchiveIo,
  targetDir: string,
  password: string | null,
): Promise<boolean> {
  const manifest = loadManifest(join(targetDir, 'manifest.json'));
  const declaredEncrypted = manifest.key_policy === 'included_encrypted';
  const payloadPath = join(targetDir, ENCRYPTED_SECRETS_ENTRY);
  let payloadPresent = false;
  try {
    const metadata = await lstat(payloadPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('密封载荷必须是普通文件');
    payloadPresent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (!declaredEncrypted && !payloadPresent) {
    if (password !== null) throw new Error(PORTABLE_ZIP_PASSWORD_NOT_NEEDED_MESSAGE);
    return false;
  }
  if (declaredEncrypted && !payloadPresent) {
    throw new Error(`清单声明为加密全保真备份，但缺少密封载荷 ${ENCRYPTED_SECRETS_ENTRY}`);
  }
  if (!declaredEncrypted && payloadPresent) {
    throw new Error(`ZIP 携带密封载荷 ${ENCRYPTED_SECRETS_ENTRY} 但清单未声明 key_policy=included_encrypted`);
  }
  if (password === null) {
    throw new Error(`[${SEALED_BACKUP_PASSWORD_REQUIRED_CODE}] 这是加密全保真备份 ZIP：请提供导出时设置的备份密码后重试导入`);
  }

  const tempDir = join(ctx.app.dataDir, 'temp_zip_export');
  await mkdir(tempDir, { recursive: true });
  const innerPath = join(tempDir, `zip-unseal-${randomUUID()}.zip`);
  try {
    try {
      await ctx.secrets.backup.decryptBackupFile(payloadPath, innerPath, password);
    } catch (error) {
      throw new Error(`[${SEALED_BACKUP_DECRYPT_FAILED_CODE}] 解封加密备份失败（备份密码错误或载荷损坏）: ${ioMessage(error)}`);
    }
    let inner: ArchiveReader;
    try { inner = await ArchiveReader.open(io, innerPath, { maxEntries: MAX_ARCHIVE_FILES, tooManyEntries }); }
    catch (error) { throw new Error(`密封载荷不是有效 ZIP: ${ioMessage(zipError(error))}`); }
    const written: string[] = [];
    try {
      const entries = validateSecretsArchive(archiveEntries(inner));
      const budget: ExtractBudget = { written: 0n };
      try {
        for (const entry of entries) {
          const destination = await prepareImportDestination(targetDir, entry.name, false);
          await extractEntryAtomically(ctx, io, inner, entry.entry, destination, budget);
          written.push(destination);
        }
      } catch (error) {
        let removed = 0;
        for (const path of written) {
          try {
            await unlink(path);
            removed += 1;
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code === 'ENOENT') {
              removed += 1;
            } else {
              ctx.logger('backup').warn(`清理半成品解封文件失败 ${path}: ${ioMessage(cleanupError)}`);
            }
          }
        }
        throw new Error(
          `解封敏感数据中断（已清理 ${removed}/${written.length} 个半成品明文文件）: ${ioMessage(error)}`,
        );
      }
    } finally {
      await inner.close();
    }
    await unlink(payloadPath);
    try { await unlink(join(targetDir, 'checksums.sha256')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let unsealed: BackupManifest;
    try { unsealed = loadManifest(join(targetDir, 'manifest.json')); }
    catch (error) {
      throw new Error(`解封后的原始清单无法解析: ${ioMessage(error)}`);
    }
    if (unsealed.key_policy === 'included_encrypted') {
      throw new Error('密封载荷未还原原始清单（key_policy 仍为 included_encrypted）');
    }
    return true;
  } finally {
    await removeTempFile(ctx, innerPath);
  }
}

async function walkActualFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string, prefix: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const absolute = join(dir, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`ZIP 解压结果包含非常规文件: ${absolute}`);
      if (metadata.isDirectory()) await visit(absolute, rel);
      else if (metadata.isFile()) files.push(rel);
      else throw new Error(`ZIP 解压结果包含非常规文件: ${absolute}`);
    }
  };
  await visit(root, '');
  return files;
}

async function validateImportedBackupDir(
  ctx: Context,
  targetDir: string,
  unsealed: boolean,
): Promise<void> {
  const manifest = loadManifest(join(targetDir, 'manifest.json'));
  const legacyPortable = manifest.snapshot_kind === 'legacy_candidate' && manifest.key_policy === 'legacy_unknown';
  if (legacyPortable) {
    try { validateLegacyCandidateForUpgrade(manifest); }
    catch (error) { throw new Error(`旧版 ZIP 未通过升级前严格验证: ${ioMessage(error)}`); }
  }
  const unsealedFullFidelity = unsealed
    && (manifest.key_policy === 'included_local' || manifest.key_policy === 'not_present');
  if (manifest.key_policy !== 'excluded_portable' && !legacyPortable && !unsealedFullFidelity) {
    throw new Error(unsealed
      ? `解封后的清单密钥策略无效: ${manifest.key_policy}（密封载荷必须还原 included_local / not_present 清单）`
      : '未加密 ZIP 必须声明 key_policy=excluded_portable');
  }
  if (manifest.snapshot_kind === 'full') validateForSlotRestore(manifest);

  const verification = await verifyDirectoryWithAssets(ctx, targetDir, manifest);
  if (!verification.isValid) {
    throw new Error([...verification.databaseErrors,
      ...verification.assetErrors.map(error => `${error.path}: ${error.message}`)].join('; '));
  }
  if (manifest.assets) {
    const errors = await verifyAssets(targetDir, manifest.assets.files);
    if (errors.length > 0) {
      throw new Error(`ZIP 资产校验失败: ${errors.map(error => `${error.path}: ${error.message}`).join('; ')}`);
    }
  }

  const allowed = new Set<string>(['manifest.json', 'checksums.sha256']);
  for (const file of manifest.files) allowed.add(file.path);
  for (const asset of manifest.assets?.files ?? []) if (!asset.is_directory) allowed.add(asset.relative_path);
  const actual = new Set<string>();
  for (const relative of await walkActualFiles(targetDir)) {
    if (!allowed.has(relative)) throw new Error(`ZIP 包含清单未声明的文件: ${relative}`);
    if (relative !== 'checksums.sha256') actual.add(relative);
  }

  const checksumsPath = join(targetDir, 'checksums.sha256');
  if (!await pathExists(checksumsPath)) return;
  const metadata = await lstat(checksumsPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('校验和条目必须是普通文件');
  const lines = (await readFile(checksumsPath, 'utf8')).split('\n');
  const declared = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line === '') continue;
    const separator = line.indexOf('  ');
    if (separator < 0) throw new Error(`校验和文件格式无效: line ${index + 1}`);
    const expected = line.slice(0, separator);
    const path = line.slice(separator + 2);
    if (!/^[0-9a-fA-F]{64}$/.test(expected)) throw new Error(`校验和格式无效: line ${index + 1}`);
    if (!actual.has(path) || declared.has(path)) throw new Error(`校验和路径缺失或重复: ${path}`);
    declared.add(path);
    const actualHash = await sha256FileFullAsync(join(targetDir, path));
    if (actualHash.toLowerCase() !== expected.toLowerCase()) throw new Error(`ZIP 校验和不匹配: ${path}`);
  }
  if (declared.size !== actual.size) throw new Error('校验和文件未覆盖 ZIP 中的全部文件');
}

interface ImportOptions {
  password: string | null;
  skipExisting: boolean;
  onProgress: (progress: ZipImportProgress) => void;
  isCancelled: () => boolean;
}

/** `zip_export::import_backup_from_zip_with_progress` / `_resumable`。 */
export async function importBackupFromZip(
  ctx: Context,
  zipPath: string,
  targetDir: string,
  options: ImportOptions,
): Promise<number> {
  const { onProgress, isCancelled } = options;
  onProgress({
    phase: 'scan', progress: 0, processedFiles: 0, totalFiles: 0, currentFile: null,
    message: '正在验证 ZIP 文件...',
  });
  if (isCancelled()) throw zipCancelled('导入');

  const io = archiveIo(ctx);
  const revokes: Array<() => void> = [];
  let reader: ArchiveReader;
  try {
    revokes.push(await allowPath(io.files, zipPath));
    revokes.push(await allowPath(io.files, targetDir));
    reader = await openArchive(io, zipPath);
  } catch (error) {
    for (const revoke of revokes) revoke();
    throw error;
  }
  try {
    const entries = archiveEntries(reader);
    validateImportArchive(entries);
    await precheckSealedPayloadPassword(ctx, io, reader, options.password, options.skipExisting);

    const totalFiles = entries.length;
    onProgress({
      phase: 'scan', progress: 5, processedFiles: 0, totalFiles, currentFile: null,
      message: `ZIP 文件验证完成，共 ${totalFiles} 个文件`,
    });
    if (isCancelled()) throw zipCancelled('导入');

    await mkdir(targetDir, { recursive: true });
    const targetMetadata = await lstat(targetDir);
    if (targetMetadata.isSymbolicLink() || !targetMetadata.isDirectory()) {
      throw new Error(`ZIP 解压目标必须是普通目录: ${targetDir}`);
    }

    let fileCount = 0;
    let skippedCount = 0;
    const budget: ExtractBudget = { written: 0n };
    const extractRange = 75;
    for (let index = 0; index < entries.length; index++) {
      if (isCancelled()) throw zipCancelled('导入');
      const entry = entries[index]!;
      const outpath = await prepareImportDestination(targetDir, entry.name, entry.isDirectory);
      const currentProgress = totalFiles > 0
        ? 5 + (index / totalFiles) * extractRange
        : 5 + extractRange;

      if (options.skipExisting && !entry.isDirectory) {
        const lower = entry.name.toLowerCase();
        const isDbFile = lower.endsWith('.db');
        const isManifest = basename(entry.name).toLowerCase() === 'manifest.json';
        if (!isDbFile && !isManifest) {
          try {
            const metadata = await lstat(outpath);
            if (metadata.isSymbolicLink() || !metadata.isFile()) {
              throw new Error(`断点续传目标不是普通文件: ${outpath}`);
            }
            if (metadata.size === entry.size) {
              skippedCount += 1;
              fileCount += 1;
              onProgress({
                phase: 'extract', progress: currentProgress, processedFiles: index, totalFiles,
                currentFile: entry.name, message: `跳过已存在: ${entry.name} (${index + 1}/${totalFiles})`,
              });
              continue;
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      }

      onProgress({
        phase: 'extract', progress: currentProgress, processedFiles: index, totalFiles,
        currentFile: entry.name, message: `正在解压: ${entry.name} (${index + 1}/${totalFiles})`,
      });
      if (entry.isDirectory) continue;

      await extractEntryAtomically(ctx, io, reader, entry.entry, outpath, budget);
      fileCount += 1;
    }
    if (skippedCount > 0) {
      ctx.logger('backup').info(`断点续传：跳过 ${skippedCount} 个已存在文件，新解压 ${fileCount - skippedCount} 个文件`);
    }

    onProgress({
      phase: 'verify', progress: 80, processedFiles: fileCount, totalFiles, currentFile: null,
      message: '正在验证解压的文件...',
    });
    if (isCancelled()) throw zipCancelled('导入');

    const unsealed = await unsealEncryptedSecrets(ctx, io, targetDir, options.password);
    if (unsealed) {
      onProgress({
        phase: 'verify', progress: 84, processedFiles: fileCount, totalFiles, currentFile: null,
        message: '已解封加密敏感数据，正在按原始清单验证...',
      });
    }
    await validateImportedBackupDir(ctx, targetDir, unsealed);

    onProgress({
      phase: 'verify', progress: 90, processedFiles: fileCount, totalFiles, currentFile: null,
      message: '文件验证完成',
    });
    onProgress({
      phase: 'completed', progress: 100, processedFiles: fileCount, totalFiles, currentFile: null,
      message: `ZIP 导入完成，共解压 ${fileCount} 个文件`,
    });
    return fileCount;
  } finally {
    await reader.close();
    for (const revoke of revokes) revoke();
  }
}
