/**
 * 移动端迁移：与桌面同一份 refinery 实现（可移植核心 `host/platform/storage/migration/refinery-core.ts`）、
 * 同一份 SQL 文本（外壳按文件原文注入），因此 `refinery_schema_history` 的 version / name / checksum
 * 与桌面逐行相同。
 *
 * 桌面 `MigrationCoordinator.migrateDatabase` 对**新库**的有效步骤是：以 `plain` profile 开连接 →
 * `PRAGMA foreign_keys = ON` → `ensureRefineryHistoryTable`（决定 history 表的 DDL 文本）→ refinery
 * Runner（`grouped=false`、不中止 divergent/missing）→ 契约 verifier → schema 指纹 → 关闭。
 * 移动端复用前四步的桌面实现；schema 指纹（`fingerprint.ts`）要用桌面 `Connection`（better-sqlite3）
 * 开内存 scratch 库重放迁移，暂不在移动端执行，因此移动端库缺少 `__governance_schema_fingerprints` 表。
 * 旧库按首迁移契约接纳 baseline，并在事务内安全重放已有 ALTER 列，保留原 SQL checksum。
 * 校验之后与桌面一样对 mistakes 补 `pending_memory_candidates`（RF-W07-pending-memory-candidates-schema）：
 * 不写 refinery 历史，失败只记 warn，迁移照常成功。
 * 失败文本与桌面 `migrateOpened` 相同（`MigrationError` 的 Display）：Runner 失败为 `Refinery error: …`，
 * 契约校验为 `Verification failed for migration N: …`，history 查询与 PRAGMA 失败为 `Database error: …`。
 */
import type { CoordinatedDatabaseName, DatabaseMigrationReport } from '../storage/api.ts';
import type { MigrationDefSpec } from '../storage/migration/definitions.ts';
import { CHAT_V2_MIGRATIONS } from '../storage/migration/definitions/chat_v2.ts';
import { LLM_USAGE_MIGRATIONS } from '../storage/migration/definitions/llm_usage.ts';
import { MISTAKES_MIGRATIONS_LIST } from '../storage/migration/definitions/mistakes.ts';
import { VFS_MIGRATIONS } from '../storage/migration/definitions/vfs.ts';
import { MigrationError, errorText } from '../storage/migration/errors.ts';
import { RepairHelpers } from '../storage/migration/helpers.ts';
import { DEFAULT_MIGRATION_TABLE_NAME, Runner, migrationsFromSqlFiles, type Migration } from '../storage/migration/refinery-core.ts';
import { MigrationVerifier, type VerifierConnection } from '../storage/migration/verifier.ts';
import { ensurePendingMemoryCandidatesSchema } from '../storage/pending-memory-candidates-schema.ts';
import { parseAlterAddColumns, splitSqlStatements } from '../storage/migration/sql-text.ts';
import type { MobileConnection } from './connection.ts';

const CONTRACTS: Record<CoordinatedDatabaseName, readonly MigrationDefSpec[]> = {
  vfs: VFS_MIGRATIONS,
  chat_v2: CHAT_V2_MIGRATIONS,
  mistakes: MISTAKES_MIGRATIONS_LIST,
  llm_usage: LLM_USAGE_MIGRATIONS,
};

/** 桌面 `verifyMigrations` 的契约部分：对已应用的每个版本校验期望的表 / 列 / 索引 / 查询。 */
function verifyContracts(id: CoordinatedDatabaseName, conn: VerifierConnection, files: Readonly<Record<string, string>>, upTo: number): void {
  for (const spec of CONTRACTS[id]) {
    if (spec.refineryVersion > upTo) continue;
    const sql = files[spec.file.slice(spec.file.lastIndexOf('/') + 1)];
    if (sql === undefined) throw new Error(`${id}: migration file ${spec.file} is not bundled`);
    MigrationVerifier.verify(conn, {
      refineryVersion: spec.refineryVersion,
      name: spec.name,
      sql,
      expectedTables: spec.expectedTables ?? [],
      expectedColumns: spec.expectedColumns ?? [],
      expectedIndexes: spec.expectedIndexes ?? [],
      expectedQueries: spec.expectedQueries ?? [],
      idempotent: spec.idempotent ?? false,
    });
  }
}

/** = Rust `DatabaseId::all_ordered()`（桌面 coordinator 的迁移顺序）。 */
export const MOBILE_MIGRATION_ORDER: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];

/** `embed_migrations!` 等价：文件名 → `Migration`，筛选与按版本稳定排序同桌面 `loadSqlMigrations`（输入按文件名排序，结果与平台无关）。 */
export function migrationsFromSources(files: Readonly<Record<string, string>>): Migration[] {
  return migrationsFromSqlFiles(Object.keys(files).sort().map(name => ({ name, sql: files[name]! })));
}

/** 桌面 coordinator / helpers 的 `db()`：SQL 失败记为 `MigrationError.database`。 */
function db<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw MigrationError.database(errorText(error), error);
  }
}

function currentVersion(conn: MobileConnection): number {
  return db(() => {
    const exists = conn.pluck<number>(`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='${DEFAULT_MIGRATION_TABLE_NAME}')`) === 1;
    return exists ? (conn.pluck<number | null>(`SELECT MAX(version) FROM ${DEFAULT_MIGRATION_TABLE_NAME}`) ?? 0) : 0;
  });
}

function appliedCount(conn: MobileConnection): number {
  return db(() => {
    const exists = conn.pluck<number>(`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='${DEFAULT_MIGRATION_TABLE_NAME}')`) === 1;
    return exists ? (conn.pluck<number>(`SELECT COUNT(*) FROM ${DEFAULT_MIGRATION_TABLE_NAME}`) ?? 0) : 0;
  });
}

/** 失败报告里的版本与计数尽力读取；读不到时取迁移前的值，不让它盖掉原始错误。 */
function failureCounts(conn: MobileConnection, fromVersion: number, before: number): { toVersion: number; appliedCount: number } {
  try {
    return { toVersion: currentVersion(conn), appliedCount: Math.max(0, appliedCount(conn) - before) };
  } catch {
    return { toVersion: fromVersion, appliedCount: 0 };
  }
}

/** 在给定连接上把一个库迁移到最新版本。 */
export function migrateMobileDatabase(
  id: CoordinatedDatabaseName,
  conn: MobileConnection,
  files: Readonly<Record<string, string>>,
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
): DatabaseMigrationReport {
  const started = Date.now();
  const fromVersion = currentVersion(conn);
  const before = appliedCount(conn);
  try {
    try {
      conn.exec('PRAGMA foreign_keys = ON');
    } catch (error) {
      throw MigrationError.database(`启用外键约束失败: ${errorText(error)}`, error);
    }
    const helpers = new RepairHelpers(conn, (level, message) => log?.(level, message));
    helpers.ensureRefineryHistoryTable();
    const migrations = migrationsFromSources(files);
    const runner = new Runner(migrations, {
      grouped: false,
      abortDivergent: false,
      abortMissing: false,
      ...(log ? { log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => log(level, `[refinery] ${message}`) } : {}),
    });
    // Legacy 0.15 databases may have only plugin-specific history (or none).
    // Adopt the initial schema only if its actual contract is satisfied, as on desktop.
    const first = CONTRACTS[id][0];
    if (appliedCount(conn) === 0 && first !== undefined) {
      let baselineReady = false;
      try {
        verifyContracts(id, conn, files, first.refineryVersion);
        baselineReady = true;
      } catch (error) {
        if (!(error instanceof MigrationError)) throw error;
      }
      if (baselineReady) helpers.markMigrationComplete(runner, first.refineryVersion);
    }
    try {
      runner.run({
        all: (sql, params) => conn.all(sql, params),
        begin: behavior => conn.begin(behavior),
        commit: () => conn.commit(),
        rollback: () => conn.rollback(),
        exec: sql => {
          // A legacy migration can have only some columns present. Skip only the
          // existing ADDs, not the remaining columns, indexes or data backfills.
          // This runs inside Runner's SQL + history transaction and never changes
          // the migration object/checksum written to refinery_schema_history.
          if (parseAlterAddColumns(sql).length === 0) {
            conn.exec(sql);
            return;
          }
          for (const statement of splitSqlStatements(sql)) {
            const add = parseAlterAddColumns(statement)[0];
            if (add && helpers.columnExists(add[0], add[1])) continue;
            conn.exec(statement);
          }
        },
      });
    } catch (error) {
      throw new MigrationError({ kind: 'Refinery', detail: errorText(error) }, { cause: error });
    }
    verifyContracts(id, conn, files, currentVersion(conn));
  } catch (error) {
    return { id, fromVersion, ...failureCounts(conn, fromVersion, before), success: false, durationMs: Date.now() - started, error: errorText(error) };
  }
  if (id === 'mistakes') repairPendingMemoryCandidates(conn, log);
  return { id, fromVersion, toVersion: currentVersion(conn), appliedCount: Math.max(0, appliedCount(conn) - before), success: true, durationMs: Date.now() - started, error: null };
}

/** 同桌面 `MigrationCoordinator.repairPendingMemoryCandidates`（同一条日志文本）。 */
function repairPendingMemoryCandidates(conn: MobileConnection, log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void): void {
  try {
    const repair = ensurePendingMemoryCandidatesSchema(conn);
    if (repair !== 'none') log?.('info', `[Migration] pending_memory_candidates schema repaired: ${repair}`);
  } catch (error) {
    log?.('warn', `[Migration] pending_memory_candidates schema repair failed; memory candidates stay unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
