/**
 * 迁移前核心库快照、单库/全量恢复与恢复故障 journal，移植自
 * `dstu-storage/src/migration/coordinator.rs`：
 * `current_database_version_or_zero`、`core_backup_root_dir`、`restore_failure_journal_path`、
 * `load/persist_restore_failure_journal`、`record_restore_failure`、`retry_persisted_restore_failures`、
 * `startup_guard_key` + `STARTUP_CORE_BACKUP_GUARD`、`maybe_backup_core_databases_before_migration`、
 * `backup_sqlite_consistent`、`prune_old_core_backups`、`restore_from_latest_core_backup`、
 * `restore_database_from_latest_core_backup`、`backup_core_databases_once_per_startup`、
 * `preflight_disk_space_check`（+ `backup_common::get_available_disk_space`），以及报告类型
 * `MigrationReport` / `DatabaseMigrationReport` / `data_space/startup_health.rs::StartupComponentHealth`。
 *
 * 磁盘格式（目录名、metadata.json、restore-failures.json）与 Rust 逐字段一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CoordinatedDatabaseName } from '../api.ts';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import { getAvailableDiskSpace } from '../data-space-files.ts';
import { MigrationError, errorText } from './errors.ts';
import type { MigrationLog } from './helpers.ts';
import { toRfc3339Opts } from '../../time/index.ts';
import { chronoRfc3339Now } from './refinery.ts';

export const CORE_BACKUP_ROOT_DIR_NAME = 'migration_core_backups';
export const CORE_BACKUP_RETENTION_COUNT = 5;
export const RESTORE_FAILURE_JOURNAL_FILE = 'restore-failures.json';

/** `DatabaseId::all_ordered()`。 */
export const ALL_ORDERED: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];

/** `DatabaseId::dependencies()`。 */
export const DATABASE_DEPENDENCIES: Readonly<Record<CoordinatedDatabaseName, readonly CoordinatedDatabaseName[]>> = {
  vfs: [],
  chat_v2: ['vfs'],
  mistakes: ['vfs'],
  llm_usage: [],
};

/** 快照中的相对路径（`restore_database_from_latest_core_backup` 的 match）。 */
export const CORE_RELATIVE_PATHS: Readonly<Record<CoordinatedDatabaseName, string>> = {
  vfs: 'databases/vfs.db',
  chat_v2: 'chat_v2.db',
  mistakes: 'mistakes.db',
  llm_usage: 'llm_usage.db',
};

/** `backup_core_databases_once_per_startup` 的 core_files 顺序。 */
const CORE_FILES = ['databases/vfs.db', 'chat_v2.db', 'mistakes.db', 'llm_usage.db'] as const;

/** `DatabaseId` 的 serde 表示（无 rename 属性 → 变体名）。 */
const DATABASE_ID_SERDE: Readonly<Record<CoordinatedDatabaseName, string>> = {
  vfs: 'Vfs',
  chat_v2: 'ChatV2',
  mistakes: 'Mistakes',
  llm_usage: 'LlmUsage',
};

function databaseFromSerde(value: unknown): CoordinatedDatabaseName | undefined {
  for (const [name, serde] of Object.entries(DATABASE_ID_SERDE)) {
    if (serde === value) return name as CoordinatedDatabaseName;
  }
  return undefined;
}

// ------------------------------------------------------------------ 启动健康状态与报告

export type StartupComponentStatus = 'healthy' | 'degraded' | 'blocked';

export interface StartupComponentIssue {
  component: string;
  status: StartupComponentStatus;
  reason: string | null;
  dependency: string | null;
}

/** `StartupComponentHealth`（serde：`{ components: [...] }`，status snake_case）。 */
export class StartupComponentHealth {
  components: StartupComponentIssue[] = ['vfs', 'mistakes', 'chat_v2', 'llm_usage', 'audit'].map((component) => ({
    component,
    status: 'healthy',
    reason: null,
    dependency: null,
  }));

  isBlocked(component: string): boolean {
    return this.components.some((e) => e.component === component && e.status === 'blocked');
  }

  blockedComponents(): string[] {
    return this.components.filter((e) => e.status === 'blocked').map((e) => e.component);
  }

  requiresCoreRecovery(): boolean {
    return this.isBlocked('vfs') || this.isBlocked('mistakes');
  }

  issues(): StartupComponentIssue[] {
    return this.components.filter((e) => e.status !== 'healthy').map((e) => ({ ...e }));
  }

  markDegraded(component: string, reason: string): void {
    this.set(component, 'degraded', reason, null);
  }

  markBlocked(component: string, reason: string): void {
    this.set(component, 'blocked', reason, null);
  }

  markDependencyBlocked(component: string, dependency: string, reason: string): void {
    this.set(component, 'blocked', reason, dependency);
  }

  applyDatabaseDependencyClosure(): void {
    if (!this.isBlocked('vfs')) return;
    for (const dependent of ['chat_v2', 'mistakes']) {
      if (this.components.some((e) => e.component === dependent && e.status === 'healthy')) {
        this.markDependencyBlocked(dependent, 'vfs', "Skipped because dependency 'vfs' is blocked");
      }
    }
  }

  private set(component: string, status: StartupComponentStatus, reason: string, dependency: string | null): void {
    const entry = this.components.find((e) => e.component === component);
    if (entry === undefined) return;
    entry.status = status;
    entry.reason = reason;
    entry.dependency = dependency;
  }

  toJSON(): { components: StartupComponentIssue[] } {
    return { components: this.components.map((e) => ({ ...e })) };
  }
}

/** `DatabaseMigrationReport`。 */
export interface DatabaseMigrationReportRecord {
  id: CoordinatedDatabaseName;
  fromVersion: number;
  toVersion: number;
  appliedCount: number;
  success: boolean;
  durationMs: number;
  error: string | null;
}

/** `MigrationReport`。 */
export class CoreMigrationReport {
  databases: DatabaseMigrationReportRecord[] = [];
  success = true;
  totalDurationMs = 0;
  error: string | null = null;
  componentHealth = new StartupComponentHealth();

  add(report: DatabaseMigrationReportRecord): void {
    if (!report.success) this.success = false;
    this.databases.push(report);
  }
}

// ------------------------------------------------------------------ 恢复故障 journal

/** `PersistentRestoreFailure`（字段顺序即 serde 顺序）。 */
export interface PersistentRestoreFailure {
  database: CoordinatedDatabaseName;
  migration_error: string;
  restore_error: string;
  failed_at: string;
  /**
   * 失败那次启动建立的快照目录名（`startup_*`），重试只从它恢复。Rust 没有此字段：旧版读取时忽略，
   * 旧版重写记录时丢弃；缺失时视为没有可信快照。
   */
  snapshot?: string;
}

function serializeJournal(failures: readonly PersistentRestoreFailure[]): string {
  return JSON.stringify(
    {
      failures: failures.map((f) => ({
        database: DATABASE_ID_SERDE[f.database],
        migration_error: f.migration_error,
        restore_error: f.restore_error,
        failed_at: f.failed_at,
        ...(f.snapshot === undefined ? {} : { snapshot: f.snapshot }),
      })),
    },
    null,
    2,
  );
}

function parseJournal(content: string, file: string): PersistentRestoreFailure[] {
  const corrupt = (detail: string) => MigrationError.database(`单库恢复故障记录已损坏 ${file}: ${detail}`);
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw corrupt(errorText(error));
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw corrupt('invalid type: expected struct PersistentRestoreFailureJournal');
  const failures = (value as Record<string, unknown>).failures;
  // `#[serde(default)]`
  if (failures === undefined) return [];
  if (!Array.isArray(failures)) throw corrupt('invalid type: expected a sequence for field `failures`');
  return failures.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) throw corrupt(`invalid failure entry at index ${index}`);
    const r = raw as Record<string, unknown>;
    const database = databaseFromSerde(r.database);
    if (database === undefined) throw corrupt(`unknown variant \`${String(r.database)}\``);
    for (const key of ['migration_error', 'restore_error', 'failed_at'] as const) {
      if (typeof r[key] !== 'string') throw corrupt(`missing field \`${key}\``);
    }
    return {
      database,
      migration_error: r.migration_error as string,
      restore_error: r.restore_error as string,
      failed_at: r.failed_at as string,
      ...(isSnapshotName(r.snapshot) ? { snapshot: r.snapshot } : {}),
    };
  });
}

/** 只接受本模块写出的快照目录名，防止记录文件里的路径穿越。 */
function isSnapshotName(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('startup_') && path.basename(value) === value && !value.includes('\\');
}

/** 单库恢复的实际结果；`untouched` 表示没有可信快照，数据库文件（及其 WAL/SHM）一个字节都没动。 */
export type SingleDatabaseRestore =
  | { kind: 'restored'; snapshot: string }
  | { kind: 'removed'; snapshot: string }
  | { kind: 'untouched'; path: string; olderSnapshot: string | null };

// ------------------------------------------------------------------ 进程级备份 guard

/** `STARTUP_CORE_BACKUP_GUARD`：同一进程中每个数据目录只做一次迁移前快照。 */
const STARTUP_CORE_BACKUP_GUARD = new Set<string>();

/** Worker bridge: preserve the Rust process-wide once-per-directory guard across threads. */
export function startupBackupGuardKeys(): string[] { return [...STARTUP_CORE_BACKUP_GUARD]; }
export function rememberStartupBackupGuards(keys: readonly string[]): void {
  for (const key of keys) STARTUP_CORE_BACKUP_GUARD.add(key);
}

/** 测试辅助：等价 Rust 测试中手动从 guard 移除 key。 */
export function forgetStartupBackupGuard(key: string): void {
  STARTUP_CORE_BACKUP_GUARD.delete(key);
}

// ------------------------------------------------------------------ 公共工具

/** `get_current_version`：无 history 表为 0，否则 `MAX(version)`（NULL → 0）。 */
export function currentVersionOf(conn: Connection): number {
  try {
    const exists = conn.pluck<number>(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')",
    );
    if (exists !== 1) return 0;
    const version = conn.pluck<number | null>('SELECT MAX(version) FROM refinery_schema_history');
    return version ?? 0;
  } catch (error) {
    throw MigrationError.database(errorText(error), error);
  }
}

/** `Path::with_extension(ext)`（`x.db` → `x.<ext>`）。 */
function withExtension(file: string, ext: string): string {
  const parsed = path.parse(file);
  return path.join(parsed.dir, `${parsed.name}.${ext}`);
}

/** chrono `format("%Y%m%dT%H%M%S%.3fZ")`。 */
function snapshotTimestamp(now: Date): string {
  const rfc = toRfc3339Opts(BigInt(now.getTime()) * 1_000_000n, 'Millis');
  return (
    `${rfc.slice(0, 4)}${rfc.slice(5, 7)}${rfc.slice(8, 10)}` +
    `T${rfc.slice(11, 13)}${rfc.slice(14, 16)}${rfc.slice(17, 19)}.${rfc.slice(20, 23)}Z`
  );
}

function ioError(error: unknown): MigrationError {
  return error instanceof MigrationError ? error : MigrationError.io(error);
}

/** Rust `sort()` 按 OsStr 字节序；文件名均为 ASCII，按 UTF-16 码元比较一致。 */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `backup_sqlite_consistent`：SQLite 在线备份 src → dst，然后 `PRAGMA quick_check`；
 * 只有结构性违规（非 `ok`、非 `NULL value in ...`）才失败。
 */
export async function backupSqliteConsistent(src: string, dst: string, log: MigrationLog): Promise<void> {
  let srcConn: Connection;
  try {
    srcConn = new Connection(src, { label: 'backup-source', profile: PROFILES.plain });
  } catch (error) {
    throw MigrationError.database(`打开源数据库失败 ${src}: ${errorText(error)}`, error);
  }
  try {
    await srcConn.backupTo(dst);
  } catch (error) {
    throw MigrationError.database(`执行 SQLite backup 失败: ${errorText(error)}`, error);
  } finally {
    srcConn.close();
  }

  let dstConn: Connection;
  try {
    dstConn = new Connection(dst, { label: 'backup-destination', profile: PROFILES.plain });
  } catch (error) {
    throw MigrationError.database(`创建备份数据库失败 ${dst}: ${errorText(error)}`, error);
  }
  let findings: string[];
  try {
    findings = dstConn.all<{ quick_check: string }>('PRAGMA quick_check').map((row) => String(Object.values(row)[0]));
  } catch (error) {
    throw MigrationError.database(`备份完整性检查失败 ${dst}: ${errorText(error)}`, error);
  } finally {
    dstConn.close();
  }
  const structural = findings.filter((f) => f !== 'ok' && !f.startsWith('NULL value in '));
  if (structural.length > 0) {
    throw MigrationError.database(`备份完整性校验不通过 ${dst}: ${structural.join('; ')}`);
  }
  if (findings.some((f) => f !== 'ok')) {
    log('warn', `[MigrationCoordinator] 备份存在数据级约束违规（将由后续迁移修复） ${dst}: ${findings.join('; ')}`);
  }
}

// ------------------------------------------------------------------ 管理器

export interface CoreBackupManagerOptions {
  appDataDir: string;
  /** `get_database_path`。 */
  databasePath(id: CoordinatedDatabaseName): string;
  /** `pending_migrations_count`（读取失败抛错）。 */
  pendingMigrationsCount(): number;
  log: MigrationLog;
  /** 测试专用故障注入（Rust `#[cfg(test)] failpoint`）；生产不传，即空操作。 */
  failpoint?: (point: string) => void;
  /** 测试专用；缺省 `backup_common::get_available_disk_space`。 */
  availableDiskSpace?: (target: string) => number;
}

export class CoreBackupManager {
  private readonly appDataDir: string;
  private readonly log: MigrationLog;

  private readonly options: CoreBackupManagerOptions;
  /** 本次 run 建立的迁移前快照目录名；guard 已存在而跳过时为空。 */
  private runSnapshot: string | undefined;

  constructor(options: CoreBackupManagerOptions) {
    this.options = options;
    this.appDataDir = options.appDataDir;
    this.log = options.log;
  }

  private failpoint(point: string): void {
    this.options.failpoint?.(point);
  }

  /** 每次 `run_all` 开始时调用：上一次 run 的快照不代表这一次迁移前的状态。 */
  beginRun(): void {
    this.runSnapshot = undefined;
  }

  runSnapshotName(): string | undefined {
    return this.runSnapshot;
  }

  coreBackupRootDir(): string {
    return path.join(this.appDataDir, CORE_BACKUP_ROOT_DIR_NAME);
  }

  restoreFailureJournalPath(): string {
    return path.join(this.coreBackupRootDir(), RESTORE_FAILURE_JOURNAL_FILE);
  }

  restoreFailureJournalBackupPath(): string {
    return path.join(this.coreBackupRootDir(), 'restore-failures.json.bak');
  }

  /** `startup_guard_key`：canonicalize 失败时用原路径。 */
  startupGuardKey(): string {
    try {
      return fs.realpathSync(this.appDataDir);
    } catch {
      return this.appDataDir;
    }
  }

  /** `current_database_version_or_zero`：只读打开，任何失败返回 0。 */
  currentDatabaseVersionOrZero(id: CoordinatedDatabaseName): number {
    const file = this.options.databasePath(id);
    if (!fs.existsSync(file)) return 0;
    let conn: Connection | undefined;
    try {
      conn = new Connection(file, { label: id, profile: { ...PROFILES.plain, readonly: true } });
      return currentVersionOf(conn);
    } catch (error) {
      this.log('debug', `current_database_version_or_zero fallback to 0 for ${id}`, { error: errorText(error) });
      return 0;
    } finally {
      conn?.close();
    }
  }

  loadRestoreFailureJournal(): PersistentRestoreFailure[] {
    const primary = this.restoreFailureJournalPath();
    const backup = this.restoreFailureJournalBackupPath();
    let file: string;
    if (isFile(primary)) file = primary;
    else if (isFile(backup)) file = backup;
    else return [];
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw MigrationError.database(`无法读取单库恢复故障记录 ${file}: ${errorText(error)}`, error);
    }
    return parseJournal(content, file);
  }

  persistRestoreFailureJournal(failures: readonly PersistentRestoreFailure[]): void {
    const file = this.restoreFailureJournalPath();
    const backup = this.restoreFailureJournalBackupPath();
    if (failures.length === 0) {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch (error) {
          throw MigrationError.database(`清除单库恢复故障记录失败 ${file}: ${errorText(error)}`, error);
        }
      }
      if (fs.existsSync(backup)) {
        try {
          fs.unlinkSync(backup);
        } catch (error) {
          throw ioError(error);
        }
      }
      return;
    }
    const temp = withExtension(file, 'json.tmp');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(temp, 'w');
      try {
        fs.writeSync(fd, serializeJournal(failures));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (fs.existsSync(file)) {
        if (fs.existsSync(backup)) fs.unlinkSync(backup);
        fs.renameSync(file, backup);
      }
    } catch (error) {
      throw ioError(error);
    }
    try {
      fs.renameSync(temp, file);
    } catch (error) {
      if (fs.existsSync(backup)) {
        try {
          fs.renameSync(backup, file);
        } catch (rollbackError) {
          this.log('error', `恢复故障记录回滚失败 ${backup}: ${errorText(rollbackError)}`);
        }
      }
      throw ioError(error);
    }
    try {
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
    } catch (error) {
      throw ioError(error);
    }
  }

  /** `record_restore_failure`：同库旧记录被替换；`snapshot` 是这次恢复所用的可信快照。 */
  recordRestoreFailure(database: CoordinatedDatabaseName, migrationError: string, restoreError: string, snapshot?: string): void {
    const failures = this.loadRestoreFailureJournal().filter((f) => f.database !== database);
    failures.push({
      database,
      migration_error: migrationError,
      restore_error: restoreError,
      failed_at: chronoRfc3339Now(),
      ...(snapshot === undefined ? {} : { snapshot }),
    });
    this.persistRestoreFailureJournal(failures);
    this.log('warn', `[MigrationCoordinator] 已记录未完成的单库恢复，下次启动先重试: ${this.restoreFailureJournalPath()}`, {
      database,
      snapshot: snapshot ?? 'none',
    });
  }

  /** `retry_persisted_restore_failures`：全部恢复成功返回 undefined，否则返回阻断报告。 */
  async retryPersistedRestoreFailures(startedAtMs: number): Promise<CoreMigrationReport | undefined> {
    const failures = this.loadRestoreFailureJournal();
    if (failures.length === 0) return undefined;
    this.log('warn', '[MigrationCoordinator] 发现未完成的单库恢复，先重试可信快照恢复', { failures: failures.length });
    const remaining: PersistentRestoreFailure[] = [];
    for (const failure of failures) {
      try {
        const outcome = await this.restoreDatabaseFromLatestCoreBackup(failure.database, failure.snapshot);
        if (outcome.kind === 'untouched') {
          const missing =
            failure.snapshot === undefined
              ? 'No trusted snapshot is recorded for this failure'
              : `The recorded snapshot ${CORE_BACKUP_ROOT_DIR_NAME}/${failure.snapshot} no longer exists`;
          throw MigrationError.database(
            `${missing}; the database file was kept in place at ${outcome.path} (not deleted or overwritten)`,
          );
        }
        this.log('info', '[MigrationCoordinator] 持久化单库恢复重试成功', { database: failure.database, snapshot: outcome.snapshot });
      } catch (error) {
        this.log('error', '[MigrationCoordinator] 持久化单库恢复重试失败，保持阻断', { database: failure.database, error: errorText(error) });
        remaining.push({ ...failure, restore_error: errorText(error), failed_at: chronoRfc3339Now() });
      }
    }
    this.persistRestoreFailureJournal(remaining);
    if (remaining.length === 0) return undefined;

    const report = new CoreMigrationReport();
    const blocked = new Set(remaining.map((f) => f.database));
    for (const database of ALL_ORDERED) {
      const failure = remaining.find((f) => f.database === database);
      if (failure !== undefined) {
        const currentVersion = this.currentDatabaseVersionOrZero(database);
        const reason = `Database '${database}' remains blocked: migration failed (${failure.migration_error}); restoring the trusted startup snapshot failed again (${failure.restore_error})`;
        report.componentHealth.markBlocked(database, reason);
        report.add({ id: database, fromVersion: currentVersion, toVersion: currentVersion, appliedCount: 0, success: false, durationMs: 0, error: reason });
        continue;
      }
      const dependency = DATABASE_DEPENDENCIES[database].find((d) => blocked.has(d));
      if (dependency !== undefined) {
        const currentVersion = this.currentDatabaseVersionOrZero(database);
        const reason = `Skipped because dependency '${dependency}' has an unresolved restore failure`;
        report.componentHealth.markDependencyBlocked(database, dependency, reason);
        report.add({ id: database, fromVersion: currentVersion, toVersion: currentVersion, appliedCount: 0, success: false, durationMs: 0, error: reason });
      }
    }
    report.error = 'One or more databases could not be restored from the trusted startup snapshot';
    report.totalDurationMs = Date.now() - startedAtMs;
    return report;
  }

  /** `maybe_backup_core_databases_before_migration`。 */
  async maybeBackupCoreDatabasesBeforeMigration(): Promise<void> {
    let pending: number;
    try {
      pending = this.options.pendingMigrationsCount();
    } catch (error) {
      this.log('warn', '[MigrationCoordinator] 无法读取部分数据库版本；跳过新核心快照并继续逐库隔离迁移', {
        error: errorText(error),
        data_dir: this.appDataDir,
      });
      return;
    }
    if (pending === 0) {
      this.log('info', `[MigrationCoordinator] 当前无待执行迁移，跳过核心库快照备份: ${this.appDataDir}`);
      return;
    }
    await this.backupCoreDatabasesOncePerStartup();
  }

  /** `prune_old_core_backups`：按目录名排序，保留最新 5 个。 */
  pruneOldCoreBackups(): void {
    const root = this.coreBackupRootDir();
    if (!fs.existsSync(root)) return;
    let dirs: string[];
    try {
      dirs = fs
        .readdirSync(root)
        .map((name) => path.join(root, name))
        .filter((p) => isDir(p))
        .sort((a, b) => byteOrder(path.basename(a), path.basename(b)));
    } catch (error) {
      throw ioError(error);
    }
    if (dirs.length <= CORE_BACKUP_RETENTION_COUNT) return;
    for (const old of dirs.slice(0, dirs.length - CORE_BACKUP_RETENTION_COUNT)) {
      try {
        fs.rmSync(old, { recursive: true });
      } catch (error) {
        this.log('warn', `[MigrationCoordinator] 清理旧核心快照失败: ${old} (${errorText(error)})`);
      }
    }
  }

  private listStartupSnapshots(root: string): string[] {
    return fs
      .readdirSync(root)
      .filter((name) => name.startsWith('startup_') && isDir(path.join(root, name)))
      .sort(byteOrder)
      .map((name) => path.join(root, name));
  }

  /**
   * `restore_from_latest_core_backup`：返回恢复的库数量。不检查快照是否属于本次启动，
   * Rust 与本仓库都没有生产调用方；启动恢复必须走 `restoreDatabaseFromLatestCoreBackup`。
   */
  async restoreFromLatestCoreBackup(): Promise<number> {
    this.failpoint('before_restore');
    const root = this.coreBackupRootDir();
    if (!fs.existsSync(root)) {
      throw MigrationError.database('无迁移前快照可用于恢复（migration_core_backups 目录不存在）');
    }
    let snapshots: string[];
    try {
      snapshots = this.listStartupSnapshots(root);
    } catch (error) {
      throw ioError(error);
    }
    const latest = snapshots[snapshots.length - 1];
    if (latest === undefined) throw MigrationError.database('无迁移前快照目录可用于恢复');
    this.log('info', `[MigrationCoordinator] 尝试从快照恢复: ${latest}`);

    const metadataPath = path.join(latest, 'metadata.json');
    let copiedFiles: string[];
    if (fs.existsSync(metadataPath)) {
      let content: string;
      try {
        content = fs.readFileSync(metadataPath, 'utf8');
      } catch (error) {
        throw ioError(error);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        throw MigrationError.database(`解析快照元数据失败: ${errorText(error)}`, error);
      }
      const list = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).copied_files : undefined;
      copiedFiles = Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
    } else {
      this.log('warn', '[MigrationCoordinator] 快照缺少 metadata.json，回退到默认核心文件列表');
      copiedFiles = [...CORE_FILES];
    }
    if (copiedFiles.length === 0) throw MigrationError.database('快照元数据中无备份文件记录');

    let restored = 0;
    const errors: string[] = [];
    for (const relative of copiedFiles) {
      const src = path.join(latest, relative);
      const dst = path.join(this.appDataDir, relative);
      if (!fs.existsSync(src)) {
        this.log('warn', `[MigrationCoordinator] 快照文件不存在，跳过: ${src}`);
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
      } catch (error) {
        errors.push(`创建目录失败 ${path.dirname(dst)}: ${errorText(error)}`);
        continue;
      }
      try {
        await backupSqliteConsistent(src, dst, this.log);
      } catch (error) {
        const msg = `恢复 ${relative} 失败: ${errorText(error)}`;
        this.log('error', `[MigrationCoordinator] ${msg}`);
        errors.push(msg);
        continue;
      }
      for (const ext of ['db-wal', 'db-shm']) {
        const residual = withExtension(dst, ext);
        if (fs.existsSync(residual)) {
          try {
            fs.unlinkSync(residual);
          } catch (error) {
            this.log('warn', `[MigrationCoordinator] 清理残留文件失败 ${residual}: ${errorText(error)}`);
          }
        }
      }
      restored++;
      this.log('info', `[MigrationCoordinator] 已恢复: ${src} -> ${dst}`);
    }
    if (restored === 0) {
      throw MigrationError.database(`从快照恢复失败，无数据库成功恢复。错误: ${errors.join('; ')}`);
    }
    if (errors.length > 0) {
      this.log('warn', `[MigrationCoordinator] 部分数据库恢复失败（已恢复 ${restored}）`, { errors });
    }
    this.log('info', `[MigrationCoordinator] 从快照恢复完成: ${restored}/${copiedFiles.length} 个数据库`);
    this.failpoint('after_restore');
    return restored;
  }

  /**
   * `restore_database_from_latest_core_backup`：只恢复一个库；快照时不存在的库被删除。
   * 可信快照 = `recordedSnapshot`（恢复故障记录里保存的那次启动的快照），否则为本次 run 建立的快照。
   */
  async restoreDatabaseFromLatestCoreBackup(id: CoordinatedDatabaseName, recordedSnapshot?: string): Promise<SingleDatabaseRestore> {
    this.failpoint('before_restore');
    const root = this.coreBackupRootDir();
    const relative = CORE_RELATIVE_PATHS[id];
    const dst = this.options.databasePath(id);
    // RUST-FIX(RF-W20-restore-stale-snapshot-deletes-db): Rust 取最新快照，本次启动没建快照时会按更早启动的快照删除或覆盖现有数据库
    const trusted = recordedSnapshot ?? this.runSnapshot;
    if (trusted === undefined || !isDir(path.join(root, trusted))) {
      const olderSnapshot = this.newestSnapshotContaining(relative);
      this.log('warn', `[MigrationCoordinator] 没有本次迁移前建立的可信快照，未删除或覆盖数据库，原文件保留在原位置: ${dst}`, {
        database: id,
        recorded_snapshot: recordedSnapshot ?? 'none',
        newest_snapshot_with_database: olderSnapshot ?? 'none',
      });
      return { kind: 'untouched', path: dst, olderSnapshot };
    }
    const latest = path.join(root, trusted);

    const src = path.join(latest, relative);
    let outcome: SingleDatabaseRestore;
    if (isFile(src)) {
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
      } catch (error) {
        throw ioError(error);
      }
      await backupSqliteConsistent(src, dst, this.log);
      this.log('warn', `[MigrationCoordinator] 已用可信迁移前快照覆盖失败数据库: ${src} -> ${dst}`, { database: id });
      outcome = { kind: 'restored', snapshot: trusted };
    } else {
      const metadataPath = path.join(latest, 'metadata.json');
      let content: string;
      try {
        content = fs.readFileSync(metadataPath, 'utf8');
      } catch (error) {
        throw MigrationError.database(`快照缺少数据库 ${relative} 且无法读取元数据 ${metadataPath}: ${errorText(error)}`, error);
      }
      let metadata: unknown;
      try {
        metadata = JSON.parse(content);
      } catch (error) {
        throw MigrationError.database(`解析快照元数据失败: ${errorText(error)}`, error);
      }
      const copied = typeof metadata === 'object' && metadata !== null ? (metadata as Record<string, unknown>).copied_files : undefined;
      if (!Array.isArray(copied)) throw MigrationError.database('快照元数据缺少 copied_files');
      if (copied.some((v) => v === relative)) {
        throw MigrationError.database(`快照声明包含数据库但文件不存在: ${src}`);
      }
      if (fs.existsSync(dst)) {
        try {
          fs.unlinkSync(dst);
        } catch (error) {
          throw MigrationError.database(`删除迁移前不存在的失败数据库 ${dst} 失败: ${errorText(error)}`, error);
        }
        this.log('warn', `[MigrationCoordinator] 可信迁移前快照中没有该数据库（迁移前不存在），已删除失败迁移新建的文件: ${dst}`, {
          database: id,
          snapshot: latest,
        });
      }
      outcome = { kind: 'removed', snapshot: trusted };
    }
    for (const ext of ['db-wal', 'db-shm']) {
      const residual = withExtension(dst, ext);
      if (fs.existsSync(residual)) {
        try {
          fs.unlinkSync(residual);
        } catch (error) {
          throw MigrationError.database(`清理恢复后的残留文件 ${residual} 失败: ${errorText(error)}`, error);
        }
      }
    }
    this.failpoint('after_restore');
    this.log('info', '[MigrationCoordinator] 单数据库恢复完成', { database: id, snapshot: latest });
    return outcome;
  }

  /** 最新的、确实包含该库文件的 `startup_*` 快照目录名（只用于告知，不自动应用）。 */
  private newestSnapshotContaining(relative: string): string | null {
    let snapshots: string[];
    try {
      snapshots = this.listStartupSnapshots(this.coreBackupRootDir());
    } catch {
      return null;
    }
    const found = [...snapshots].reverse().find((dir) => isFile(path.join(dir, relative)));
    return found === undefined ? null : path.basename(found);
  }

  /** `backup_core_databases_once_per_startup`。 */
  async backupCoreDatabasesOncePerStartup(): Promise<void> {
    const key = this.startupGuardKey();
    if (STARTUP_CORE_BACKUP_GUARD.has(key)) {
      this.log('info', `[MigrationCoordinator] 已存在本次启动的核心库备份，跳过: ${this.appDataDir}`);
      return;
    }
    const snapshotDir = path.join(this.coreBackupRootDir(), `startup_${snapshotTimestamp(new Date())}_${process.pid}`);
    try {
      fs.mkdirSync(snapshotDir, { recursive: true });
    } catch (error) {
      throw ioError(error);
    }

    const copiedFiles: string[] = [];
    for (const relative of CORE_FILES) {
      const src = path.join(this.appDataDir, relative);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(snapshotDir, relative);
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
      } catch (error) {
        throw ioError(error);
      }
      await backupSqliteConsistent(src, dst, this.log);
      copiedFiles.push(relative);
    }

    // schema_versions：读不到的库被跳过（Rust `if let Ok(..)`）
    const schemaVersions: Record<string, number> = {};
    for (const relative of copiedFiles) {
      const dbPath = path.join(this.appDataDir, relative);
      let conn: Connection | undefined;
      try {
        conn = new Connection(dbPath, { label: relative, profile: PROFILES.plain });
        schemaVersions[path.parse(relative).name] = currentVersionOf(conn);
      } catch (error) {
        this.log('debug', `schema_versions skip ${relative}`, { error: errorText(error) });
      } finally {
        conn?.close();
      }
    }

    const metadata = {
      created_at: chronoRfc3339Now(),
      source_dir: this.appDataDir,
      copied_files: copiedFiles,
      schema_versions: schemaVersions,
      purpose: 'pre-migration core databases snapshot',
    };
    try {
      fs.writeFileSync(path.join(snapshotDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    } catch (error) {
      throw ioError(error);
    }
    this.log('info', `[MigrationCoordinator] 已完成迁移前核心库备份: ${snapshotDir}`);
    STARTUP_CORE_BACKUP_GUARD.add(key);
    this.runSnapshot = path.basename(snapshotDir);
    this.pruneOldCoreBackups();
  }

  /** `preflight_disk_space_check`：可用空间须 ≥ 数据库（含 WAL）总大小 × 2 + 50MB。 */
  preflightDiskSpaceCheck(): void {
    let total = 0;
    for (const id of ALL_ORDERED) {
      const file = this.options.databasePath(id);
      if (!fs.existsSync(file)) continue;
      total += statSize(file);
      const wal = withExtension(file, 'db-wal');
      if (fs.existsSync(wal)) total += statSize(wal);
    }
    const required = total * 2 + 50 * 1024 * 1024;
    // Rust `.unwrap_or(u64::MAX)`：取不到可用空间时放行
    let available: number;
    try {
      available = (this.options.availableDiskSpace ?? getAvailableDiskSpace)(this.appDataDir);
    } catch {
      available = Number.MAX_SAFE_INTEGER;
    }
    const requiredMb = Math.floor(required / (1024 * 1024));
    const availableMb = Math.floor(available / (1024 * 1024));
    if (available < required) {
      this.log('error', '磁盘空间不足，无法安全执行迁移', {
        available_mb: availableMb,
        required_mb: requiredMb,
        total_db_size_mb: Math.floor(total / (1024 * 1024)),
      });
      throw new MigrationError({ kind: 'InsufficientDiskSpace', availableMb, requiredMb });
    }
    this.log('debug', '磁盘空间预检查通过', { available_mb: availableMb, required_mb: requiredMb });
  }
}

function statSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
