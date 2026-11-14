/**
 * Read-only queries used by the DSTU trash commands.
 * Rust: dstu/trash_handlers.rs helpers (`lookup_resource_id`,
 * `collect_column_strings`, asset/folder-tree preflights).
 *
 * These are SELECTs only; every mutation is delegated to the owning lane.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

/** `lookup_resource_id` (trash_handlers.rs:30-50). */
export function lookupResourceIdWithConn(
  conn: SqlExecutor,
  itemType: string,
  itemId: string,
): string | undefined {
  let sql: string | undefined;
  switch (itemType) {
    case 'note': sql = 'SELECT resource_id FROM notes WHERE id = ?1'; break;
    case 'textbook':
    case 'image':
    case 'file': sql = 'SELECT resource_id FROM files WHERE id = ?1'; break;
    case 'exam': sql = 'SELECT resource_id FROM exam_sheets WHERE id = ?1'; break;
    case 'translation': sql = 'SELECT resource_id FROM translations WHERE id = ?1'; break;
    case 'essay':
      if (itemId.startsWith('essay_session_')) return undefined;
      sql = 'SELECT resource_id FROM essays WHERE id = ?1';
      break;
    case 'mindmap': sql = 'SELECT resource_id FROM mindmaps WHERE id = ?1'; break;
    default: return undefined;
  }
  const value = conn.pluck<string | null>(sql, [itemId]);
  return typeof value === 'string' ? value : undefined;
}

/**
 * `dstu_delete` pre-delete resource_id lookup (handlers.rs:1707-1727). Any
 * connection/query failure or missing row yields undefined (`.ok().flatten()`).
 * Essays and folders are intentionally absent, matching the Rust match.
 */
export function lookupDeleteResourceIdWithConn(
  conn: SqlExecutor,
  resourceType: string,
  id: string,
): string | undefined {
  let sql: string | undefined;
  switch (resourceType) {
    case 'notes': case 'note': sql = 'SELECT resource_id FROM notes WHERE id = ?1'; break;
    case 'textbooks': case 'textbook': case 'images': case 'image':
    case 'files': case 'file': case 'attachments': case 'attachment':
      sql = 'SELECT resource_id FROM files WHERE id = ?1'; break;
    case 'exams': case 'exam': sql = 'SELECT resource_id FROM exam_sheets WHERE id = ?1'; break;
    case 'translations': case 'translation': sql = 'SELECT resource_id FROM translations WHERE id = ?1'; break;
    case 'mindmaps': case 'mindmap': sql = 'SELECT resource_id FROM mindmaps WHERE id = ?1'; break;
    default: return undefined;
  }
  try {
    const value = conn.pluck<string | null>(sql, [id]);
    return typeof value === 'string' ? value : undefined;
  } catch { // boundary-allow empty-catch: Rust `.query_row(..).ok().flatten()` discards lookup errors
    return undefined;
  }
}

/** `purge_resource_by_type_if_trashed` trash predicate (delete_helpers.rs:252-281). */
export function isTrashedWithConn(
  conn: SqlExecutor,
  resourceType: string,
  id: string,
): boolean | undefined {
  switch (resourceType) {
    case 'notes':
    case 'note':
      return conn.pluck<number>(
        'SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL', [id]) !== undefined;
    case 'textbooks':
    case 'textbook':
    case 'images':
    case 'image':
    case 'files':
    case 'file':
    case 'attachments':
    case 'attachment':
      return conn.pluck<number>(
        'SELECT 1 FROM files WHERE id = ?1 AND deleted_at IS NOT NULL', [id]) !== undefined;
    case 'exams':
    case 'exam':
      return conn.pluck<number>(
        'SELECT 1 FROM exam_sheets WHERE id = ?1 AND deleted_at IS NOT NULL', [id]) !== undefined;
    case 'translations':
    case 'translation':
      return conn.pluck<number>(
        'SELECT 1 FROM translations WHERE id = ?1 AND deleted_at IS NOT NULL', [id]) !== undefined;
    case 'essays':
    case 'essay':
      return id.startsWith('essay_session_')
        ? conn.pluck<number>(
          'SELECT 1 FROM essay_sessions WHERE id = ?1 AND deleted_at IS NOT NULL', [id]) !== undefined
        : conn.pluck<number>(
          'SELECT 1 FROM essays WHERE id = ?1 AND deleted_at IS NOT NULL', [id]) !== undefined;
    case 'folders':
    case 'folder':
      return conn.pluck<number>(
        'SELECT 1 FROM folders WHERE id = ?1 AND deleted_at IS NOT NULL', [id]) !== undefined;
    case 'mindmaps':
    case 'mindmap':
      return conn.pluck<number>(
        'SELECT 1 FROM mindmaps WHERE id = ?1 AND deleted_at IS NOT NULL', [id]) !== undefined;
    default:
      return undefined;
  }
}

/** Resource ids of every round in an essay session (trash_handlers.rs:814-830). */
export function listSessionEssayResourceIdsWithConn(
  conn: SqlExecutor,
  sessionId: string,
): string[] {
  return conn.all<{ resource_id: string | null }>(
    'SELECT resource_id FROM essays WHERE session_id = ?1 AND resource_id IS NOT NULL',
    [sessionId],
  ).flatMap(row => (typeof row.resource_id === 'string' ? [row.resource_id] : []));
}

/** Note ids inside a folder subtree, including the folder itself (trash_handlers.rs:834-859). */
export function listNoteIdsInFolderTreeWithConn(
  conn: SqlExecutor,
  folderId: string,
): string[] {
  return conn.all<{ item_id: string }>(
    `WITH RECURSIVE folder_tree AS (
       SELECT id FROM folders WHERE id = ?1
       UNION ALL
       SELECT f.id FROM folders f JOIN folder_tree ft ON f.parent_id = ft.id
     )
     SELECT fi.item_id FROM folder_items fi
     WHERE fi.item_type = 'note' AND fi.folder_id IN (SELECT id FROM folder_tree)`,
    [folderId],
  ).map(row => row.item_id);
}

/** Resource ids collected before `dstu_delete_many` (handlers.rs:5298-5332). */
export function collectDeleteManyResourceIdsWithConn(
  conn: SqlExecutor,
  items: readonly { resourceType: string; id: string }[],
): string[] {
  const ids: string[] = [];
  for (const { resourceType, id } of items) {
    let value: string | null | undefined;
    switch (resourceType) {
      case 'notes':
      case 'note':
        value = conn.pluck<string | null>('SELECT resource_id FROM notes WHERE id = ?1', [id]);
        break;
      case 'textbooks':
      case 'textbook':
      case 'images':
      case 'image':
      case 'files':
      case 'file':
      case 'attachments':
      case 'attachment':
        value = conn.pluck<string | null>('SELECT resource_id FROM files WHERE id = ?1', [id]);
        break;
      case 'exams':
      case 'exam':
        value = conn.pluck<string | null>('SELECT resource_id FROM exam_sheets WHERE id = ?1', [id]);
        break;
      case 'translations':
      case 'translation':
        value = conn.pluck<string | null>('SELECT resource_id FROM translations WHERE id = ?1', [id]);
        break;
      case 'mindmaps':
      case 'mindmap':
        value = conn.pluck<string | null>('SELECT resource_id FROM mindmaps WHERE id = ?1', [id]);
        break;
      default:
        value = undefined;
    }
    if (typeof value === 'string') ids.push(value);
  }
  return ids;
}

/** Columns fetched by `collect_column_strings` for the empty-trash preflight. */
export function collectTrashResourceIdsWithConn(conn: SqlExecutor): string[] {
  const ids: string[] = [];
  for (const sql of [
    'SELECT resource_id FROM notes WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL',
    'SELECT resource_id FROM files WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL',
    'SELECT resource_id FROM exam_sheets WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL',
    'SELECT resource_id FROM translations WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL',
    'SELECT resource_id FROM mindmaps WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL',
    'SELECT e.resource_id FROM essays e INNER JOIN essay_sessions s ON e.session_id = s.id WHERE s.deleted_at IS NOT NULL AND e.resource_id IS NOT NULL',
  ]) {
    try {
      for (const row of conn.all<{ resource_id: string | null }>(sql)) {
        if (typeof row.resource_id === 'string') ids.push(row.resource_id);
      }
    } catch { // boundary-allow empty-catch: Rust `collect_column_strings(..).unwrap_or_default()` 忽略读取失败
      continue;
    }
  }
  return ids;
}

/** `SELECT id FROM notes WHERE deleted_at IS NOT NULL` (trash_handlers.rs:676-678). */
export function collectDeletedNoteIdsWithConn(conn: SqlExecutor): string[] {
  try {
    return conn.all<{ id: string }>('SELECT id FROM notes WHERE deleted_at IS NOT NULL').map(row => row.id);
  } catch { // boundary-allow empty-catch: Rust `unwrap_or_default()` 忽略读取失败
    return [];
  }
}

/** Ids purged by `dstu_empty_trash` for one repository-driven batch. */
export function listDeletedIdsWithConn(conn: SqlExecutor, table: 'exam_sheets' | 'translations' | 'essay_sessions'): string[] {
  return conn.all<{ id: string }>(`SELECT id FROM ${table} WHERE deleted_at IS NOT NULL`).map(row => row.id);
}

/** Resource ids collected before `dstu_purge_all` (handlers.rs:5149-5179). */
export function collectPurgeAllResourceIdsWithConn(
  conn: SqlExecutor,
  resourceType: string,
): string[] {
  const sql = resourceType === 'notes'
    ? 'SELECT resource_id FROM notes WHERE deleted_at IS NOT NULL AND resource_id IS NOT NULL'
    : resourceType === 'textbooks'
      ? "SELECT resource_id FROM files WHERE status = 'deleted' AND id LIKE 'tb_%' AND resource_id IS NOT NULL"
      : undefined;
  if (sql === undefined) return [];
  try {
    return conn.all<{ resource_id: string | null }>(sql)
      .flatMap(row => (typeof row.resource_id === 'string' ? [row.resource_id] : []));
  } catch { // boundary-allow empty-catch: Rust 忽略预收集查询失败
    return [];
  }
}
