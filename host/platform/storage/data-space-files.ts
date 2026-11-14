/** Durable filesystem operations from data_space.rs:887-994,1971-2094, and the Node side of `backup_common::get_available_disk_space`. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ioMessageFor } from '../paths/io-error.ts';
import { retryRenameSync } from '../paths/rename-retry.ts';
import { availableDiskSpace } from './disk-space.ts';
import { storageLog } from './logging.ts';
import { compactTimestampMicros, rfc3339Now } from './time.ts';

const LOG_TARGET = 'dstu_storage::data_space';

/** `std::fs::rename`，win32 上对瞬时占用退避重试；与 `paths/compat.ts` 的同名包装一致，放在这里是为了不把 compat 拉进存储模块的依赖闭包。 */
export function renameSyncWithRetry(from: string, to: string): void {
  retryRenameSync(process.platform, () => fs.renameSync(from, to));
}

export function isDirectory(file: string): boolean {
  try { return fs.statSync(file).isDirectory(); } catch { return false; }
}
export function isFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}
export function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function removePath(file: string): void {
  if (isDirectory(file)) fs.rmSync(file, { recursive: true }); else fs.unlinkSync(file);
}
export function removeFileIfExists(file: string): void {
  try { fs.unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export function atomicWriteBytes(file: string, bytes: string | Uint8Array): void {
  const dir = path.dirname(file); fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `.durable-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  renameSyncWithRetry(temporary, file); syncDirectory(dir);
}
/** 同 {@link atomicWriteBytes}，但 rename 前先对临时文件执行 `beforeRename`（权限收紧等），目标路径从不以未收紧的状态出现；失败时删掉临时文件。 */
export async function atomicWriteBytesBeforeRename(file: string, bytes: string | Uint8Array, beforeRename: (temporary: string) => Promise<void>): Promise<void> {
  const dir = path.dirname(file); fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `.durable-${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    await beforeRename(temporary);
    renameSyncWithRetry(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  syncDirectory(dir);
}
export function atomicWriteJson(file: string, value: unknown): void { atomicWriteBytes(file, JSON.stringify(value, null, 2)); }
export function readJson<T>(file: string, description: string): T {
  const bytes = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(bytes) as T; } catch (error) { throw new Error(`解析${description}失败: ${errorText(error)}`); }
}
/** Rust `io::Error` 的 Display：Node fs 错误为 `<strerror> (os error N)`，其余取 message。 */
export function errorText(error: unknown): string { return ioMessageFor(error, process.platform); }
/** `backup_common::get_available_disk_space`：`fs.statfsSync`，失败时 `df -k` / `wmic`（5s 超时，不弹控制台窗口）。 */
export function getAvailableDiskSpace(target: string): number {
  return availableDiskSpace(target, {
    platform: process.platform,
    env: process.env,
    exists: (file) => fs.existsSync(file),
    statfs: (file) => fs.statfsSync(file),
    run: (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 5000, windowsHide: true }),
  });
}
export function utcNow(): string { return rfc3339Now(); }
export function timestampCompact(): string { return compactTimestampMicros(); }

export function copyPathDurable(source: string, destination: string): void {
  const meta = fs.lstatSync(source);
  if (meta.isSymbolicLink()) throw new Error(`拒绝迁移符号链接备份条目: ${source}`);
  if (meta.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copyPathDurable(path.join(source, name), path.join(destination, name));
    syncDirectory(destination);
  } else if (meta.isFile()) {
    fs.copyFileSync(source, destination);
    const fd = fs.openSync(destination, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } else throw new Error(`不支持的备份条目类型: ${source}`);
}
export function pathsEqual(left: string, right: string): boolean {
  const a = fs.lstatSync(left), b = fs.lstatSync(right);
  if (a.isSymbolicLink() || b.isSymbolicLink()) return false;
  if (a.isFile() && b.isFile()) {
    if (a.size !== b.size) return false;
    const l = fs.openSync(left, 'r');
    try {
      const r = fs.openSync(right, 'r');
      try {
        const lb = Buffer.alloc(64 * 1024), rb = Buffer.alloc(64 * 1024);
        for (;;) {
          const ln = fs.readSync(l, lb), rn = fs.readSync(r, rb);
          if (ln !== rn || !lb.subarray(0, ln).equals(rb.subarray(0, rn))) return false;
          if (ln === 0) return true;
        }
      } finally { fs.closeSync(r); }
    } finally { fs.closeSync(l); }
  }
  if (!a.isDirectory() || !b.isDirectory()) return false;
  const ln = fs.readdirSync(left).sort(), rn = fs.readdirSync(right).sort();
  if (ln.length !== rn.length || ln.some((name, i) => name !== rn[i])) return false;
  return ln.every(name => pathsEqual(path.join(left, name), path.join(right, name)));
}
export function movePathPreserving(source: string, destination: string): void {
  if (fs.existsSync(destination)) {
    if (fs.existsSync(source)) {
      if (!pathsEqual(source, destination)) throw new Error(`恢复移动发现同名异内容条目，拒绝覆盖: ${source} -> ${destination}`);
      removePath(source); syncDirectory(path.dirname(source));
    }
    return;
  }
  if (!fs.existsSync(source)) throw new Error(`恢复移动的源和目标均不存在: ${source} -> ${destination}`);
  const parent = path.dirname(destination); fs.mkdirSync(parent, { recursive: true });
  let renamed = false;
  try { renameSyncWithRetry(source, destination); renamed = true; }
  catch (error) { storageLog(LOG_TARGET, 'warn', `恢复移动 rename 失败，改为持久复制: ${errorText(error)}`); }
  if (renamed) { syncDirectory(parent); syncDirectory(path.dirname(source)); return; }
  const temporary = path.join(parent, `.moving-${path.basename(destination)}`);
  if (fs.existsSync(temporary)) removePath(temporary);
  copyPathDurable(source, temporary);
  if (!pathsEqual(source, temporary)) { removePath(temporary); throw new Error(`恢复移动复制校验失败: ${source}`); }
  renameSyncWithRetry(temporary, destination); syncDirectory(parent); removePath(source); syncDirectory(path.dirname(source));
}

/**
 * `backup_common.rs:947 copy_directory_safe`: retain the source directory
 * basename under `destinationParent`, skip every symlink, and fail closed on
 * filesystem errors (Rust `?`, not a silent skip).
 */
export function copyDirectorySafe(source: string, destinationParent: string): number {
  if (isSymlinkPath(source)) {
    storageLog(LOG_TARGET, 'warn', `跳过符号链接目录 (安全防护): ${source}`);
    return 0;
  }
  const dirName = path.basename(source);
  if (!dirName) throw new Error('无法获取目录名');
  const targetDir = path.join(destinationParent, dirName);
  try { fs.mkdirSync(targetDir, { recursive: true }); }
  catch (error) { throw new Error(`创建目录失败 ${JSON.stringify(targetDir)}: ${errorText(error)}`); }
  return copyDirectoryRecursiveSafe(source, targetDir);
}

function copyDirectoryRecursiveSafe(source: string, destination: string): number {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(source, { withFileTypes: true }); }
  catch (error) { throw new Error(`读取目录失败 ${JSON.stringify(source)}: ${errorText(error)}`); }
  let total = 0;
  for (const entry of entries) {
    const file = path.join(source, entry.name);
    const dest = path.join(destination, entry.name);
    if (isSymlinkPath(file)) {
      storageLog(LOG_TARGET, 'warn', `跳过符号链接 (安全防护): ${file}`);
      continue;
    }
    if (entry.isDirectory()) {
      try { fs.mkdirSync(dest, { recursive: true }); }
      catch (error) { throw new Error(`创建目录失败 ${JSON.stringify(dest)}: ${errorText(error)}`); }
      total += copyDirectoryRecursiveSafe(file, dest);
    } else if (entry.isFile()) {
      try { fs.copyFileSync(file, dest); total += fs.statSync(dest).size; }
      catch (error) { throw new Error(`复制文件失败 ${JSON.stringify(file)}: ${errorText(error)}`); }
    }
  }
  return total;
}

function isSymlinkPath(file: string): boolean {
  try { return fs.lstatSync(file).isSymbolicLink(); }
  catch (error) {
    storageLog(LOG_TARGET, 'warn', `无法读取路径元数据 ${file}: ${errorText(error)}。安全优先：视为符号链接并跳过。`);
    return true;
  }
}
