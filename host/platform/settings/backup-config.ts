/**
 * 备份配置（`src-tauri/src/backup_config.rs` 1–234、630–692）。
 *
 * 纯逻辑部分：`BackupConfig` 的 serde 兼容读写、有效目录/默认目录推导、自动备份暂存目录、
 * 旧自动备份清理、重入锁。命令注册见 `backup-commands.ts`。
 */
import { statSync, type Dirent } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { AppError } from '../errors/api.ts';
import { ioMessageFor } from '../paths/io-error.ts';
import {
  BackupConfigError,
  defaultAutoBackupStatus,
  defaultBackupConfig,
  normalizeBackupConfig,
  parseAutoBackupStatus,
  parseBackupConfig,
  serializeAutoBackupStatus,
  serializeBackupConfig,
  type AutoBackupStatus,
  type BackupConfig,
  type BackupTier,
} from './backup-config-core.ts';

export {
  BackupConfigError,
  defaultAutoBackupStatus,
  defaultBackupConfig,
  normalizeBackupConfig,
  parseAutoBackupStatus,
  parseBackupConfig,
  serializeAutoBackupStatus,
  serializeBackupConfig,
  type AutoBackupStatus,
  type BackupConfig,
  type BackupTier,
};

/** Rust `io::Error` Display（`<strerror> (os error N)`）。 */
function ioMessage(error: unknown): string {
  return ioMessageFor(error, process.platform);
}

/**
 * `BackupConfig::effective_backup_directory`（`backup_config.rs:95–104`）：自定义目录存在且为目录才返回。
 */
export function effectiveBackupDirectory(config: BackupConfig): string | null {
  const dir = config.backupDirectory;
  if (dir === null) return null;
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** `default_recovery_backup_dir`（`backup_config.rs:649–657`）：默认备份在 A/B 槽之外。 */
export function defaultRecoveryBackupDir(runtimeRoot: string): string {
  const root = resolve(runtimeRoot);
  const parent = dirname(root);
  const base = basename(parent) === 'slots' ? dirname(parent) : root;
  return join(base, 'recovery', 'backups');
}

/**
 * `get_effective_backup_dir`（`backup_config.rs:630–646`）：自定义目录不可用时显式失败，绝不静默回退。
 */
export async function getEffectiveBackupDir(config: BackupConfig, root: string): Promise<string> {
  if (config.backupDirectory !== null) {
    const custom = config.backupDirectory;
    let ok = false;
    try {
      ok = (await stat(custom)).isDirectory();
    } catch {
      ok = false;
    }
    if (ok) return custom;
    throw new BackupConfigError(AppError.file_system(`自定义备份目录不可用: ${custom}。为避免误导，未回退到默认目录`));
  }
  return defaultRecoveryBackupDir(root);
}

/** 自动备份输出目录的 `create_dir_all`（`backup_config.rs:410–412`）。 */
export async function createAutoBackupOutputDir(backupsDir: string): Promise<void> {
  try {
    await mkdir(backupsDir, { recursive: true });
  } catch (error) {
    throw new BackupConfigError(AppError.file_system(`创建自动备份输出目录失败: ${ioMessage(error)}`), { cause: error });
  }
}

export interface AutoBackupStagingDir {
  readonly path: string;
  /** Rust `tempfile::TempDir` 的 drop 行为。 */
  cleanup(): Promise<void>;
}

/**
 * `create_auto_backup_staging_dir`（`backup_config.rs:239–246`）：暂存目录必须位于应用数据目录下，
 * 而不是用户选择的自定义备份目的地。
 */
export async function createAutoBackupStagingDir(appDataRoot: string): Promise<AutoBackupStagingDir> {
  try {
    await mkdir(appDataRoot, { recursive: true });
  } catch (error) {
    throw new BackupConfigError(AppError.file_system(`创建应用数据目录失败: ${ioMessage(error)}`), { cause: error });
  }
  try {
    const path = await mkdtemp(join(appDataRoot, 'auto-backup-staging-'));
    return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
  } catch (error) {
    throw new BackupConfigError(AppError.file_system(`创建自动备份暂存目录失败: ${ioMessage(error)}`), { cause: error });
  }
}

/**
 * RUST-FIX(RF-W30-auto-backup-staging-sweep): 删除被中断的自动备份留下的 `auto-backup-staging-*` 目录
 * （里面是含 crypto/ 的原始备份）。调用方必须持有数据治理租约，否则会删掉另一次正在进行的自动备份的暂存目录。
 */
export async function sweepStaleAutoBackupStagingDirs(
  appDataRoot: string,
  warn: (message: string) => void = () => undefined,
  info: (message: string) => void = () => undefined,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(appDataRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('auto-backup-staging-')) continue;
    const path = join(appDataRoot, entry.name);
    info(`[AutoBackup] 清理遗留暂存目录: ${path}`);
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      warn(`[AutoBackup] 清理遗留暂存目录失败 ${path}: ${ioMessage(error)}`);
    }
  }
}

/** `log_and_skip_entry_err`（`dstu-storage/src/backup_common.rs:28–38`）的显式 Result 版本。 */
export function logAndSkipEntryErr<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
  onError: (error: unknown) => void,
): T | null {
  if (result.ok === true) return result.value;
  onError(result.error);
  return null;
}

/**
 * `cleanup_old_backups`（`backup_config.rs:659–692`）：只清理 `auto-backup-*.zip`，按 mtime 保留最新 N 个；
 * 目录不可读或单个文件的元数据读不到时静默跳过（Rust `if let Ok(..)`），删除前记 info，删除失败只记 warn。
 */
export async function cleanupOldBackups(
  backupsDir: string,
  maxCount: number,
  warn: (message: string) => void = () => undefined,
  info: (message: string) => void = () => undefined,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(backupsDir);
  } catch {
    return;
  }
  const autoBackups: { path: string; modified: number }[] = [];
  for (const name of names) {
    if (!name.startsWith('auto-backup-') || !name.endsWith('.zip')) continue;
    const path = join(backupsDir, name);
    let modified: number;
    try {
      modified = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    autoBackups.push({ path, modified });
  }
  autoBackups.sort((a, b) => b.modified - a.modified);
  for (const backup of autoBackups.slice(maxCount)) {
    info(`[AutoBackup] 删除旧备份: ${backup.path}`);
    try {
      await unlink(backup.path);
    } catch (error) {
      warn(`[AutoBackup] 删除旧备份失败 ${backup.path}: ${ioMessage(error)}`);
    }
  }
}

/** `AUTO_BACKUP_RUNNING` 的 `compare_exchange(false, true, SeqCst, SeqCst)` 语义（`backup_config.rs:237,291–305`）。 */
export function createAutoBackupLock(): {
  tryAcquire(): boolean;
  release(): void;
  isRunning(): boolean;
} {
  let running = false;
  return {
    tryAcquire() {
      if (running) return false;
      running = true;
      return true;
    },
    release() {
      running = false;
    },
    isRunning() {
      return running;
    },
  };
}

/** 写探测文件（`FileManager::get_writable_app_data_dir` 的 ensure_writable）。 */
export async function ensureWritable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, '.write_test');
    try {
      await writeFile(probe, 'ok');
    } finally {
      await unlink(probe).catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
}
