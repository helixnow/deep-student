/**
 * 原子替换与目录落盘的公共工具（仅桌面，依赖 `node:fs`）。
 *
 * - `renameWithRetry(Sync)` / `renameSyncWithRetry`：`fs.rename` 套上 `paths/rename-retry.ts` 的重试策略
 *   （RF-W07-windows-rename-retry）：仅 win32、仅 `EPERM` / `EACCES` / `EBUSY`，按 `RENAME_RETRY_DELAYS_MS`
 *   退避，用尽后抛最后一次的原始错误；其他平台、其他错误码第一次失败就原样抛出。错误码、平台判断和退避表只在
 *   那个文件里维护，这里只是给插件用的 `node:fs` 入口。`paths/compat.ts` 曾提供同名导出，现已并入本模块。
 * - `atomicWriteFile`：同目录临时文件 → write → fsync → rename（`tempfile::NamedTempFile::persist`）。
 * - `createDirAll` / `setMode`：`std::fs::create_dir_all` 与 Unix `set_permissions`。
 * - `fsyncDirectory`：Rust `#[cfg(unix)] File::open(dir)?.sync_all()`，`#[cfg(not(unix))]` 什么也不做。打开或
 *   fsync 失败原样抛出；只想尽力而为的调用方自己吞掉错误。
 */
import fs from 'node:fs';
import { dirname, join } from './path.ts';
import { retryRename, retryRenameSync } from '../paths/rename-retry.ts';

export interface PlatformOption {
  /** 默认 `process.platform`。 */
  readonly platform?: NodeJS.Platform;
}

// RUST-FIX(RF-W14-files-rename-retry): Rust 的 std::fs::rename 在 Windows 上用 POSIX 语义替换被占用的目标，libuv 没有，改为退避重试。
export function renameWithRetry(from: string, to: string, options: PlatformOption = {}): Promise<void> {
  return retryRename(options.platform ?? process.platform, () => fs.promises.rename(from, to));
}

/** {@link renameWithRetry} 的同步版本；等待期间阻塞当前线程。 */
export function renameWithRetrySync(from: string, to: string, options: PlatformOption = {}): void {
  retryRenameSync(options.platform ?? process.platform, () => fs.renameSync(from, to));
}

/** `paths/compat.ts` 的旧名，语义与 {@link renameWithRetrySync} 相同。 */
export function renameSyncWithRetry(from: string, to: string, options: PlatformOption = {}): void {
  renameWithRetrySync(from, to, options);
}

/** `tempfile::NamedTempFile::new_in(parent)` 的命名：`.tmp` + 6 位随机字母数字。 */
function tempName(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  let out = '.tmp';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export interface AtomicWriteOptions {
  /** 临时文件创建权限（Unix）。tempfile 默认 0600。 */
  mode?: number;
  /** 写入并 fsync 后、rename 前调用（例如收紧权限）。 */
  beforeRename?: (tempPath: string) => Promise<void>;
}

/**
 * 同目录临时文件 → write → fsync → rename（`NamedTempFile::persist`）。
 * 失败时删除临时文件并重抛。父目录需已存在（调用方负责 `create_dir_all`）。
 */
export async function atomicWriteFile(path: string, data: Uint8Array | string, options: AtomicWriteOptions = {}): Promise<void> {
  const temp = join(dirname(path), tempName());
  const handle = await fs.promises.open(temp, 'wx', options.mode ?? 0o600);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.beforeRename) await options.beforeRename(temp);
    await renameWithRetry(temp, path);
  } catch (error) {
    await fs.promises.rm(temp, { force: true });
    throw error;
  }
}

/** `std::fs::create_dir_all`。 */
export async function createDirAll(path: string): Promise<void> {
  await fs.promises.mkdir(path, { recursive: true });
}

/** Unix `set_permissions(from_mode(mode))`。 */
export async function setMode(path: string, mode: number): Promise<void> {
  await fs.promises.chmod(path, mode);
}

export async function fsyncDirectory(dir: string, options: PlatformOption = {}): Promise<void> {
  if ((options.platform ?? process.platform) === 'win32') return;
  const handle = await fs.promises.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** {@link fsyncDirectory} 的同步版本。 */
export function fsyncDirectorySync(dir: string, options: PlatformOption = {}): void {
  if ((options.platform ?? process.platform) === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
