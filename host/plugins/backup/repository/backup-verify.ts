import type { SqlExecutor } from '../../../platform/storage/api.ts';

/** `refinery_schema_history` 是否存在（备份时记录 schema_versions）。 */
export function hasRefineryHistory(db: SqlExecutor): boolean {
  return Number(db.pluck<number>(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')",
  )) === 1;
}

/** `SELECT MAX(version) FROM refinery_schema_history`；空表为 0。 */
export function maxRefineryVersion(db: SqlExecutor): number {
  return Number(db.pluck<number>('SELECT MAX(version) FROM refinery_schema_history') ?? 0);
}

/** `PRAGMA integrity_check` 的首列结果（Rust `query_row`）。 */
export function integrityCheck(db: SqlExecutor): string {
  return String(db.pluck<unknown>('PRAGMA integrity_check'));
}
