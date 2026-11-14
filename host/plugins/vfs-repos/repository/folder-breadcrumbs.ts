/**
 * dstu/folder_handlers.rs:911-975 `dstu_folder_get_breadcrumbs` query body (root → leaf, depth < 11).
 * The command keeps its entry log and get_conn handling; this owner read keeps the per-stage
 * error texts and logs, mapped from F3 `StorageError.phase`.
 */
import { StorageError, type SqlExecutor, type SqlValue } from '../../../platform/storage/api.ts';
import type { VfsBreadcrumbItem } from '../api.ts';
import { logError, logInfo } from './logger.ts';

const BREADCRUMBS_SQL = `
  WITH RECURSIVE folder_path AS (
      SELECT id, parent_id, title, 1 as depth
      FROM folders WHERE id = ?1
      UNION ALL
      SELECT f.id, f.parent_id, f.title, fp.depth + 1
      FROM folders f JOIN folder_path fp ON f.id = fp.parent_id
      WHERE fp.depth < 11
  )
  SELECT id, title FROM folder_path ORDER BY depth DESC`;

const TAG = '[DSTU::folder_handlers] dstu_folder_get_breadcrumbs';

function sqlKind(value: SqlValue | undefined): string {
  if (value === null || value === undefined) return 'Null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Real';
  if (typeof value === 'bigint') return 'Integer';
  return 'Blob';
}

/** rusqlite `row.get::<String>` on a non-TEXT column. */
function readString(row: Record<string, SqlValue>, name: string, index: number): string {
  const value = row[name];
  if (typeof value === 'string') return value;
  throw new Error(`Invalid column type ${sqlKind(value)} at index: ${index}, name: ${name}`);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Errors are plain `Error`s whose message is the exact Rust command `Err(String)`. */
export function getBreadcrumbs(conn: SqlExecutor, folderId: string): VfsBreadcrumbItem[] {
  const breadcrumbs: VfsBreadcrumbItem[] = [];
  try {
    // F3 iterate is lazy: prepare/bind/step all surface from the loop, tagged by `phase`.
    for (const row of conn.iterate<Record<string, SqlValue>>(BREADCRUMBS_SQL, [folderId])) {
      breadcrumbs.push({ id: readString(row, 'id', 0), name: readString(row, 'title', 1) });
    }
  } catch (error) {
    const phase = error instanceof StorageError ? error.phase : undefined;
    if (phase === 'prepare') {
      logError(`${TAG}: prepare FAILED - folder_id=${folderId}, error=${messageOf(error)}`);
      throw new Error('数据库查询失败');
    }
    // rusqlite: `query_map(..).map_err(..)?` returns before the FAILED log.
    if (phase === 'bind') throw new Error(`Query failed: ${messageOf(error)}`);
    const message = `Collect failed: ${messageOf(error)}`;
    logError(`${TAG}: FAILED - folder_id=${folderId}, error=${message}`);
    throw new Error(message);
  }
  logInfo(`${TAG}: SUCCESS - folder_id=${folderId}, count=${breadcrumbs.length}`);
  return breadcrumbs;
}
