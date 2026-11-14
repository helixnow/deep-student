import type { SqlExecutor } from '../../../platform/storage/api.ts';

/** textbook_adapter.rs:60-66 deliberately uses query_row(...).unwrap_or(None). */
export function exportTextbookTextWithConn(conn: SqlExecutor, id: string): string | null {
  try {
    return conn.pluck<string | null>('SELECT extracted_text FROM files WHERE id = ?1', [id]) ?? null;
  } catch {
    return null;
  }
}
