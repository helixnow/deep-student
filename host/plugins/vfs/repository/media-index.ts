import type { SqlExecutor } from '../../../platform/storage/api.ts';

export function fileIdForResource(conn: SqlExecutor, id: string): string | null {
  return conn.pluck<string>('SELECT id FROM files WHERE resource_id = ?1 LIMIT 1', [id]) ?? null;
}
export function resourceIdForFile(conn: SqlExecutor, id: string): string | null {
  return conn.pluck<string | null>('SELECT resource_id FROM files WHERE id = ?1', [id]) ?? null;
}
