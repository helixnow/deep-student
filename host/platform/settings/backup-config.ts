/**
 * 备份配置（`src-tauri/src/backup_config.rs` 1–234、630–692）。
 *
 * 纯逻辑部分：`BackupConfig` 的 serde 兼容读写、有效目录/默认目录推导、自动备份暂存目录、
 * 旧自动备份清理、重入锁。命令注册见 `backup-commands.ts`。
 */
import { statSync, type Dirent } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { AppError, type AppError as AppErrorValue } from '../errors/api.ts';
import { ioMessageFor } from '../paths/io-error.ts';
import { JsonReader } from '../util/index.ts';

/** `BackupConfig`（`backup_config.rs:28–53`）。`backupTiers === undefined` = Rust `None`（省略字段）。 */
export interface BackupConfig {
  backupDirectory: string | null;
  autoBackupEnabled: boolean;
  autoBackupIntervalHours: number;
  maxBackupCount: number | null;
  slimBackup: boolean;
  backupTiers?: BackupTier[];
}

/** `BackupTier` 的线上值（`dstu-sync/.../backup/mod.rs:1935–1945`）。 */
export type BackupTier = 'core' | 'important' | 'rebuildable' | 'large_assets';

/** `AutoBackupStatus`（`backup_config.rs:204–212`）。 */
export interface AutoBackupStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextDueAt: string | null;
  lastJobId: string | null;
}

/** 与 Rust `BackupConfig::default()`（`backup_config.rs:59–70`）相同。 */
export function defaultBackupConfig(): BackupConfig {
  return {
    backupDirectory: null,
    autoBackupEnabled: false,
    autoBackupIntervalHours: 24,
    maxBackupCount: 5,
    slimBackup: false,
  };
}

/** 与 Rust `AutoBackupStatus::default()`（`#[derive(Default)]`）相同。 */
export function defaultAutoBackupStatus(): AutoBackupStatus {
  return { lastAttemptAt: null, lastSuccessAt: null, lastError: null, nextDueAt: null, lastJobId: null };
}

/** 携带 Rust `AppError` 形状的配置错误，命令层原样转换成 `CommandError`。 */
export class BackupConfigError extends Error {
  readonly appError: AppErrorValue;
  constructor(appError: AppErrorValue, options?: { cause?: unknown }) {
    super(appError.message, options);
    this.name = 'BackupConfigError';
    this.appError = appError;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rust `io::Error` Display（`<strerror> (os error N)`）。 */
function ioMessage(error: unknown): string {
  return ioMessageFor(error, process.platform);
}

function internal(prefix: string, error: unknown): BackupConfigError {
  return new BackupConfigError(AppError.internal(`${prefix}: ${message(error)}`), { cause: error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TIER_ALIASES: Readonly<Record<string, BackupTier>> = {
  core: 'core',
  core_config_chat: 'core',
  important: 'important',
  vfs_full: 'important',
  rebuildable: 'rebuildable',
  large_assets: 'large_assets',
  large_files: 'large_assets',
};

const TIER_VARIANTS = '`core`, `important`, `rebuildable`, `large_assets`';

/** `BackupTier`（snake_case + alias）：字符串，或 externally-tagged `{ "variant": null }`。 */
function readTier(r: JsonReader): BackupTier {
  const variant = (name: string): BackupTier => {
    if (Object.hasOwn(TIER_ALIASES, name)) return TIER_ALIASES[name]!;
    throw r.error(`unknown variant \`${name}\`, expected one of ${TIER_VARIANTS}`);
  };
  if (r.peekKind() === 'string') return variant(r.readString());
  r.beginObject('string or map');
  const name = r.readEnumVariant();
  const tier = variant(name);
  r.readNull('unit');
  r.endEnumObject();
  return tier;
}

/**
 * `serde_json::from_str::<BackupConfig>`（`backup_config.rs:28-52`，derive，无 deny_unknown_fields）：
 * 按 serde 的消费顺序逐字段读取——类型错误、已知字段重复先于后续语法错误与尾随字符报出。
 * 解析失败时抛 `BackupConfigError(Unknown, "解析备份配置失败: …")`，与 `BackupConfig::load` 相同。
 */
export function parseBackupConfig(json: string): BackupConfig {
  try {
    const r = new JsonReader(json);
    const config: BackupConfig = {
      backupDirectory: null, autoBackupEnabled: false, autoBackupIntervalHours: 24, maxBackupCount: null, slimBackup: false,
    };
    const readField = (key: string): void => {
      switch (key) {
        case 'backupDirectory': config.backupDirectory = r.readOptionNone() ? null : r.readString(); break;
        case 'autoBackupEnabled': config.autoBackupEnabled = r.readBool(); break;
        case 'autoBackupIntervalHours': config.autoBackupIntervalHours = Number(r.readUnsigned('u32', 0xffff_ffffn)); break;
        case 'maxBackupCount': config.maxBackupCount = r.readOptionNone() ? null : Number(r.readUnsigned('u32', 0xffff_ffffn)); break;
        case 'slimBackup': config.slimBackup = r.readBool(); break;
        case 'backupTiers': {
          if (r.readOptionNone()) break;
          r.beginArray();
          const tiers: BackupTier[] = [];
          while (r.nextItem()) tiers.push(readTier(r));
          config.backupTiers = tiers;
          break;
        }
      }
    };
    if (r.peekKind() === 'array') {
      r.beginArray();
      let closed = false;
      for (const key of BACKUP_CONFIG_FIELDS) {
        // Every BackupConfig field has #[serde(default)]: missing tail elements
        // keep the same defaults as absent map fields.
        if (!r.nextItem()) { closed = true; break; }
        readField(key);
      }
      if (!closed) r.endArray();
    } else {
      r.beginObject('struct BackupConfig');
      const seen = new Set<string>();
      for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
        if (!BACKUP_CONFIG_FIELDS.includes(key)) { r.skipIgnoredValue(); continue; }
        if (seen.has(key)) throw r.fieldError(`duplicate field \`${key}\``);
        seen.add(key);
        readField(key);
      }
    }
    r.end();
    return config;
  } catch (error) {
    throw internal('解析备份配置失败', error);
  }
}

const BACKUP_CONFIG_FIELDS = ['backupDirectory', 'autoBackupEnabled', 'autoBackupIntervalHours', 'maxBackupCount', 'slimBackup', 'backupTiers'];
const AUTO_BACKUP_STATUS_FIELDS = ['lastAttemptAt', 'lastSuccessAt', 'lastError', 'nextDueAt', 'lastJobId'] as const;

/** `serde_json::to_string::<BackupConfig>` 的等价输出（字段顺序、`skip_serializing_if` 相同）。 */
export function serializeBackupConfig(config: BackupConfig): string {
  const out: Record<string, unknown> = {
    backupDirectory: config.backupDirectory ?? null,
    autoBackupEnabled: config.autoBackupEnabled,
    autoBackupIntervalHours: config.autoBackupIntervalHours,
    maxBackupCount: config.maxBackupCount ?? null,
    slimBackup: config.slimBackup,
  };
  if (config.backupTiers !== undefined && config.backupTiers !== null) out.backupTiers = [...config.backupTiers];
  return JSON.stringify(out);
}

/** 反序列化命令行参数（`BackupConfig__De`）时补齐默认值并规范化 BackupTier 别名。 */
export function normalizeBackupConfig(value: unknown): BackupConfig {
  if (!isRecord(value)) throw internal('解析备份配置失败', new Error('expected a JSON object'));
  return parseBackupConfig(JSON.stringify(value));
}

/** `serde_json::from_str::<AutoBackupStatus>`；失败文案与 `AutoBackupStatus::load` 相同。 */
export function parseAutoBackupStatus(json: string): AutoBackupStatus {
  try {
    const r = new JsonReader(json);
    const status: AutoBackupStatus = { lastAttemptAt: null, lastSuccessAt: null, lastError: null, nextDueAt: null, lastJobId: null };
    const readField = (field: typeof AUTO_BACKUP_STATUS_FIELDS[number]): void => {
      status[field] = r.readOptionNone() ? null : r.readString();
    };
    if (r.peekKind() === 'array') {
      r.beginArray();
      for (const [index, field] of AUTO_BACKUP_STATUS_FIELDS.entries()) {
        // Unlike BackupConfig, Option fields here have no #[serde(default)] in visit_seq.
        if (!r.nextItem()) throw r.error(`invalid length ${index}, expected struct AutoBackupStatus with 5 elements`);
        readField(field);
      }
      r.endArray();
    } else {
      r.beginObject('struct AutoBackupStatus');
      const seen = new Set<string>();
      for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
        const field = AUTO_BACKUP_STATUS_FIELDS.find(name => name === key);
        if (field === undefined) { r.skipIgnoredValue(); continue; }
        if (seen.has(field)) throw r.fieldError(`duplicate field \`${field}\``);
        seen.add(field);
        readField(field);
      }
    }
    r.end();
    return status;
  } catch (error) {
    throw internal('解析自动备份状态失败', error);
  }
}

/** `serde_json::to_string::<AutoBackupStatus>`（`backup_config.rs:223–228`）：字段顺序与 Rust 相同，`None` 写 null。 */
export function serializeAutoBackupStatus(status: AutoBackupStatus): string {
  return JSON.stringify({
    lastAttemptAt: status.lastAttemptAt,
    lastSuccessAt: status.lastSuccessAt,
    lastError: status.lastError,
    nextDueAt: status.nextDueAt,
    lastJobId: status.lastJobId,
  });
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
