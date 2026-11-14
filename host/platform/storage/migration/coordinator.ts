/**
 * `dstu-storage/src/migration/coordinator.rs::MigrationCoordinator` 的主流程移植：
 * `run_all`、`check_dependencies`、`migrate_database`、`get_database_path`、`get_current_version`、
 * `get_migration_count`、`run_refinery_migrations`、`fix_malformed_migration_records`、
 * `make_alter_columns_safe`、`repair_refinery_checksums`、`verify_migrations`、`migrate_single`、
 * `needs_migration`、`pending_migrations_count`。
 *
 * 备份/恢复见 backup.ts，审计写入见 audit-log.ts，pre-repair 与兼容修复见 repairs.ts，
 * 指纹见 fingerprint.ts，验证契约见 definitions/ 与 verifier.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ConnectionProfile, CoordinatedDatabaseName } from '../api.ts';
import { Connection } from '../connection.ts';
import { PROFILES, diagnosticSandboxProfile } from '../profiles.ts';
import { logChecksumRepairAudit, logMigrationAudit, logMigrationFailure } from './audit-log.ts';
import {
  ALL_ORDERED,
  CORE_BACKUP_ROOT_DIR_NAME,
  CoreBackupManager,
  CoreMigrationReport,
  DATABASE_DEPENDENCIES,
  type DatabaseMigrationReportRecord,
  type SingleDatabaseRestore,
} from './backup.ts';
import type { MigrationSet } from './definitions.ts';
import { DEFAULT_MIGRATIONS_DIR, loadMigrationSets } from './definitions/index.ts';
import { MigrationError, errorText } from './errors.ts';
import { verifySchemaFingerprint } from './fingerprint.ts';
import { RepairHelpers, type MigrationLog } from './helpers.ts';
import { Runner, loadSqlMigrations, type Migration } from './refinery.ts';
import { cleanupIntermediateTables, ensureLegacyBaseline, preRepairSchema, repairRecordedMigrationSchemaGaps } from './repairs.ts';
import { extractColumnDef, parseAlterAddColumns } from './sql-text.ts';
import { isCharBoundary, utf8ByteLength } from '../../util/index.ts';
import { storageLog } from '../logging.ts';
import { ensurePendingMemoryCandidatesSchema } from '../pending-memory-candidates-schema.ts';
import { MigrationVerifier } from './verifier.ts';

/** `LEGACY_CHECKSUM_DRIFT_ALLOWLIST`。 */
export const LEGACY_CHECKSUM_DRIFT_ALLOWLIST: ReadonlyArray<readonly [CoordinatedDatabaseName, number]> = [['vfs', 20260714]];

/** `STARTUP_COMPAT_REPLAY_MAX_VERSION`。 */
export const STARTUP_COMPAT_REPLAY_MAX_VERSION = 20260801;

export interface MigrationCoordinatorOptions {
  /** 活动数据空间目录（Rust `app_data_dir`，即 `slots/slotX`）。 */
  appDataDir: string;
  /** 迁移 SQL 根目录（含 vfs/chat_v2/mistakes/llm_usage 子目录）。 */
  migrationsDir?: string;
  /** 审计库路径；`null` 关闭审计（= `with_audit_db(None)`）。默认 `<appDataDir>/databases/audit.db`。 */
  auditDbPath?: string | null;
  /** 附加的日志观察者；不传也会写入主日志（`storageLog`，target 为 {@link MIGRATION_LOG_TARGET}）。 */
  log?: MigrationLog;
  /** 测试专用故障注入（Rust `#[cfg(test)] failpoint`）。生产不传。 */
  failpoint?: (point: string) => void;
  /**
   * `appDataDir` 是迁移诊断的一次性测试槽（`slots/slotC|slotD`）时可设为 true：迁移用的连接改用
   * {@link diagnosticSandboxProfile}（不 fsync）。目录不是测试槽则构造时抛错。用户数据目录一律不设。
   */
  diagnosticSandbox?: boolean;
}

interface MigrationRunOutcome {
  appliedCount: number;
  schemaRepaired: boolean;
}

/** Rust `module_path!()` of `dstu-storage/src/migration/coordinator.rs`. */
export const MIGRATION_LOG_TARGET = 'dstu_storage::migration::coordinator';

/** tracing 字段的 `key=value` 追加格式。 */
function formatLogFields(message: string, fields?: Record<string, unknown>): string {
  if (fields === undefined) return message;
  const parts = Object.entries(fields).map(([key, value]) => {
    if (value !== null && typeof value === 'object') {
      try {
        return `${key}=${JSON.stringify(value)}`;
      } catch {
        return `${key}=${String(value)}`;
      }
    }
    return `${key}=${String(value)}`;
  });
  return parts.length === 0 ? message : `${message} ${parts.join(' ')}`;
}

/** 与 Rust tracing 一样总是写入主日志；`observer` 只是附加的观察者（测试捕获）。 */
function migrationLog(observer: MigrationLog | undefined): MigrationLog {
  return (level, message, fields) => {
    storageLog(MIGRATION_LOG_TARGET, level, formatLogFields(message, fields));
    observer?.(level, message, fields);
  };
}

function db<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw MigrationError.database(errorText(error), error);
  }
}

export class MigrationCoordinator {
  readonly appDataDir: string;
  readonly migrationsDir: string;
  readonly auditDbPath: string | undefined;
  readonly sets: Record<CoordinatedDatabaseName, MigrationSet>;
  private readonly log: MigrationLog;
  private readonly failpointHook: ((point: string) => void) | undefined;
  private readonly migrationCache = new Map<CoordinatedDatabaseName, readonly Migration[]>();
  readonly backups: CoreBackupManager;
  /** 迁移各库所用的连接设置：`PROFILES.plain`，诊断测试槽为 {@link diagnosticSandboxProfile}。 */
  readonly connectionProfile: ConnectionProfile;

  constructor(options: MigrationCoordinatorOptions) {
    this.appDataDir = options.appDataDir;
    this.connectionProfile = options.diagnosticSandbox === true ? diagnosticSandboxProfile(this.appDataDir) : PROFILES.plain;
    this.migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
    this.auditDbPath =
      options.auditDbPath === null ? undefined : (options.auditDbPath ?? path.join(this.appDataDir, 'databases', 'audit.db'));
    this.log = migrationLog(options.log);
    this.failpointHook = options.failpoint;
    this.sets = loadMigrationSets(this.migrationsDir);
    this.backups = new CoreBackupManager({
      appDataDir: this.appDataDir,
      databasePath: (id) => this.getDatabasePath(id),
      pendingMigrationsCount: () => this.pendingMigrationsCount(),
      log: this.log,
      failpoint: this.failpointHook,
    });
  }

  private failpoint(point: string): void {
    this.failpointHook?.(point);
  }

  // -------------------------------------------------------------- run_all

  /** `run_all`：按依赖顺序迁移；单库失败只恢复并阻断该库及其传递依赖。 */
  async runAll(): Promise<CoreMigrationReport> {
    const start = Date.now();
    const report = new CoreMigrationReport();
    this.log('info', `🚀 [MigrationCoordinator] 开始执行所有数据库迁移, 数据目录: ${this.appDataDir}`);

    this.backups.preflightDiskSpaceCheck();
    this.backups.beginRun();

    const persisted = await this.backups.retryPersistedRestoreFailures(start);
    if (persisted !== undefined) return persisted;

    await this.backups.maybeBackupCoreDatabasesBeforeMigration();
    this.failpoint('after_core_backup');

    for (const id of ALL_ORDERED) {
      try {
        this.checkDependencies(id, report);
      } catch (error) {
        const dependency =
          error instanceof MigrationError && error.detail.kind === 'DependencyNotSatisfied' ? error.detail.dependency : 'unknown';
        const reason = `Skipped because dependency '${dependency}' is blocked`;
        this.log('warn', `⚠️ [MigrationCoordinator] ${id} 依赖检查失败，跳过该组件: ${errorText(error)}`);
        report.componentHealth.markDependencyBlocked(id, dependency, reason);
        const current = this.backups.currentDatabaseVersionOrZero(id);
        report.add({ id, fromVersion: current, toVersion: current, appliedCount: 0, success: false, durationMs: 0, error: reason });
        continue;
      }

      const fromVersion = this.backups.currentDatabaseVersionOrZero(id);
      const migrationStarted = Date.now();
      try {
        const dbReport = this.migrateDatabase(id);
        this.log(
          'info',
          `✅ [MigrationCoordinator] ${id} 迁移完成: v${dbReport.fromVersion} -> v${dbReport.toVersion}, 应用了 ${dbReport.appliedCount} 个迁移`,
        );
        report.add(dbReport);
      } catch (error) {
        this.log('error', `❌ [MigrationCoordinator] ${id} 迁移失败`, { failed_db: id, error: errorText(error) });
        let failureReason: string;
        try {
          // RUST-FIX(RF-W20-restore-stale-snapshot-deletes-db): Rust 无论删除、覆盖还是什么都没做都写 "Restored this database from the startup snapshot."
          const outcome = await this.backups.restoreDatabaseFromLatestCoreBackup(id);
          failureReason = `Database '${id}' migration failed: ${errorText(error)}. ${describeSingleRestore(outcome)}`;
        } catch (restoreError) {
          this.log('error', '[MigrationCoordinator] 单库自动恢复失败', { failed_db: id, error: errorText(restoreError) });
          this.backups.recordRestoreFailure(id, errorText(error), errorText(restoreError), this.backups.runSnapshotName());
          failureReason = `Database '${id}' migration failed: ${errorText(error)}. Restoring this database also failed: ${errorText(restoreError)}`;
        }
        report.componentHealth.markBlocked(id, failureReason);
        report.error = report.error === null ? failureReason : `${report.error}; ${failureReason}`;
        report.add({
          id,
          fromVersion,
          toVersion: fromVersion,
          appliedCount: 0,
          success: false,
          durationMs: Date.now() - migrationStarted,
          error: failureReason,
        });
      }
    }

    report.totalDurationMs = Date.now() - start;
    this.log('info', `🏁 [MigrationCoordinator] 迁移完成, 总耗时: ${report.totalDurationMs}ms, 成功: ${report.success}`);
    return report;
  }

  /** `check_dependencies`。 */
  checkDependencies(id: CoordinatedDatabaseName, report: CoreMigrationReport): void {
    for (const dep of DATABASE_DEPENDENCIES[id]) {
      const depSuccess = report.databases.find((r) => r.id === dep)?.success ?? false;
      if (!depSuccess) {
        throw new MigrationError({ kind: 'DependencyNotSatisfied', database: id, dependency: dep });
      }
    }
  }

  // -------------------------------------------------------------- 单库

  /** `migrate_single`：不检查依赖。 */
  migrateSingle(id: CoordinatedDatabaseName): DatabaseMigrationReportRecord {
    return this.migrateDatabase(id);
  }

  /** `migrate_database`。 */
  private migrateDatabase(id: CoordinatedDatabaseName): DatabaseMigrationReportRecord {
    const start = Date.now();
    const dbPath = this.getDatabasePath(id);
    this.log('info', `📦 [Migration] 开始迁移数据库 ${id}: ${dbPath}`);
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    } catch (error) {
      throw MigrationError.io(error);
    }

    let conn: Connection;
    try {
      conn = new Connection(dbPath, { label: id, profile: this.connectionProfile });
    } catch (error) {
      const err = MigrationError.database(errorText(error), error);
      this.logFailure(id, 0, err.message, Date.now() - start);
      throw err;
    }
    try {
      return this.migrateOpened(id, conn, start);
    } finally {
      conn.close();
    }
  }

  private migrateOpened(id: CoordinatedDatabaseName, conn: Connection, start: number): DatabaseMigrationReportRecord {
    const h = new RepairHelpers(conn, this.log);
    try {
      conn.run('PRAGMA foreign_keys = ON');
    } catch (error) {
      throw MigrationError.database(`启用外键约束失败: ${errorText(error)}`, error);
    }
    const set = this.sets[id];

    const guarded = <T>(fromVersion: number, fn: () => T): T => {
      try {
        return fn();
      } catch (error) {
        this.logFailure(id, fromVersion, errorText(error), Date.now() - start);
        throw error;
      }
    };

    guarded(0, () => ensureLegacyBaseline({ h, id, set, migrationsDir: this.migrationsDir }));
    const fromVersion = guarded(0, () => this.getCurrentVersion(conn));
    guarded(fromVersion, () => this.fixMalformedMigrationRecords(conn));
    this.failpoint(`before_db_migration::${id}`);
    const outcome = guarded(fromVersion, () => this.runRefineryMigrations(conn, h, id));
    this.failpoint(`after_db_migration::${id}`);
    const toVersion = this.getCurrentVersion(conn);
    guarded(fromVersion, () => this.verifyMigrations(conn, id, set, toVersion, outcome.appliedCount, outcome.schemaRepaired));
    this.failpoint(`after_verification::${id}`);
    if (id === 'mistakes') this.repairPendingMemoryCandidates(conn);
    const durationMs = Date.now() - start;
    logMigrationAudit(this.auditDbPath, this.log, id, fromVersion, toVersion, outcome.appliedCount, durationMs);
    return { id, fromVersion, toVersion, appliedCount: outcome.appliedCount, success: true, durationMs, error: null };
  }

  /**
   * Call site of the RF-W07-pending-memory-candidates-schema repair (see pending-memory-candidates-schema.ts). It runs after
   * verification and stays outside refinery history and the fingerprint; if it fails the migration still succeeds and
   * the table stays as Rust would leave it.
   */
  private repairPendingMemoryCandidates(conn: Connection): void {
    try {
      const repair = ensurePendingMemoryCandidatesSchema(conn);
      if (repair !== 'none') this.log('info', `[Migration] pending_memory_candidates schema repaired: ${repair}`, { database: 'mistakes', repair });
    } catch (error) {
      this.log('warn', '[Migration] pending_memory_candidates schema repair failed; memory candidates stay unavailable', { database: 'mistakes', error: errorText(error) });
    }
  }

  private logFailure(id: CoordinatedDatabaseName, fromVersion: number, message: string, durationMs: number): void {
    logMigrationFailure(this.auditDbPath, this.log, id, fromVersion, message, durationMs);
  }

  /** `get_database_path`。 */
  getDatabasePath(id: CoordinatedDatabaseName): string {
    switch (id) {
      case 'vfs':
        return path.join(this.appDataDir, 'databases', 'vfs.db');
      case 'chat_v2':
        return path.join(this.appDataDir, 'chat_v2.db');
      case 'mistakes':
        return path.join(this.appDataDir, 'mistakes.db');
      case 'llm_usage':
        return path.join(this.appDataDir, 'llm_usage.db');
    }
  }

  /** `get_current_version`：history 最大版本；无表为 0。 */
  getCurrentVersion(conn: Connection): number {
    const exists = db(
      () => conn.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')") === 1,
    );
    if (!exists) return 0;
    const version = db(() => conn.pluck<number | null>('SELECT MAX(version) FROM refinery_schema_history'));
    return version ?? 0;
  }

  /** `get_migration_count`。 */
  private getMigrationCount(conn: Connection): number {
    const exists = db(
      () => conn.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')") === 1,
    );
    if (!exists) return 0;
    return db(() => conn.pluck<number>('SELECT COUNT(*) FROM refinery_schema_history') ?? 0);
  }

  /** 迁移文件（= `embed_migrations!`），按库缓存。 */
  private migrations(id: CoordinatedDatabaseName): readonly Migration[] {
    let list = this.migrationCache.get(id);
    if (list === undefined) {
      list = loadSqlMigrations(path.join(this.migrationsDir, id));
      this.migrationCache.set(id, list);
    }
    return list;
  }

  /** `create_*_runner` + `set_grouped(false).set_abort_divergent(false).set_abort_missing(false)`。 */
  createRunner(id: CoordinatedDatabaseName): Runner {
    return new Runner(this.migrations(id), {
      grouped: false,
      abortDivergent: false,
      abortMissing: false,
      log: (level, message) => this.log(level === 'error' ? 'error' : level, `[refinery] ${message}`),
    });
  }

  /** `run_refinery_migrations`。 */
  private runRefineryMigrations(conn: Connection, h: RepairHelpers, id: CoordinatedDatabaseName): MigrationRunOutcome {
    const before = this.getMigrationCount(conn);
    const runner = this.createRunner(id);
    const set = this.sets[id];
    const ctx = { h, id, runner, set, migrationsDir: this.migrationsDir };
    cleanupIntermediateTables(ctx);
    preRepairSchema(ctx);
    const schemaRepaired = repairRecordedMigrationSchemaGaps(ctx);
    this.repairRefineryChecksums(conn, id, runner);
    this.makeAlterColumnsSafe(h, runner);
    try {
      runner.run(conn);
    } catch (error) {
      throw new MigrationError({ kind: 'Refinery', detail: errorText(error) }, { cause: error });
    }
    const after = this.getMigrationCount(conn);
    const appliedCount = Math.max(0, after - before);
    this.log('info', 'Migration completed', { database: id, to_version: this.getCurrentVersion(conn), applied_count: appliedCount });
    return { appliedCount, schemaRepaired };
  }

  /** `fix_malformed_migration_records`：删除 checksum/version 明显无效的记录（失败按 0 处理）。 */
  private fixMalformedMigrationRecords(conn: Connection): void {
    let exists = false;
    try {
      exists = conn.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')") === 1;
    } catch (error) {
      this.log('debug', 'fix_malformed_migration_records: history probe failed', { error: errorText(error) });
    }
    if (!exists) return;
    let deleted = 0;
    try {
      deleted = conn.run(
        `DELETE FROM refinery_schema_history WHERE
             checksum IS NULL OR checksum = '' OR
             version IS NULL OR version = 0`,
      ).changes;
    } catch (error) {
      this.log('warn', 'fix_malformed_migration_records: delete failed', { error: errorText(error) });
    }
    if (deleted > 0) this.log('info', '删除了无效的迁移记录', { deleted_count: deleted });
  }

  /** `make_alter_columns_safe`。 */
  private makeAlterColumnsSafe(h: RepairHelpers, runner: Runner): void {
    h.ensureRefineryHistoryTable();
    for (const migration of runner.getMigrations()) {
      const version = migration.version;
      if (h.isMigrationRecorded(version)) continue;
      if (version > STARTUP_COMPAT_REPLAY_MAX_VERSION) {
        this.log('debug', '跳过启动时兼容重放：迁移版本超出兼容边界，交由 Refinery 正常执行', {
          version,
          boundary: STARTUP_COMPAT_REPLAY_MAX_VERSION,
        });
        continue;
      }
      const sql = migration.sql ?? '';
      const alterColumns = parseAlterAddColumns(sql);
      if (alterColumns.length === 0) continue;
      let allExist = true;
      let anyExist = false;
      for (const [table, column] of alterColumns) {
        if (h.tableExists(table) && h.columnExists(table, column)) anyExist = true;
        else allExist = false;
      }
      if (allExist) {
        this.log('info', `🔧 [make_alter_columns_safe] 检测到所有 ALTER 列已存在，重放剩余 SQL 后标记 V${version}`, {
          version,
          columns: alterColumns,
        });
        h.replayMigrationWithoutAlterAddColumns(sql, version);
        h.markMigrationComplete(runner, version);
      } else if (anyExist) {
        this.log('info', `🔧 [make_alter_columns_safe] 检测到部分 ALTER 列已存在（中间状态），补齐并标记 V${version}`, {
          version,
          columns: alterColumns,
        });
        for (const [table, column] of alterColumns) {
          h.addColumnIfMissing(table, column, extractColumnDef(sql, table, column));
        }
        h.replayMigrationWithoutAlterAddColumns(sql, version);
        h.markMigrationComplete(runner, version);
      }
    }
  }

  /** `repair_refinery_checksums`：只允许 baseline 对齐与经契约验证的同名漂移，其余 fail-close。 */
  private repairRefineryChecksums(conn: Connection, id: CoordinatedDatabaseName, runner: Runner): void {
    let exists = false;
    try {
      exists = conn.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')") === 1;
    } catch (error) {
      this.log('debug', 'repair_refinery_checksums: history probe failed', { error: errorText(error) });
    }
    if (!exists) return;
    const REPAIR_WARN_THRESHOLD = 5;
    const details: string[] = [];
    for (const migration of runner.getMigrations()) {
      const version = migration.version;
      const name = migration.name;
      const checksum = migration.checksum.toString();
      const existing = db(() =>
        conn.get<{ name: string; checksum: string }>('SELECT name, checksum FROM refinery_schema_history WHERE version = ?1', [version]),
      );
      if (existing === undefined) continue;
      if (typeof existing.name !== 'string' || typeof existing.checksum !== 'string') {
        throw MigrationError.database(`Invalid column type at index: ${typeof existing.name !== 'string' ? 0 : 1}`);
      }
      if (existing.checksum === checksum && existing.name === name) continue;
      const isBaseline = existing.checksum === '0';
      const isSameName = existing.name === name;
      if (!isBaseline && !isSameName) {
        throw MigrationError.database(
          `refinery 迁移历史 V${version} 名称不匹配（记录 '${existing.name}'，期望 '${name}'，记录 checksum '${existing.checksum}'）。未知漂移 fail-close：请人工核对 ${id} 库的 refinery_schema_history 后再升级`,
        );
      }
      let reason = 'baseline_alignment';
      if (!isBaseline) {
        const definition = this.sets[id].get(version);
        if (definition === undefined) {
          throw MigrationError.database(`V${version} 缺少迁移契约定义，无法验证收敛，拒绝对齐 checksum`);
        }
        try {
          MigrationVerifier.verify(conn, definition);
        } catch (verifyError) {
          this.log('warn', '同名 checksum 漂移的 schema 收敛验证未通过，fail-close 中止迁移', {
            database: id,
            version,
            error: errorText(verifyError),
          });
          throw new MigrationError({ kind: 'ChecksumMismatch', version, expected: checksum, actual: existing.checksum });
        }
        reason = LEGACY_CHECKSUM_DRIFT_ALLOWLIST.some(([d, v]) => d === id && v === version)
          ? 'allowlisted_legacy_drift'
          : 'verified_schema_convergence';
      }
      db(() => conn.run('UPDATE refinery_schema_history SET name = ?1, checksum = ?2 WHERE version = ?3', [name, checksum, version]));
      details.push(
        `v${version}: name '${existing.name}'->'${name}', checksum '${prefixBytes(existing.checksum, 8)}..'->'${prefixBytes(checksum, 8)}..', reason=${reason}`,
      );
    }
    if (details.length > 0) {
      if (details.length > REPAIR_WARN_THRESHOLD) {
        this.log('warn', '⚠️ Checksum repair count exceeds safety threshold — review migration scripts', {
          database: id,
          repaired: details.length,
          threshold: REPAIR_WARN_THRESHOLD,
        });
      }
      this.log('info', 'Refinery checksum records reconciled', { database: id, repaired: details.length, details });
      logChecksumRepairAudit(this.auditDbPath, this.log, id, details);
    }
  }

  /** `verify_migrations`。 */
  private verifyMigrations(
    conn: Connection,
    id: CoordinatedDatabaseName,
    set: MigrationSet,
    currentVersion: number,
    appliedCount: number,
    schemaRepaired: boolean,
  ): void {
    for (const migration of set.migrations) {
      if (migration.refineryVersion <= currentVersion) MigrationVerifier.verify(conn, migration);
    }
    const allowRebaseline = schemaRepaired || (appliedCount > 0 && (set.get(currentVersion)?.idempotent ?? false));
    verifySchemaFingerprint(conn, id, set, currentVersion, allowRebaseline, this.log);
    this.log('debug', 'Migration verification passed', { database: set.databaseName, version: currentVersion });
  }

  // -------------------------------------------------------------- 查询

  /** `needs_migration`：库不存在即需要。 */
  needsMigration(id: CoordinatedDatabaseName): boolean {
    const dbPath = this.getDatabasePath(id);
    if (!fs.existsSync(dbPath)) return true;
    const conn = db(() => new Connection(dbPath, { label: id, profile: this.connectionProfile }));
    try {
      return this.getCurrentVersion(conn) < this.sets[id].latestVersion();
    } finally {
      conn.close();
    }
  }

  /** `pending_migrations_count`。 */
  pendingMigrationsCount(): number {
    let total = 0;
    for (const id of ALL_ORDERED) {
      const dbPath = this.getDatabasePath(id);
      let current = 0;
      if (fs.existsSync(dbPath)) {
        const conn = db(() => new Connection(dbPath, { label: id, profile: this.connectionProfile }));
        try {
          current = this.getCurrentVersion(conn);
        } finally {
          conn.close();
        }
      }
      total += this.sets[id].pending(current).length;
    }
    return total;
  }
}

/** `run_all` 单库失败原因的后半句：如实写出恢复做了什么（用了哪个快照、删了什么、什么都没动）。 */
function describeSingleRestore(outcome: SingleDatabaseRestore): string {
  switch (outcome.kind) {
    case 'restored':
      return `Restored this database from the startup snapshot ${CORE_BACKUP_ROOT_DIR_NAME}/${outcome.snapshot}.`;
    case 'removed':
      return `The startup snapshot ${CORE_BACKUP_ROOT_DIR_NAME}/${outcome.snapshot} shows this database did not exist before the migration; removed the file created by the failed migration.`;
    case 'untouched':
      return (
        `No snapshot was taken before this migration run, so nothing was restored; the database file was kept in place at ${outcome.path} (not deleted or overwritten). ` +
        (outcome.olderSnapshot === null
          ? 'No earlier snapshot contains this database.'
          : `The newest earlier snapshot containing it, ${CORE_BACKUP_ROOT_DIR_NAME}/${outcome.olderSnapshot}, was not applied automatically.`)
      );
  }
}

/** Rust `s.get(..n).unwrap_or(s)`：按 UTF-8 字节取前缀，非字符边界时返回原串。 */
function prefixBytes(s: string, n: number): string {
  if (utf8ByteLength(s) <= n) return s;
  return isCharBoundary(s, n) ? Buffer.from(s, 'utf8').subarray(0, n).toString('utf8') : s;
}
