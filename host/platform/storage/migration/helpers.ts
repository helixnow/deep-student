/**
 * 迁移协调器在 pre-repair / 兼容修复中共用的小工具，逐个对应 coordinator.rs 中的同名方法：
 * `column_exists`、`table_exists`、`index_exists`、`trigger_exists`、`add_column_if_missing`、
 * `ensure_refinery_history_table`、`is_migration_recorded`、`mark_migration_complete`、
 * `replay_migration_without_alter_add_columns`、`ensure_change_log_table`。
 */
import type { RunResult, SqlParams, SqlValue } from '../api.ts';
import type { Connection } from '../connection.ts';
import { MigrationError, errorText } from './errors.ts';
import { chronoRfc3339Now, type Runner } from './refinery-core.ts';
import { sqlWithoutAlterAddColumns, rustTrim } from './sql-text.ts';
import type { VerifierConnection } from './verifier.ts';

/** 修复工具与修复步骤实际用到的连接能力；桌面 `Connection` 与移动端 `MobileConnection` 都满足。 */
export interface RepairConnection extends VerifierConnection {
  run(sql: string, params?: SqlParams): RunResult;
  exec(sql: string): void;
  pragmaValue(pragma: string): SqlValue;
}

export type MigrationLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;

function db<T>(fn: () => T, wrap?: (msg: string) => string): T {
  try {
    return fn();
  } catch (error) {
    throw MigrationError.database(wrap === undefined ? errorText(error) : wrap(errorText(error)), error);
  }
}

export class RepairHelpers<C extends RepairConnection = Connection> {
  readonly conn: C;
  readonly log: MigrationLog;

  constructor(
    conn: C,
    log: MigrationLog,
  ) {
    this.conn = conn;
    this.log = log;
  }

  /** `SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name = ?2`。 */
  columnExists(table: string, column: string): boolean {
    return db(() => this.conn.pluck<number>('SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name = ?2', [table, column]) === 1);
  }

  tableExists(table: string): boolean {
    return db(() => this.conn.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table]) === 1);
  }

  indexExists(index: string): boolean {
    return db(() => this.conn.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)", [index]) === 1);
  }

  triggerExists(trigger: string): boolean {
    return db(
      () => this.conn.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?1)", [trigger]) === 1,
    );
  }

  /** `add_column_if_missing`：表不存在或列已存在返回 false。 */
  addColumnIfMissing(table: string, column: string, definition: string): boolean {
    if (!this.tableExists(table)) return false;
    if (this.columnExists(table, column)) return false;
    db(
      () => this.conn.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`),
      (e) => `为 ${table} 添加 ${column} 列失败: ${e}`,
    );
    return true;
  }

  ensureRefineryHistoryTable(): void {
    if (this.tableExists('refinery_schema_history')) return;
    db(() =>
      this.conn.run(
        `CREATE TABLE IF NOT EXISTS refinery_schema_history (
                version INTEGER PRIMARY KEY,
                name TEXT,
                applied_on TEXT,
                checksum TEXT
            )`,
      ),
    );
  }

  /** `is_migration_recorded`：查询失败（如表不存在）按 false 处理（Rust `unwrap_or(false)`）。 */
  isMigrationRecorded(version: number): boolean {
    try {
      return this.conn.pluck<number>('SELECT EXISTS(SELECT 1 FROM refinery_schema_history WHERE version = ?1)', [version]) === 1;
    } catch (error) {
      this.log('debug', 'is_migration_recorded query failed; treating as not recorded', { version, error: errorText(error) });
      return false;
    }
  }

  /** `mark_migration_complete`：按 runner 中该版本的 name/checksum 写入 history（INSERT OR IGNORE）。 */
  markMigrationComplete(runner: Runner, version: number): void {
    const migration = runner.getMigrations().find((m) => m.version === version);
    if (migration === undefined) {
      this.log('warn', `⚠️ [PreRepair] 未找到版本 ${version} 的迁移定义，跳过标记`);
      return;
    }
    db(
      () =>
        this.conn.run(
          `INSERT OR IGNORE INTO refinery_schema_history (version, name, applied_on, checksum)
                     VALUES (?1, ?2, ?3, ?4)`,
          [version, migration.name, chronoRfc3339Now(), migration.checksum.toString()],
        ),
      (e) => `标记迁移 V${version} 为已完成失败: ${e}`,
    );
    this.log('info', `✅ [PreRepair] 已标记迁移 V${version}_${migration.name} 为已完成`);
  }

  /** `replay_migration_without_alter_add_columns`。 */
  replayMigrationWithoutAlterAddColumns(sql: string, version: number): void {
    const replay = sqlWithoutAlterAddColumns(sql);
    if (rustTrim(replay).length === 0) return;
    db(
      () => this.conn.exec(replay),
      (e) => `恢复未记录迁移 V${version} 的非 ALTER SQL 失败: ${e}`,
    );
  }

  /** `ensure_change_log_table`。 */
  ensureChangeLogTable(dbName: string, changeLogSql: string, coreTable: string): void {
    const CHANGE_LOG_VERSION = 20260131;
    if (this.isMigrationRecorded(CHANGE_LOG_VERSION) && !this.tableExists('__change_log')) {
      this.log('info', `🔧 [PreRepair] ${dbName}: V${CHANGE_LOG_VERSION} 已记录但 __change_log 表不存在，重新执行幂等 SQL`);
      db(
        () => this.conn.exec(changeLogSql),
        (e) => `重新执行 ${dbName} V20260131 SQL 失败: ${e}`,
      );
    }
    if (this.tableExists(coreTable) && !this.tableExists('__change_log')) {
      this.log('info', `🔧 [PreRepair] ${dbName}: 核心表存在但 __change_log 缺失，补齐`);
      db(
        () => this.conn.exec(changeLogSql),
        (e) => `补齐 ${dbName} __change_log 表失败: ${e}`,
      );
    }
  }

  /** `conn.execute(sql, [])` 包装成 `MigrationError::Database`（可选自定义文案）。 */
  execute(sql: string, wrap?: (e: string) => string): void {
    db(() => this.conn.run(sql), wrap);
  }

  /** `conn.execute_batch(sql)` 包装。 */
  executeBatch(sql: string, wrap?: (e: string) => string): void {
    db(() => this.conn.exec(sql), wrap);
  }

  /** `PRAGMA foreign_keys` 当前值（读取失败按 0，Rust `unwrap_or(0)`）。 */
  foreignKeysValue(): number {
    try {
      return Number(this.conn.pragmaValue('foreign_keys'));
    } catch (error) {
      this.log('debug', 'PRAGMA foreign_keys read failed; treating as 0', { error: errorText(error) });
      return 0;
    }
  }
}
