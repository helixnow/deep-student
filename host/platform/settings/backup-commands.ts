/**
 * 备份配置命令（`src-tauri/src/backup_config.rs:107–234`）。
 *
 * 设置键与 Rust 相同：`backup.config`、`backup.auto_backup_status`；只经 `ctx.settings`（主库 settings 表）。
 * 只注册 Rust `generate_handler!`（`src-tauri/src/lib.rs:2219–2223`）中的五条命令；
 * `get_auto_backup_status`（`backup_config.rs:231–234`）在 Rust 中只有定义、未注册，这里同样不注册，
 * `loadAutoBackupStatus` 对应调度器内部使用的 `AutoBackupStatus::load`。
 */
import { join } from 'node:path';
import { CommandError, definePlugin, ShellError, type Context } from '../../kernel/api.ts';
import { AppError } from '../errors/api.ts';
import type { PathsService } from '../paths/api.ts';
import type { FileManagerPathsService } from '../storage/api.ts';
import type { SettingsService } from './api.ts';
import {
  BackupConfigError,
  defaultAutoBackupStatus,
  defaultBackupConfig,
  defaultRecoveryBackupDir,
  ensureWritable,
  normalizeBackupConfig,
  parseAutoBackupStatus,
  parseBackupConfig,
  serializeBackupConfig,
  type AutoBackupStatus,
  type BackupConfig,
} from './backup-config.ts';

const BACKUP_CONFIG_KEY = 'backup.config';
const AUTO_BACKUP_STATUS_KEY = 'backup.auto_backup_status';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rethrow(error: unknown): never {
  if (error instanceof BackupConfigError) throw new CommandError(error.appError);
  throw new CommandError(AppError.internal(message(error)));
}

function databaseError(error: unknown): BackupConfigError {
  return new BackupConfigError(AppError.database(`数据库错误: ${message(error)}`), { cause: error });
}

function loadBackupConfig(settings: SettingsService): BackupConfig {
  let raw: string | null;
  try {
    raw = settings.get(BACKUP_CONFIG_KEY);
  } catch (error) {
    throw databaseError(error);
  }
  return raw === null ? defaultBackupConfig() : parseBackupConfig(raw);
}

function saveBackupConfig(settings: SettingsService, config: BackupConfig): void {
  let json: string;
  try {
    json = serializeBackupConfig(config);
  } catch (error) {
    throw new BackupConfigError(AppError.internal(`序列化备份配置失败: ${message(error)}`), { cause: error });
  }
  try {
    settings.save(BACKUP_CONFIG_KEY, json);
  } catch (error) {
    throw databaseError(error);
  }
}

/** `AutoBackupStatus::load`（`backup_config.rs:214–221`）。 */
export function loadAutoBackupStatus(settings: SettingsService): AutoBackupStatus {
  let raw: string | null;
  try {
    raw = settings.get(AUTO_BACKUP_STATUS_KEY);
  } catch (error) {
    throw databaseError(error);
  }
  return raw === null ? defaultAutoBackupStatus() : parseAutoBackupStatus(raw);
}

/** Rust `{:?}` for `Option<u32>`: `Some(5)` / `None`。 */
function debugOption(value: number | null): string {
  return value === null ? 'None' : `Some(${value})`;
}

/** `FileManager::get_writable_app_data_dir`（`dstu-storage/src/file_manager.rs:167–219`），没装 `fileManagerPaths` 的宿主才用。 */
async function writableAppDataDir(ctx: Context): Promise<string> {
  const paths: PathsService = ctx.paths;
  const primary = paths.appDataDir;
  try {
    if (await ensureWritable(primary)) return primary;
  } catch (error) {
    ctx.logger.error(`⚠️ [文件系统] 创建目录失败 ${primary}: ${message(error)}`);
  }
  const fallback = join(paths.os.data, 'DeepStudent');
  if (await ensureWritable(fallback)) return fallback;
  const temp = join(paths.os.temp, 'deep_student_data');
  if (!(await ensureWritable(temp))) ctx.logger.warn(`⚠️ [文件系统] 无法获取稳定的持久目录，临时使用 ${temp}`);
  return temp;
}

export function registerBackupConfigCommands(ctx: Context): void {
  ctx.commands.register('get_backup_config', () => {
    try {
      return loadBackupConfig(ctx.settings);
    } catch (error) {
      rethrow(error);
    }
  });

  ctx.commands.register<{ config: unknown }>('set_backup_config', ({ config: input }) => {
    try {
      const config = normalizeBackupConfig(input);
      saveBackupConfig(ctx.settings, config);
      ctx.logger.info(
        `[AutoBackup] 配置已更新: auto=${config.autoBackupEnabled}, interval=${config.autoBackupIntervalHours}h, max=${debugOption(config.maxBackupCount)}, slim=${config.slimBackup}, tiers=${config.backupTiers?.length ?? 0}`,
      );
      return null;
    } catch (error) {
      rethrow(error);
    }
  });

  ctx.commands.register('pick_backup_directory', async (_args, call) => {
    let selected: string | null | undefined;
    try {
      selected = await ctx.shell.request<string | null>('dialog.open', {
        options: { directory: true, title: '选择备份目录' },
        __window: call.source.window,
      });
    } catch (error) {
      // blocking_pick_folder has no error channel: rfd logs the backend failure and yields None
      // (rfd-0.16.0 backend/xdg_desktop_portal.rs:162-169), which backup_config.rs:167 returns as Ok(None).
      if (!(error instanceof ShellError)) throw error;
      ctx.logger.error(`Failed to pick folder: ${error.message}`);
      return null;
    }
    if (selected === null || selected === undefined) return null;
    try {
      const config = loadBackupConfig(ctx.settings);
      config.backupDirectory = selected;
      saveBackupConfig(ctx.settings, config);
      ctx.logger.info(`[AutoBackup] 备份目录已设置: ${selected}`);
      return selected;
    } catch (error) {
      rethrow(error);
    }
  });

  ctx.commands.register('clear_backup_directory', () => {
    try {
      const config = loadBackupConfig(ctx.settings);
      config.backupDirectory = null;
      saveBackupConfig(ctx.settings, config);
      ctx.logger.info('[AutoBackup] 备份目录已清除，将使用默认目录');
      return null;
    } catch (error) {
      rethrow(error);
    }
  });

  // RUST-FIX(RF-W08-default-backup-dir-no-relocation): Rust 取 `get_writable_app_data_dir`，活动槽不可写时报出
  // `data_dir()/DeepStudent` 或 temp 下的目录，而备份从不写到那里；这里取持久目录（活动槽），不可用时报错。
  ctx.commands.register('get_default_backup_directory', async () => {
    const fileManager = ctx.get('fileManagerPaths') as FileManagerPathsService | undefined;
    const root = fileManager === undefined ? await writableAppDataDir(ctx) : fileManager.getPersistentAppDataDir();
    return defaultRecoveryBackupDir(root);
  });
}

export default definePlugin({
  meta: {
    id: 'dstu.platform.backup-config',
    lane: 'F4-security',
    commands: [
      'get_backup_config',
      'set_backup_config',
      'pick_backup_directory',
      'clear_backup_directory',
      'get_default_backup_directory',
    ],
  },
  inject: ['settings', 'paths'],
  apply(ctx) {
    registerBackupConfigCommands(ctx);
  },
});
