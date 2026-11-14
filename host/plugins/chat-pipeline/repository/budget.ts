/**
 * chat_v2/budget.rs — SQLite persistence for tree budget snapshots and the
 * main-DB settings read. SQL stays in this repository module; ledger semantics
 * live in `src/budget.ts`.
 */
import type { SqlExecutor, StorageService, DatabaseHandle } from '../../../platform/storage/api.ts';
import { dirname } from '../../../platform/util/path.ts';
import { chatPipelineLocalFs } from '../src/local-fs.ts';

/** Logging surface required by the settings read path (Rust warns and falls back). */
export interface BudgetRepositoryLog {
  warn(message: string): void;
}

let repositoryLog: BudgetRepositoryLog = { warn() {} };

export function configureBudgetRepositoryLog(log: BudgetRepositoryLog): void {
  repositoryLog = log;
}

export const BUDGET_SNAPSHOTS_TABLE = 'budget_snapshots';

export const SETTING_BUDGET_MAX_TOOL_CALLS = 'headless_budget_max_tool_calls';
export const SETTING_BUDGET_MAX_TOKENS = 'headless_budget_max_tokens';
export const SETTING_BUDGET_MAX_WALL_CLOCK_SECS = 'headless_budget_wall_clock_secs';

export interface BudgetSnapshotRow {
  root_id: string;
  limits_json: string;
  usage_json: string;
}

export function budgetSnapshotsTableExists(db: SqlExecutor): boolean {
  try {
    const rows = db.all<{ present: number }>(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='budget_snapshots') AS present",
    );
    return (rows[0]?.present ?? 0) === 1;
  } catch {
    // Rust `query_row(...).unwrap_or(0) == 1`: any probe failure means "absent".
    return false;
  }
}

/** Upsert one tree snapshot; `updated_at` is an RFC3339 timestamp. */
export function upsertBudgetSnapshotWithConn(db: SqlExecutor, rootId: string,
  limitsJson: string, usageJson: string, updatedAt: string): void {
  db.run(
    `INSERT INTO ${BUDGET_SNAPSHOTS_TABLE} (root_id, limits_json, usage_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(root_id) DO UPDATE SET
       limits_json = excluded.limits_json,
       usage_json = excluded.usage_json,
       updated_at = excluded.updated_at`,
    [rootId, limitsJson, usageJson, updatedAt],
  );
}

export function selectBudgetSnapshotsWithConn(db: SqlExecutor): BudgetSnapshotRow[] {
  return db.all<BudgetSnapshotRow>(
    `SELECT root_id, limits_json, usage_json FROM ${BUDGET_SNAPSHOTS_TABLE}`,
  );
}

/**
 * Single settings lookup from the main DB. Missing table/key or any read error
 * yields null (the parser layer then falls back to built-in defaults).
 */
export function readSettingWithConn(db: SqlExecutor, key: string): string | null {
  try {
    const rows = db.all<{ value: string | null }>(
      'SELECT value FROM settings WHERE key = ?', [key],
    );
    const value = rows[0]?.value;
    return typeof value === 'string' ? value : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    repositoryLog.warn(`[Budget] 读取 settings key '${key}' 失败，回退默认: ${message}`);
    return null;
  }
}

/** budget.rs:573 — independent short connection, matching Connection::open (create if missing). */
export function readSettingFromMainDb(storage: Pick<StorageService, 'openFile' | 'close'>,
  path: string, key: string): string | null {
  let conn: DatabaseHandle;
  try {
    // F3 openFile creates parents; rusqlite Connection::open only creates the database file.
    if (!chatPipelineLocalFs().isDirectory(dirname(path))) throw new Error(`unable to open database file: ${path}`);
    conn = storage.openFile(path, { profile: { busyTimeoutMs: 2000 } });
  }
  catch (error) {
    repositoryLog.warn(`[Budget] 打开主库 settings 失败（${path}），key '${key}' 回退默认: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  try { return readSettingWithConn(conn, key); }
  finally { storage.close(conn); }
}
