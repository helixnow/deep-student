/**
 * `backup_common.rs:632-930` 的 `get_available_disk_space`：系统调用、命令行回退与 fail-closed 的判定。
 * 不依赖 Node 模块；文件系统与子进程由调用方注入（Node 实现见 data-space-files.ts 的 `getAvailableDiskSpace`）。
 */
import { AppError } from '../errors/api.ts';
import { ioMessageFor } from '../paths/io-error.ts';
import { posix, win32 } from '../util/path.ts';
import { rustTrim } from '../util/portable.ts';
import { storageLog } from './logging.ts';

const LOG_TARGET = 'dstu_storage::backup_common';

export interface DiskSpaceSystem {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  exists(path: string): boolean;
  /** statvfs / GetDiskFreeSpaceExW；失败时抛出带 errno 的错误。 */
  statfs(path: string): { bavail: number | bigint; bsize: number | bigint };
  run(command: string, args: readonly string[]): { status: number | null; stdout: string; error?: Error };
}

/** Rust `str::parse::<u64>()`：可选 `+`，其余全是十进制数字。 */
function parseU64(text: string): number | null {
  if (!/^\+?[0-9]+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function gigabytes(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(2);
}

/** `get_disk_space_df_fallback`：`df -k <path>` 第二行第四列（KB）。 */
function diskSpaceDfFallback(checkPath: string, system: DiskSpaceSystem): number | null {
  const output = system.run('df', ['-k', checkPath]);
  if (output.error !== undefined || output.status !== 0) return null;
  const line = output.stdout.split('\n')[1];
  if (line === undefined) return null;
  const parts = rustTrim(line).split(/\s+/);
  if (parts.length < 4) return null;
  const availableKb = parseU64(parts[3]!);
  if (availableKb === null || !Number.isSafeInteger(availableKb * 1024)) return null;
  storageLog(LOG_TARGET, 'debug', `[BackupCommon] df 回退成功: available=${availableKb} KB`);
  return availableKb * 1024;
}

/** `get_disk_space_wmic_fallback`：`wmic logicaldisk where DeviceID='C:' get FreeSpace`，取第一行能解析的数字。 */
function diskSpaceWmicFallback(checkPath: string, system: DiskSpaceSystem): number | null {
  // Rust `path.components().next()`：盘符前缀 `C:`（不带分隔符），UNC 为 `\\server\share`。
  const drive = win32.parse(checkPath).root.replace(/[\\/]+$/, '') || 'C:';
  const output = system.run('wmic', ['logicaldisk', 'where', `DeviceID='${drive}'`, 'get', 'FreeSpace']);
  if (output.error !== undefined || output.status !== 0) return null;
  for (const line of output.stdout.split('\n')) {
    const value = parseU64(rustTrim(line));
    if (value !== null) {
      storageLog(LOG_TARGET, 'debug', `[BackupCommon] wmic 回退成功: available=${value} bytes`);
      return value;
    }
  }
  return null;
}

/**
 * 系统调用（statvfs / GetDiskFreeSpaceExW）失败时回退 `df -k` / `wmic`，再失败则看
 * `BACKUP_ALLOW_UNKNOWN_DISK_SPACE`（1GB），否则记 error 并抛错（fail-closed）。
 */
export function availableDiskSpace(target: string, system: DiskSpaceSystem): number {
  const windows = system.platform === 'win32';

  let checkPath = target;
  if (!system.exists(checkPath)) {
    const parent = (windows ? win32 : posix).dirname(checkPath);
    checkPath = system.exists(parent) ? parent : (windows ? 'C:\\' : '/');
  }

  try {
    const stats = system.statfs(checkPath);
    const available = Number(stats.bavail) * Number(stats.bsize);
    storageLog(LOG_TARGET, 'debug', windows
      ? `[BackupCommon] GetDiskFreeSpaceExW 成功: path=${JSON.stringify(checkPath)}, available=${available} bytes (${gigabytes(available)} GB)`
      : `[BackupCommon] statvfs 成功: path=${checkPath}, available=${available} bytes (${gigabytes(available)} GB)`);
    return available;
  } catch (error) {
    const detail = ioMessageFor(error, system.platform);
    storageLog(LOG_TARGET, 'warn', windows
      ? `[BackupCommon] GetDiskFreeSpaceExW 调用失败，回退到命令行解析: GetDiskFreeSpaceExW 调用失败 (path=${JSON.stringify(checkPath)}): ${detail}`
      : `[BackupCommon] statvfs 调用失败，回退到 df 命令解析: statvfs 调用失败 (path=${JSON.stringify(checkPath)}): ${detail}`);
  }

  const fallback = windows ? diskSpaceWmicFallback(checkPath, system) : diskSpaceDfFallback(checkPath, system);
  if (fallback !== null) return fallback;

  const allowFallback = system.env.BACKUP_ALLOW_UNKNOWN_DISK_SPACE;
  if (allowFallback === '1' || allowFallback?.toLowerCase() === 'true') {
    storageLog(
      LOG_TARGET,
      'warn',
      '无法获取磁盘可用空间，使用保守估计值 1GB（已通过环境变量启用回退模式）。如果操作失败，请确保磁盘有足够空间后重试。',
    );
    return 1024 * 1024 * 1024;
  }
  storageLog(
    LOG_TARGET,
    'error',
    '无法获取磁盘可用空间，为确保数据安全，操作已中止。请检查文件系统权限或设置 BACKUP_ALLOW_UNKNOWN_DISK_SPACE=1 环境变量以启用回退模式。',
  );
  throw AppError.validation(
    '无法获取磁盘可用空间。请检查文件系统权限，或设置 BACKUP_ALLOW_UNKNOWN_DISK_SPACE=1 环境变量以使用保守估计值。',
  );
}
