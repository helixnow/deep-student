/**
 * 写覆盖备份与撤销：移植 `chat_v2/runtime_roots.rs` 的
 * `.write_backups` / `.workspace_changes` 撤销语义。
 *
 * 备份文件名、64 MiB 上限、backup_ref 结构、哈希绑定与原子替换顺序均与
 * Rust 保持一致；普通路径的比较复用 `runtime-paths.ts` 的 canonical 逻辑。
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { io, ioMessage, isWithin, normalizeRuntimeRelativePath } from './runtime-paths.ts';
import { openRuntimeReadFile, type RuntimeReadFile } from './runtime-roots.ts';
import type { NativeWindowsFiles } from '../../../platform/native/windows/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { writeAll } from './file-write.ts';

export const WRITE_BACKUP_DIR = '.write_backups';
export const MAX_WRITE_BACKUP_SOURCE_BYTES = 64 * 1024 * 1024;

let writeBackupSequence = 0;

/** 清理失败不应覆盖正在抛出的主错误。 */
function ignoreCleanupError(_error: unknown): void { /* 明确忽略清理错误 */ }

export interface WriteBackupSnapshot {
  backupRef: string;
  sha256: string;
  bytes: number;
}

/** 备份文件名里只保留安全字符（放行 `.` 以保留扩展名）。 */
export function safeBackupFileName(name: string): string {
  const cleaned = [...name].map(ch => /^[A-Za-z0-9._-]$/.test(ch) ? ch : '_').join('');
  const trimmed = cleaned.replace(/^\.+|\.+$/g, '');
  return trimmed === '' ? 'artifact' : trimmed;
}

function stageFile(directory: string, prefix: string, label: string): { fd: number; target: string } {
  for (let attempt = 0; attempt < 100; attempt++) {
    const target = path.join(directory, `${prefix}${randomBytes(8).toString('hex')}`);
    try {
      const fd = fs.openSync(target, 'wx');
      return { fd, target };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw new Error(`${label}: ${ioMessage(error)}`);
    }
  }
  throw new Error(`${label}: too many collisions`);
}

function persistNoClobber(stage: string, target: string, label: string): void {
  try {
    fs.linkSync(stage, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Error(`${label}: File exists (os error 17)`);
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV') {
      // 平台不支持硬链接时退化为独占创建 + 复制；仍保证不覆盖已有文件。
      let fd: number;
      try { fd = fs.openSync(target, 'wx'); } catch (openError) {
        if ((openError as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${label}: File exists (os error 17)`);
        throw new Error(`${label}: ${ioMessage(openError)}`);
      }
      try {
        const bytes = fs.readFileSync(stage);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.unlinkSync(stage);
      return;
    }
    throw new Error(`${label}: ${ioMessage(error)}`);
  }
  fs.unlinkSync(stage);
}

export function ensureWriteBackupDir(tempRootPath: string): string {
  const tempMeta = io('Failed to inspect temp root', () => fs.lstatSync(tempRootPath));
  if (tempMeta.isSymbolicLink() || !tempMeta.isDirectory()) throw new Error('Temp root must be a real directory');
  const tempCanon = io('Failed to resolve temp root', () => fs.realpathSync.native(tempRootPath));
  const backupDir = path.join(tempCanon, WRITE_BACKUP_DIR);
  try { fs.mkdirSync(backupDir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error(`Failed to create write backup dir: ${ioMessage(error)}`);
    }
  }
  const backupMeta = io('Failed to inspect write backup dir', () => fs.lstatSync(backupDir));
  if (backupMeta.isSymbolicLink() || !backupMeta.isDirectory()) throw new Error('Write backup area must be a real directory');
  const backupCanon = io('Failed to resolve write backup dir', () => fs.realpathSync.native(backupDir));
  if (!isWithin(tempCanon, backupCanon)) throw new Error('Write backup area escapes the temp root');
  return backupCanon;
}

function createWriteBackupFromReader(
  tempRootPath: string,
  originalFileName: string,
  read: (buffer: Buffer) => number,
): WriteBackupSnapshot {
  const backupDir = ensureWriteBackupDir(tempRootPath);
  const millis = Date.now();
  const sequence = writeBackupSequence++;
  const backupName = `${millis}_${String(sequence).padStart(4, '0')}_${safeBackupFileName(originalFileName)}`;
  const backupPath = path.join(backupDir, backupName);
  const staged = stageFile(backupDir, '.stage-', 'Failed to create staged backup');
  const hash = createHash('sha256');
  let total = 0;
  const buffer = Buffer.alloc(64 * 1024);
  try {
    for (;;) {
      const count = io('Failed to read backup source', () => read(buffer));
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      io('Failed to write staged backup', () => writeAll(staged.fd, chunk));
      hash.update(chunk);
      total += count;
      if (total > MAX_WRITE_BACKUP_SOURCE_BYTES) {
        throw new Error(`Write backup source exceeds the ${MAX_WRITE_BACKUP_SOURCE_BYTES / (1024 * 1024)} MiB limit`);
      }
    }
    io('Failed to sync staged backup', () => fs.fsyncSync(staged.fd));
    fs.closeSync(staged.fd);
    staged.fd = -1;
    persistNoClobber(staged.target, backupPath, 'Failed to persist backup');
    return { backupRef: `${WRITE_BACKUP_DIR}/${backupName}`, sha256: hash.digest('hex'), bytes: total };
  } finally {
    if (staged.fd >= 0) { try { fs.closeSync(staged.fd); } catch (error) { ignoreCleanupError(error); } }
    try { fs.unlinkSync(staged.target); } catch (error) { ignoreCleanupError(error); }
  }
}

/** 把即将被覆盖的旧产物内容写入 temp 根备份区，返回 backup_ref。 */
export function createWriteBackup(tempRootPath: string, originalFileName: string, bytes: Buffer): string {
  let offset = 0;
  const snapshot = createWriteBackupFromReader(tempRootPath, originalFileName, (buffer) => {
    if (offset >= bytes.length) return 0;
    const count = Math.min(buffer.length, bytes.length - offset);
    bytes.copy(buffer, 0, offset, offset + count);
    offset += count;
    return count;
  });
  return snapshot.backupRef;
}

export function createWriteBackupFromFile(tempRootPath: string, originalFileName: string, source: string,
  windowsFiles?: NativeWindowsFiles): WriteBackupSnapshot {
  const file = openRuntimeReadFile(source, 'existing artifact for backup', windowsFiles);
  try {
    const size = io('Failed to inspect opened artifact for backup', () => file.size());
    if (size > MAX_WRITE_BACKUP_SOURCE_BYTES) {
      throw new Error(`Write backup source exceeds the ${MAX_WRITE_BACKUP_SOURCE_BYTES / (1024 * 1024)} MiB limit`);
    }
    return createWriteBackupFromReader(tempRootPath, originalFileName, buffer => file.read(buffer));
  } finally {
    file.close();
  }
}

/** 校验 backup_ref 并解析为 temp 根备份区内的规范化绝对路径。 */
export function resolveWriteBackupSource(tempRootPath: string, backupRef: string): string {
  const relative = normalizeRuntimeRelativePath(backupRef);
  const parts = relative.split(path.sep).filter(part => part !== '');
  if (parts.length === 0 || parts[0] !== WRITE_BACKUP_DIR) {
    throw new Error('backup_ref must point into the write backup area');
  }
  if (parts.length < 2) throw new Error('backup_ref must point to a backup file');
  if (parts.length > 2) throw new Error('backup_ref must identify one direct backup file');
  const tempCanon = io('Failed to resolve temp root', () => fs.realpathSync.native(tempRootPath));
  const source = path.join(tempCanon, relative);
  const sourceMeta = io('Failed to inspect backup', () => fs.lstatSync(source));
  if (sourceMeta.isSymbolicLink()) throw new Error('Refusing to restore from a symlink backup');
  if (!sourceMeta.isFile()) throw new Error('backup_ref must be a file');
  const parentCanon = io('Failed to resolve backup parent', () => fs.realpathSync.native(path.dirname(source)));
  if (!isWithin(tempCanon, parentCanon)) throw new Error('backup_ref escapes the temp root');
  const sourceCanon = io('Backup does not exist', () => fs.realpathSync.native(source));
  if (!isWithin(tempCanon, sourceCanon)) throw new Error('backup_ref escapes the temp root');
  return sourceCanon;
}

export function sha256File(target: string, windowsFiles?: NativeWindowsFiles): [string, number] {
  const file = openRuntimeReadFile(target, 'artifact', windowsFiles);
  const hash = createHash('sha256');
  let total = 0;
  const buffer = Buffer.alloc(64 * 1024);
  try {
    for (;;) {
      const count = io('Failed to read artifact', () => file.read(buffer));
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      total += count;
    }
  } finally {
    file.close();
  }
  return [hash.digest('hex'), total];
}

export function normalizeExpectedSha256(expected: string): string {
  const normalized = rustTrim(expected).toLowerCase();
  if (normalized.length !== 64 || !/^[0-9a-f]+$/.test(normalized)) {
    throw new Error('expected_after_hash must be a 64-character SHA-256 hex digest');
  }
  return normalized;
}

export function artifactTargetWithParent(
  artifactRootPath: string,
  relative: string,
  createParent: boolean,
): { rootCanon: string; target: string } {
  if (relative === '') throw new Error('A relative artifact path is required');
  const rootCanon = io('Failed to resolve artifacts root', () => fs.realpathSync.native(artifactRootPath));
  const target = path.join(rootCanon, relative);
  const parent = path.dirname(target);
  if (createParent) io('Failed to create parent directory', () => fs.mkdirSync(parent, { recursive: true }));
  const parentCanon = io('Failed to resolve parent directory', () => fs.realpathSync.native(parent));
  if (!isWithin(rootCanon, parentCanon)) throw new Error('Path escapes the artifacts root');
  const fileName = path.basename(target);
  if (!fileName) throw new Error('Artifact target has no file name');
  return { rootCanon, target: path.join(parentCanon, fileName) };
}

export function verifyRegularArtifactHash(rootCanon: string, target: string, expectedAfterHash: string,
  windowsFiles?: NativeWindowsFiles): void {
  const expected = normalizeExpectedSha256(expectedAfterHash);
  const metadata = io('Artifact does not exist or cannot be inspected', () => fs.lstatSync(target));
  if (metadata.isSymbolicLink()) throw new Error('Artifact changed into a symlink; refusing stale undo');
  if (!metadata.isFile()) throw new Error('Artifact is no longer a regular file; refusing stale undo');
  const targetCanon = io('Artifact does not exist', () => fs.realpathSync.native(target));
  if (!isWithin(rootCanon, targetCanon)) throw new Error('Path escapes the artifacts root');
  const [actual] = sha256File(targetCanon, windowsFiles);
  if (actual !== expected) {
    throw new Error(`Artifact changed since this write (expected ${expected}, found ${actual}); refusing stale undo`);
  }
}

/** 原子复制到目标：同目录 stage + fsync + rename/link。返回写入字节数。 */
export function atomicCopyToTarget(reader: Buffer | RuntimeReadFile, target: string, overwrite: boolean): number {
  const parent = path.dirname(target);
  const staged = stageFile(parent, '.artifact-', 'Failed to create staged artifact');
  let total = 0;
  try {
    if (!Buffer.isBuffer(reader)) {
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const count = io('Failed to stage artifact content', () => reader.read(buffer));
        if (count === 0) break;
        io('Failed to stage artifact content', () => writeAll(staged.fd, buffer.subarray(0, count)));
        total += count;
      }
    } else {
      io('Failed to stage artifact content', () => writeAll(staged.fd, reader));
      total = reader.length;
    }
    io('Failed to sync staged artifact', () => fs.fsyncSync(staged.fd));
    fs.closeSync(staged.fd);
    staged.fd = -1;

    let existing: fs.Stats | null = null;
    try { existing = fs.lstatSync(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Failed to inspect artifact target: ${ioMessage(error)}`);
      }
    }
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error('Refusing to replace a symlink or non-file artifact');
      }
      if (!overwrite) throw new Error('Artifact already exists');
    }
    if (overwrite) {
      io('Failed to atomically replace artifact', () => fs.renameSync(staged.target, target));
    } else {
      persistNoClobber(staged.target, target, 'Failed to atomically create artifact');
    }
    if (process.platform !== 'win32') {
      try {
        const dirFd = fs.openSync(parent, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch (error) { ignoreCleanupError(error); }
    }
    return total;
  } finally {
    if (staged.fd >= 0) { try { fs.closeSync(staged.fd); } catch (error) { ignoreCleanupError(error); } }
    try { fs.unlinkSync(staged.target); } catch (error) { ignoreCleanupError(error); }
  }
}

/** 用备份恢复旧内容；存在 expected 时当前目标必须仍是当次输出。 */
export function restoreArtifactFromBackup(
  artifactRootPath: string,
  tempRootPath: string,
  relative: string,
  backupRef: string,
  expectedAfterHash: string | null | undefined,
  windowsFiles?: NativeWindowsFiles,
): number {
  const source = resolveWriteBackupSource(tempRootPath, backupRef);
  const { rootCanon, target } = artifactTargetWithParent(artifactRootPath, relative, expectedAfterHash == null);
  if (expectedAfterHash != null) {
    verifyRegularArtifactHash(rootCanon, target, expectedAfterHash, windowsFiles);
  } else {
    let metadata: fs.Stats | null = null;
    try { metadata = fs.lstatSync(target); } catch { metadata = null; }
    if (metadata && (metadata.isSymbolicLink() || metadata.isDirectory())) {
      throw new Error('Refusing to restore over a symlink or directory');
    }
  }
  const sourceFile = openRuntimeReadFile(source, 'backup for restore', windowsFiles);
  try {
    return atomicCopyToTarget(sourceFile, target, true);
  } finally {
    sourceFile.close();
  }
}

/** 删除一个产物文件；不 canonicalize symlink 之后再删，避免删到引用目标。 */
export function removeArtifactFile(
  artifactRootPath: string,
  relative: string,
  expectedAfterHash?: string | null,
  windowsFiles?: NativeWindowsFiles,
): void {
  const { rootCanon, target } = artifactTargetWithParent(artifactRootPath, relative, false);
  const metadata = io('Artifact does not exist', () => fs.lstatSync(target));
  if (expectedAfterHash != null) verifyRegularArtifactHash(rootCanon, target, expectedAfterHash, windowsFiles);
  if (metadata.isSymbolicLink()) {
    if (expectedAfterHash != null) throw new Error('Artifact changed into a symlink; refusing stale undo');
    io('Failed to delete artifact symlink', () => fs.unlinkSync(target));
    return;
  }
  if (!metadata.isFile()) throw new Error('Only artifact files can be deleted, not directories');
  const targetCanon = io('Artifact does not exist', () => fs.realpathSync.native(target));
  if (!isWithin(rootCanon, targetCanon)) throw new Error('Path escapes the artifacts root');
  io('Failed to delete artifact', () => fs.unlinkSync(target));
}

/** 不可逆删除一个哈希绑定的 session 文件：不创建任何检查点或备份。 */
export function removeSessionFileIrreversible(rootPath: string, relativePath: string, expectedSha256: string,
  windowsFiles?: NativeWindowsFiles): void {
  const relative = normalizeRuntimeRelativePath(relativePath);
  if (relative === '') throw new Error('A relative session file path is required');
  const expected = normalizeExpectedSha256(expectedSha256);
  removeArtifactFile(rootPath, relative, expected, windowsFiles);
}
