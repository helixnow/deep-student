import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { VfsError } from '../src/error.ts';
import { canonicalFolderItemType } from '../src/folder-types.ts';
import { buildFolderPathWithConn, generateFolderItemId } from './folders.ts';

function database<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw error instanceof VfsError
      ? error
      : new VfsError('Database', error instanceof Error ? error.message : String(error));
  }
}

export interface FolderItemLocationRow {
  id: string;
  folderId: string | null;
  itemId: string;
  cachedPath: string | null;
}

export function getActiveFolderItemLocationWithConn(
  conn: SqlExecutor,
  itemType: string,
  itemId: string,
): { folderId: string | null; cachedPath: string | null } | undefined {
  return database(() => conn.get<{ folderId: string | null; cachedPath: string | null }>(
    `SELECT folder_id AS folderId, cached_path AS cachedPath
     FROM folder_items WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL`,
    [itemType, itemId],
  ));
}

export function getActiveFolderItemIdWithConn(
  conn: SqlExecutor,
  itemType: string,
  itemId: string,
): string | undefined {
  return database(() => conn.pluck<string>(
    'SELECT id FROM folder_items WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL',
    [itemType, itemId],
  ));
}

/** `dstu_move_to_folder` UPDATE branch (handlers.rs:6203-6211) omits item_type. */
export function moveFolderItemByIdWithConn(
  conn: SqlExecutor,
  itemId: string,
  folderId: string | null,
  cachedPath: string,
  updatedAt: number,
): number {
  return database(() => conn.run(
    'UPDATE folder_items SET folder_id = ?1, cached_path = ?2, updated_at = ?3 WHERE item_id = ?4 AND deleted_at IS NULL',
    [folderId, cachedPath, updatedAt, itemId],
  ).changes);
}

/** `move_single_item` UPDATE branch (handlers.rs:6464-6473) keeps item_type. */
export function moveSingleFolderItemWithConn(
  conn: SqlExecutor,
  itemType: string,
  itemId: string,
  folderId: string | null,
  cachedPath: string,
  updatedAt: number,
): number {
  return database(() => conn.run(
    `UPDATE folder_items SET folder_id = ?1, cached_path = ?2, updated_at = ?3
     WHERE item_type = ?4 AND item_id = ?5 AND deleted_at IS NULL`,
    [folderId, cachedPath, updatedAt, itemType, itemId],
  ).changes);
}

export function insertFolderItemLocationWithConn(
  conn: SqlExecutor,
  itemType: string,
  itemId: string,
  folderId: string | null,
  cachedPath: string,
  nowMs: number,
): string {
  const itemRowId = generateFolderItemId();
  database(() => conn.run(
    `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, cached_path, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7)`,
    [itemRowId, folderId, itemType, itemId, cachedPath, nowMs, nowMs],
  ));
  return itemRowId;
}

export function listFolderItemsForRefreshWithConn(
  conn: SqlExecutor,
  itemType?: string,
  itemId?: string,
): FolderItemLocationRow[] {
  return database(() => {
    if (itemType !== undefined && itemId !== undefined) {
      return conn.all<FolderItemLocationRow>(
        `SELECT id, folder_id AS folderId, item_id AS itemId, cached_path AS cachedPath
         FROM folder_items WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL`,
        [itemType, itemId],
      );
    }
    return conn.all<FolderItemLocationRow>(
      `SELECT id, folder_id AS folderId, item_id AS itemId, cached_path AS cachedPath
       FROM folder_items WHERE deleted_at IS NULL`,
    );
  });
}

export function setFolderItemCachedPathWithConn(
  conn: SqlExecutor,
  itemRowId: string,
  cachedPath: string,
): void {
  database(() => conn.run(
    'UPDATE folder_items SET cached_path = ?1 WHERE id = ?2',
    [cachedPath, itemRowId],
  ));
}

/** `get_source_id_type` (ref_handlers.rs:1502-1538); `fld_`, `img_`, UUID and `res_` are unknown. */
function sourceIdItemType(sourceId: string): string | undefined {
  if (sourceId.startsWith('note_')) return 'note';
  if (sourceId.startsWith('mm_')) return 'mindmap';
  if (sourceId.startsWith('tb_')) return 'textbook';
  if (sourceId.startsWith('file_') || sourceId.startsWith('att_')) return 'file';
  if (sourceId.startsWith('exam_')) return 'exam';
  if (sourceId.startsWith('tr_')) return 'translation';
  if (sourceId.startsWith('essay_session_') || sourceId.startsWith('essay_')) return 'essay';
  return undefined;
}

/** `get_resource_path_with_conn` (ref_handlers.rs:981-1016) + `get_resource_path_internal`. */
export function getResourcePathWithConn(conn: SqlExecutor, sourceId: string): string {
  const itemType = sourceIdItemType(sourceId);
  if (itemType === undefined) return sourceId;
  const folderId = database(() => conn.pluck<string>(
    'SELECT folder_id FROM folder_items WHERE item_id = ?1 AND item_type = ?2 AND deleted_at IS NULL',
    [sourceId, canonicalFolderItemType(itemType)],
  ));
  if (folderId === undefined || folderId === null) return sourceId;
  return `${buildFolderPathWithConn(conn, folderId)}/${sourceId}`;
}

export { buildFolderPathWithConn };
