import type { SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { parseRfc3339, parseNaiveDateTime } from '../../../platform/time/index.ts';
import { nanoid } from '../src/nanoid.ts';
import { VfsError } from '../src/error.ts';
import {
  canonicalFolderItemType,
  MAX_BATCH_SIZE,
  MAX_FOLDER_DEPTH,
  type BreadcrumbItem,
  type FolderResourceInfo,
  type FolderResourcesResult,
  type FolderTreeNode,
  type VfsFolder,
  type VfsFolderItem,
} from '../src/folder-types.ts';
import { callNoteRepository, vfsRepositories } from './services.ts';

/** Logging surface needed when an auxiliary cache invalidation fails. */
export interface FolderLog {
  warn(message: string, ...args: unknown[]): void;
}

interface FolderRow {
  id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  color: string | null;
  is_expanded: number;
  is_favorite: number;
  sort_order: number;
  created_at: number | string;
  updated_at: number | string;
}

interface FolderItemRow {
  id: string;
  folder_id: string | null;
  item_type: string;
  item_id: string;
  sort_order: number;
  created_at: number | string | null;
  cached_path: string | null;
}

const FOLDER_COLUMNS = `id, parent_id, title, icon, color, is_expanded, is_favorite, sort_order,
  CASE typeof(created_at) WHEN 'text' THEN CAST(strftime('%s', created_at) AS INTEGER) * 1000 ELSE created_at END AS created_at,
  CASE typeof(updated_at) WHEN 'text' THEN CAST(strftime('%s', updated_at) AS INTEGER) * 1000 ELSE updated_at END AS updated_at`;

const FOLDER_ITEM_COLUMNS = 'id, folder_id, item_type, item_id, sort_order, created_at, cached_path';

function asDatabaseError(error: unknown): VfsError {
  return error instanceof VfsError
    ? error
    : new VfsError('Database', error instanceof Error ? error.message : String(error));
}

function database<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw asDatabaseError(error);
  }
}

function rowToFolder(row: FolderRow): VfsFolder {
  return {
    id: row.id,
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    title: row.title,
    ...(row.icon === null ? {} : { icon: row.icon }),
    ...(row.color === null ? {} : { color: row.color }),
    isExpanded: row.is_expanded !== 0,
    isFavorite: row.is_favorite !== 0,
    sortOrder: row.sort_order,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToFolderItem(row: FolderItemRow): VfsFolderItem {
  return {
    id: row.id,
    ...(row.folder_id === null ? {} : { folderId: row.folder_id }),
    itemType: row.item_type,
    itemId: row.item_id,
    sortOrder: row.sort_order,
    createdAt: readFolderItemTimestamp(row.created_at),
    ...(row.cached_path === null ? {} : { cachedPath: row.cached_path }),
  };
}

/** `parse_timestamp_text_to_millis` (folder_repo.rs:47-77). */
function parseTimestampTextToMillis(raw: string): number | undefined {
  const trimmed = rustTrim(raw);
  if (!trimmed) return undefined;
  if (/^[+-]?\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    return Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
  }
  const zoned = parseRfc3339(trimmed);
  if (zoned !== null) return zoned.millis;
  if (trimmed.includes(' ')) return parseNaiveDateTime(trimmed)?.millis;
  return parseNaiveDateTime(`${trimmed} 00:00:00`)?.millis;
}

function readFolderItemTimestamp(value: SqlValue): number {
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return parseTimestampTextToMillis(value) ?? 0;
  return 0;
}

export function generateFolderId(): string {
  return `fld_${nanoid(10)}`;
}

export function generateFolderItemId(): string {
  return `fi_${nanoid(10)}`;
}

export function createFolderRecord(title: string, parentId?: string, icon?: string, color?: string): VfsFolder {
  const now = Date.now();
  return {
    id: generateFolderId(),
    ...(parentId === undefined ? {} : { parentId }),
    title,
    ...(icon === undefined ? {} : { icon }),
    ...(color === undefined ? {} : { color }),
    isExpanded: true,
    isFavorite: false,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function createFolderItemRecord(folderId: string | undefined, itemType: string, itemId: string): VfsFolderItem {
  return {
    id: generateFolderItemId(),
    ...(folderId === undefined ? {} : { folderId }),
    itemType,
    itemId,
    sortOrder: 0,
    createdAt: Date.now(),
  };
}

// -------------------------------------------------------------------------- folder CRUD

export function createFolderWithConn(conn: SqlExecutor, folder: VfsFolder): void {
  database(() => {
    if (folder.parentId !== undefined) {
      if (!folderExistsWithConn(conn, folder.parentId)) {
        throw new VfsError('InvalidParent', { folder_id: folder.parentId, reason: 'Parent folder does not exist' });
      }
      const depth = getFolderDepthWithConn(conn, folder.parentId);
      if (depth >= MAX_FOLDER_DEPTH) {
        throw new VfsError('FolderDepthExceeded', {
          folder_id: folder.id,
          current_depth: depth + 1,
          max_depth: MAX_FOLDER_DEPTH,
        });
      }
    }

    const count = countAllFoldersWithConn(conn);
    if (count >= 500) throw new VfsError('FolderCountExceeded', { current_count: count, max_count: 500 });

    conn.run(
      `INSERT INTO folders (id, parent_id, title, icon, color, is_expanded, sort_order, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      [folder.id, folder.parentId ?? null, folder.title, folder.icon ?? null, folder.color ?? null,
        folder.isExpanded ? 1 : 0, folder.sortOrder, folder.createdAt, folder.updatedAt],
    );
  });
}

export function getFolderWithConn(conn: SqlExecutor, folderId: string): VfsFolder | undefined {
  return database(() => {
    const row = conn.get<FolderRow>(`SELECT ${FOLDER_COLUMNS} FROM folders WHERE id = ?1`, [folderId]);
    return row === undefined ? undefined : rowToFolder(row);
  });
}

export function folderExistsWithConn(conn: SqlExecutor, folderId: string): boolean {
  return database(() => (conn.pluck<number>('SELECT COUNT(*) FROM folders WHERE id = ?1 AND deleted_at IS NULL', [folderId]) ?? 0) > 0);
}

export function getFolderDepthWithConn(conn: SqlExecutor, folderId: string): number {
  try {
    const depth = conn.pluck<number>(
      `WITH RECURSIVE folder_path AS (
         SELECT id, parent_id, 1 AS depth FROM folders WHERE id = ?1
         UNION ALL
         SELECT f.id, f.parent_id, fp.depth + 1
         FROM folders f JOIN folder_path fp ON f.id = fp.parent_id
         WHERE fp.depth < ?2
       )
       SELECT COALESCE(MAX(depth), 0) FROM folder_path`,
      [folderId, MAX_FOLDER_DEPTH + 1],
    );
    return Number(depth ?? 0);
  } catch {
    return 0; // Rust: query_row(...).unwrap_or(0), folder_repo.rs:438-454.
  }
}

function getSubtreeDepthWithConn(conn: SqlExecutor, folderId: string): number {
  try {
    const depth = conn.pluck<number>(
      `WITH RECURSIVE folder_tree AS (
         SELECT id, parent_id, 1 AS depth FROM folders WHERE id = ?1
         UNION ALL
         SELECT f.id, f.parent_id, ft.depth + 1
         FROM folders f JOIN folder_tree ft ON f.parent_id = ft.id
         WHERE ft.depth < ?2
       )
       SELECT COALESCE(MAX(depth), 1) FROM folder_tree`,
      [folderId, MAX_FOLDER_DEPTH + 1],
    );
    return Number(depth ?? 1);
  } catch {
    return 1;
  }
}

export function countAllFoldersWithConn(conn: SqlExecutor): number {
  return database(() => Number(conn.pluck<number>('SELECT COUNT(*) FROM folders WHERE deleted_at IS NULL') ?? 0));
}

export function listAllFoldersWithConn(conn: SqlExecutor): VfsFolder[] {
  return database(() => conn
    .all<FolderRow>(`SELECT ${FOLDER_COLUMNS} FROM folders WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`)
    .map(rowToFolder));
}

export function listFoldersByParentWithConn(conn: SqlExecutor, parentId: string | null): VfsFolder[] {
  return database(() => conn
    .all<FolderRow>(
      `SELECT ${FOLDER_COLUMNS} FROM folders WHERE parent_id IS ?1 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`,
      [parentId],
    )
    .map(rowToFolder));
}

export function setFolderExpandedWithConn(conn: SqlExecutor, folderId: string, isExpanded: boolean): void {
  database(() => {
    const affected = conn.run(
      'UPDATE folders SET is_expanded = ?1, updated_at = ?2 WHERE id = ?3',
      [isExpanded ? 1 : 0, Date.now(), folderId],
    ).changes;
    if (affected === 0) throw new VfsError('FolderNotFound', { folder_id: folderId });
  });
}

export function renameFolderIfVersionWithConn(
  conn: SqlExecutor,
  folderId: string,
  title: string,
  expectedUpdatedAt: number,
  log?: FolderLog,
): void {
  database(() => {
    const now = Math.max(Date.now(), expectedUpdatedAt + 1);
    const affected = conn.run(
      `UPDATE folders SET title = ?1, updated_at = ?2
       WHERE id = ?3 AND deleted_at IS NULL AND updated_at = ?4`,
      [title, now, folderId, expectedUpdatedAt],
    ).changes;
    if (affected === 0) {
      const exists = conn.pluck<number>(
        'SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1 AND deleted_at IS NULL)',
        [folderId],
      ) ?? 0;
      if (exists === 0) throw new VfsError('FolderNotFound', { folder_id: folderId });
      throw new VfsError('Conflict', {
        key: 'folders.conflict',
        message: `Folder ${folderId} changed before the rename could be applied`,
      });
    }
    invalidateFolderSubtree(conn, folderId, log);
  });
}

/** `VfsFolderRepo::update_folder_with_conn` (folder_repo.rs:1069-1135). */
export function updateFolderWithConn(
  conn: SqlExecutor,
  folder: VfsFolder,
  log?: FolderLog,
): void {
  database(() => {
    const now = Date.now();
    const affected = conn.run(
      `UPDATE folders
       SET parent_id = ?1, title = ?2, icon = ?3, color = ?4, is_expanded = ?5,
           sort_order = ?6, updated_at = ?7
       WHERE id = ?8`,
      [
        folder.parentId ?? null,
        folder.title,
        folder.icon ?? null,
        folder.color ?? null,
        folder.isExpanded ? 1 : 0,
        folder.sortOrder,
        now,
        folder.id,
      ],
    ).changes;
    if (affected === 0) {
      throw new VfsError('FolderNotFound', { folder_id: folder.id });
    }
    invalidateFolderSubtree(conn, folder.id, log);
  });
}

function invalidateFolderSubtree(conn: SqlExecutor, folderId: string, log?: FolderLog): void {
  const folderIds = getFolderIdsRecursiveWithConn(conn, folderId);
  if (folderIds.length === 0) return;
  executeUpdateInBatches(conn, folderIds, 'UPDATE folder_items SET cached_path = NULL WHERE folder_id IN ({})');
  try {
    invalidateByFoldersBatchWithConn(conn, folderIds);
  } catch (error) {
    log?.warn(
      '[VFS::FolderRepo] Failed to invalidate path_cache for %s folders: %s',
      folderIds.length,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function moveFolderWithConn(
  conn: SqlExecutor,
  folderId: string,
  newParentId: string | undefined,
  log?: FolderLog,
): void {
  database(() => {
    if (getFolderWithConn(conn, folderId) === undefined) {
      throw new VfsError('FolderNotFound', { folder_id: folderId });
    }

    if (newParentId !== undefined) {
      if (!folderExistsWithConn(conn, newParentId)) {
        throw new VfsError('InvalidParent', {
          folder_id: newParentId,
          reason: 'Target parent folder does not exist',
        });
      }
      if (getFolderIdsRecursiveWithConn(conn, folderId).includes(newParentId)) {
        throw new VfsError('InvalidParent', {
          folder_id: newParentId,
          reason: 'Cannot move folder to its own descendant',
        });
      }
      const parentDepth = getFolderDepthWithConn(conn, newParentId);
      const subtreeDepth = getSubtreeDepthWithConn(conn, folderId);
      if (parentDepth + subtreeDepth >= MAX_FOLDER_DEPTH) {
        throw new VfsError('FolderDepthExceeded', {
          folder_id: folderId,
          current_depth: parentDepth + subtreeDepth,
          max_depth: MAX_FOLDER_DEPTH,
        });
      }
    }

    conn.run(
      'UPDATE folders SET parent_id = ?1, updated_at = ?2 WHERE id = ?3',
      [newParentId ?? null, Date.now(), folderId],
    );
    invalidateFolderSubtree(conn, folderId, log);
  });
}

// -------------------------------------------------------------------------- recursive queries

export function getFolderIdsRecursiveWithConn(conn: SqlExecutor, folderId: string): string[] {
  return database(() => conn
    .all<{ id: string }>(
      `WITH RECURSIVE folder_tree AS (
         SELECT id, parent_id, title, 0 AS depth FROM folders WHERE id = ?1 AND deleted_at IS NULL
         UNION ALL
         SELECT f.id, f.parent_id, f.title, ft.depth + 1
         FROM folders f JOIN folder_tree ft ON f.parent_id = ft.id
         WHERE ft.depth < ?2 AND f.deleted_at IS NULL
       )
       SELECT id FROM folder_tree`,
      [folderId, MAX_FOLDER_DEPTH],
    )
    .map(row => row.id));
}

function queryInBatches<T>(
  conn: SqlExecutor,
  ids: string[],
  sqlTemplate: string,
  mapper: (row: FolderItemRow) => T,
): T[] {
  if (ids.length === 0) return [];
  const results: T[] = [];
  for (let offset = 0; offset < ids.length; offset += MAX_BATCH_SIZE) {
    const chunk = ids.slice(offset, offset + MAX_BATCH_SIZE);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(', ');
    const rows = conn.all<FolderItemRow>(sqlTemplate.replace('{}', placeholders), chunk);
    for (const row of rows) results.push(mapper(row));
  }
  return results;
}

function executeUpdateInBatches(conn: SqlExecutor, ids: string[], sqlTemplate: string): number {
  if (ids.length === 0) return 0;
  let affected = 0;
  for (let offset = 0; offset < ids.length; offset += MAX_BATCH_SIZE) {
    const chunk = ids.slice(offset, offset + MAX_BATCH_SIZE);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(', ');
    affected += conn.run(sqlTemplate.replace('{}', placeholders), chunk).changes;
  }
  return affected;
}

export function getItemsByFoldersWithConn(conn: SqlExecutor, folderIds: string[]): VfsFolderItem[] {
  return database(() => {
    const items = queryInBatches(
      conn,
      folderIds,
      `SELECT ${FOLDER_ITEM_COLUMNS} FROM folder_items
       WHERE folder_id IN ({}) AND deleted_at IS NULL`,
      rowToFolderItem,
    );
    items.sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt - right.createdAt);
    return items;
  });
}

export function listItemsByFolderWithConn(conn: SqlExecutor, folderId: string | null): VfsFolderItem[] {
  return database(() => conn
    .all<FolderItemRow>(
      `SELECT ${FOLDER_ITEM_COLUMNS} FROM folder_items
       WHERE folder_id IS ?1 AND deleted_at IS NULL
       ORDER BY sort_order ASC, created_at ASC`,
      [folderId],
    )
    .map(rowToFolderItem));
}

/** `VfsFolderRepo::list_all_assigned_item_ids` (folder_repo.rs:897-913). */
export function listAllAssignedItemIdsWithConn(conn: SqlExecutor): Set<string> {
  return database(() => new Set(conn.all<{ item_id: string }>(
    'SELECT DISTINCT item_id FROM folder_items WHERE deleted_at IS NULL',
  ).map(row => row.item_id)));
}

export function getFolderItemsAllWithConn(conn: SqlExecutor, folderId: string | null): VfsFolderItem[] {
  return database(() => conn
    .all<FolderItemRow>(
      `SELECT id, item_type, item_id, folder_id, sort_order, cached_path, created_at
       FROM folder_items WHERE folder_id IS ?1 AND deleted_at IS NULL ORDER BY sort_order ASC`,
      [folderId],
    )
    .map(rowToFolderItem));
}

export function getFolderTreeAllWithConn(conn: SqlExecutor): FolderTreeNode[] {
  return database(() => {
    const folders = listAllFoldersWithConn(conn);
    return buildTreeRecursiveAll(folders, undefined, conn);
  });
}

function buildTreeRecursiveAll(
  allFolders: VfsFolder[],
  parentId: string | undefined,
  conn: SqlExecutor,
): FolderTreeNode[] {
  const nodes: FolderTreeNode[] = [];
  for (const folder of allFolders) {
    if (folder.parentId === parentId) {
      nodes.push({
        folder,
        children: buildTreeRecursiveAll(allFolders, folder.id, conn),
        items: getFolderItemsAllWithConn(conn, folder.id),
      });
    }
  }
  nodes.sort((left, right) => left.folder.sortOrder - right.folder.sortOrder);
  return nodes;
}

export function buildFolderPathWithConn(conn: SqlExecutor, folderId: string): string {
  return database(() => conn
    .all<{ title: string }>(
      `WITH RECURSIVE folder_path AS (
         SELECT id, parent_id, title, 1 AS depth FROM folders WHERE id = ?1
         UNION ALL
         SELECT f.id, f.parent_id, f.title, fp.depth + 1
         FROM folders f JOIN folder_path fp ON f.id = fp.parent_id
         WHERE fp.depth < ?2
       )
       SELECT title FROM folder_path ORDER BY depth DESC`,
      [folderId, MAX_FOLDER_DEPTH + 1],
    )
    .map(row => row.title)
    .join('/'));
}

// -------------------------------------------------------------------------- item titles/content

function getItemTitleWithConn(conn: SqlExecutor, itemType: string, itemId: string): string {
  const title = database(() => {
    switch (itemType) {
      case 'note':
        return conn.pluck<string>('SELECT title FROM notes WHERE id = ?1', [itemId]);
      case 'textbook':
      case 'file':
        return conn.pluck<string>('SELECT file_name FROM files WHERE id = ?1', [itemId]);
      case 'exam':
        return conn.pluck<string>('SELECT COALESCE(exam_name, id) FROM exam_sheets WHERE id = ?1', [itemId]);
      case 'translation':
        return conn.pluck<string>('SELECT COALESCE(title, id) FROM translations WHERE id = ?1', [itemId]);
      case 'essay':
        return conn.pluck<string>('SELECT COALESCE(title, id) FROM essays WHERE id = ?1', [itemId]);
      case 'mindmap':
        return conn.pluck<string>('SELECT title FROM mindmaps WHERE id = ?1', [itemId]);
      default:
        return itemId;
    }
  });
  return title ?? itemId;
}

function getItemResourceIdWithConn(conn: SqlExecutor, itemType: string, itemId: string): string | undefined {
  return database(() => {
    switch (itemType) {
      case 'note':
        return conn.pluck<string>('SELECT resource_id FROM notes WHERE id = ?1', [itemId]);
      case 'textbook':
      case 'file':
      case 'exam': {
        const table = itemType === 'exam' ? 'exam_sheets' : 'files';
        try { return conn.pluck<string>(`SELECT resource_id FROM ${table} WHERE id = ?1`, [itemId]); }
        catch { return undefined; } // Rust: .optional().ok().flatten().
      }
      case 'translation':
        return conn.pluck<string>('SELECT resource_id FROM translations WHERE id = ?1', [itemId]);
      case 'essay':
        return conn.pluck<string>('SELECT resource_id FROM essays WHERE id = ?1', [itemId]);
      case 'mindmap':
        return conn.pluck<string>('SELECT resource_id FROM mindmaps WHERE id = ?1', [itemId]);
      default:
        return undefined;
    }
  });
}

function getItemContentWithConn(
  conn: SqlExecutor,
  itemType: string,
  itemId: string,
  resourceId: string | undefined,
): string | undefined {
  return database(() => {
    if (resourceId !== undefined) {
      const content = conn.pluck<string | null>('SELECT data FROM resources WHERE id = ?1', [resourceId]);
      if (content !== undefined && content !== null) return content;
    }
    switch (itemType) {
      case 'note':
      case 'translation':
      case 'essay':
      case 'mindmap':
        return undefined;
      case 'textbook':
        return conn.pluck<string>("SELECT file_name || ' (PDF)' FROM files WHERE id = ?1", [itemId]);
      case 'file':
        return conn.pluck<string>("SELECT file_name || ' (file)' FROM files WHERE id = ?1", [itemId]);
      case 'exam':
        return conn.pluck<string>('SELECT preview_json FROM exam_sheets WHERE id = ?1', [itemId]);
      default:
        return undefined;
    }
  });
}

function buildResourcePathWithConn(conn: SqlExecutor, item: VfsFolderItem): string {
  const title = getItemTitleWithConn(conn, item.itemType, item.itemId);
  if (item.folderId === undefined) return title;
  return `${buildFolderPathWithConn(conn, item.folderId)}/${title}`;
}

function buildResourceInfoWithConn(
  conn: SqlExecutor,
  item: VfsFolderItem,
  includeContent: boolean,
): FolderResourceInfo {
  const resourceId = getItemResourceIdWithConn(conn, item.itemType, item.itemId);
  const content = includeContent
    ? getItemContentWithConn(conn, item.itemType, item.itemId, resourceId)
    : undefined;
  return {
    itemType: item.itemType,
    itemId: item.itemId,
    ...(resourceId === undefined ? {} : { resourceId }),
    title: getItemTitleWithConn(conn, item.itemType, item.itemId),
    path: buildResourcePathWithConn(conn, item),
    ...(content === undefined ? {} : { content }),
  };
}

export function getAllResourcesWithConn(
  conn: SqlExecutor,
  folderId: string,
  includeSubfolders: boolean,
  includeContent: boolean,
): FolderResourcesResult {
  return database(() => {
    const folder = getFolderWithConn(conn, folderId);
    if (folder === undefined) throw new VfsError('NotFound', { resource_type: 'Folder', id: folderId });

    const folderPath = buildFolderPathWithConn(conn, folderId);
    const folderIds = includeSubfolders
      ? getFolderIdsRecursiveWithConn(conn, folderId)
      : [folderId];
    const items = getItemsByFoldersWithConn(conn, folderIds);
    const resources = items.map(item => buildResourceInfoWithConn(conn, item, includeContent));
    return {
      folderId,
      folderTitle: folder.title,
      path: folderPath,
      totalCount: resources.length,
      resources,
    };
  });
}

// -------------------------------------------------------------------------- item membership

export function addItemToFolderWithConn(conn: SqlExecutor, item: VfsFolderItem): void {
  database(() => {
    const canonical = canonicalFolderItemType(item.itemType);
    conn.run('DELETE FROM folder_items WHERE item_id = ?1 AND item_type = ?2', [item.itemId, canonical]);
    conn.run(
      `INSERT OR REPLACE INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      [item.id, item.folderId ?? null, canonical, item.itemId, item.sortOrder, item.createdAt, item.cachedPath ?? null],
    );
  });
}

/** `VfsFolderRepo::get_folder_item_by_cached_path_with_conn` (folder_repo.rs:783-809). */
export function getFolderItemByCachedPathWithConn(
  conn: SqlExecutor,
  cachedPath: string,
): VfsFolderItem | undefined {
  return database(() => {
    const row = conn.get<FolderItemRow>(
      `SELECT ${FOLDER_ITEM_COLUMNS}
       FROM folder_items
       WHERE cached_path = ?1 AND deleted_at IS NULL`,
      [cachedPath],
    );
    return row === undefined ? undefined : rowToFolderItem(row);
  });
}

/** dstu_rename cached_path invalidation (handlers.rs:2186-2205); failures are non-fatal. */
export function clearFolderItemCachedPathWithConn(
  conn: SqlExecutor,
  itemId: string,
  itemType: string,
): void {
  conn.run(
    'UPDATE folder_items SET cached_path = NULL WHERE item_id = ?1 AND item_type = ?2 AND deleted_at IS NULL',
    [itemId, itemType],
  );
}

export function removeItemFromFolderWithConn(conn: SqlExecutor, itemType: string, itemId: string): void {
  database(() => {
    conn.run('DELETE FROM folder_items WHERE item_id = ?1 AND item_type = ?2', [itemId, canonicalFolderItemType(itemType)]);
  });
}

export function moveItemToFolderWithConn(
  conn: SqlExecutor,
  itemType: string,
  itemId: string,
  newFolderId: string | undefined,
): void {
  database(() => {
    const canonical = canonicalFolderItemType(itemType);
    if (newFolderId !== undefined && !folderExistsWithConn(conn, newFolderId)) {
      throw new VfsError('FolderNotFound', { folder_id: newFolderId });
    }
    const affected = conn.run(
      `UPDATE folder_items SET folder_id = ?1, cached_path = NULL
       WHERE item_id = ?2 AND item_type = ?3 AND deleted_at IS NULL`,
      [newFolderId ?? null, itemId, canonical],
    ).changes;
    if (affected === 0) {
      conn.run(
        `INSERT INTO folder_items (id, item_type, item_id, folder_id, sort_order, cached_path, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, NULL, ?5)`,
        [generateFolderItemId(), canonical, itemId, newFolderId ?? null, Date.now()],
      );
    }
    markItemIndexesPendingWithConn(conn, itemId);
  });
}

function markItemIndexesPendingWithConn(conn: SqlExecutor, itemId: string): void {
  database(() => {
    conn.run(
      `UPDATE resources SET
         index_state = CASE WHEN index_state = 'disabled' THEN 'disabled' ELSE 'pending' END,
         index_hash = CASE WHEN index_state = 'disabled' THEN index_hash ELSE NULL END,
         index_error = CASE WHEN index_state = 'disabled' THEN index_error ELSE NULL END,
         indexed_at = CASE WHEN index_state = 'disabled' THEN indexed_at ELSE NULL END,
         index_retry_count = CASE WHEN index_state = 'disabled' THEN index_retry_count ELSE 0 END,
         index_next_retry_at = CASE WHEN index_state = 'disabled' THEN index_next_retry_at ELSE 0 END,
         mm_index_state = CASE WHEN mm_index_state IS NULL OR mm_index_state = 'disabled' THEN mm_index_state ELSE 'pending' END,
         mm_index_error = CASE WHEN mm_index_state IS NULL OR mm_index_state = 'disabled' THEN mm_index_error ELSE NULL END,
         mm_indexed_at = CASE WHEN mm_index_state IS NULL OR mm_index_state = 'disabled' THEN mm_indexed_at ELSE NULL END,
         mm_index_retry_count = CASE WHEN mm_index_state IS NULL OR mm_index_state = 'disabled' THEN mm_index_retry_count ELSE 0 END,
         mm_index_next_retry_at = CASE WHEN mm_index_state IS NULL OR mm_index_state = 'disabled' THEN mm_index_next_retry_at ELSE 0 END,
         updated_at = ?2
       WHERE id = ?1 OR source_id = ?1`,
      [itemId, Date.now()],
    );
  });
}

// -------------------------------------------------------------------------- ordering

function executeReorderInBatches(
  conn: SqlExecutor,
  items: ReadonlyArray<{ id: string; sortOrder: number }>,
  table: 'folders' | 'folder_items',
  now: number,
): void {
  if (items.length === 0) return;
  if (items.length <= MAX_BATCH_SIZE) {
    for (const item of items) {
      conn.run(`UPDATE ${table} SET sort_order = ?1, updated_at = ?2 WHERE id = ?3`, [item.sortOrder, now, item.id]);
    }
    return;
  }
  for (let offset = 0; offset < items.length; offset += MAX_BATCH_SIZE) {
    const chunk = items.slice(offset, offset + MAX_BATCH_SIZE);
    const cases = chunk.map(item => `WHEN '${item.id.replace(/'/g, "''")}' THEN ${item.sortOrder}`).join(' ');
    const ids = chunk.map(item => `'${item.id.replace(/'/g, "''")}'`).join(', ');
    conn.run(`UPDATE ${table} SET sort_order = CASE id ${cases} END, updated_at = ?1 WHERE id IN (${ids})`, [now]);
  }
}

export function reorderFoldersWithConn(conn: SqlExecutor, folderIds: string[]): void {
  database(() => executeReorderInBatches(
    conn,
    folderIds.map((id, index) => ({ id, sortOrder: index })),
    'folders',
    Date.now(),
  ));
}

export function reorderItemsWithConn(conn: SqlExecutor, itemIds: string[]): void {
  database(() => executeReorderInBatches(
    conn,
    itemIds.map((id, index) => ({ id, sortOrder: index })),
    'folder_items',
    Date.now(),
  ));
}

// -------------------------------------------------------------------------- breadcrumbs

export function getBreadcrumbsWithConn(conn: SqlExecutor, folderId: string): BreadcrumbItem[] {
  let rows: Array<{ id: string; title: string }>;
  try {
    rows = conn.all<{ id: string; title: string }>(
      `WITH RECURSIVE folder_path AS (
         SELECT id, parent_id, title, 1 AS depth FROM folders WHERE id = ?1
         UNION ALL
         SELECT f.id, f.parent_id, f.title, fp.depth + 1
         FROM folders f JOIN folder_path fp ON f.id = fp.parent_id
         WHERE fp.depth < 11
       )
       SELECT id, title FROM folder_path ORDER BY depth DESC`,
      [folderId],
    );
  } catch (error) {
    throw new Error(`Query failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return rows.map(row => ({ id: row.id, name: row.title }));
}

// -------------------------------------------------------------------------- path cache

function ensurePathCacheTable(conn: SqlExecutor): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS path_cache (
    item_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    full_path TEXT NOT NULL,
    folder_path TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (item_type, item_id)
  )`);
  conn.exec('CREATE INDEX IF NOT EXISTS idx_path_cache_path ON path_cache(full_path)');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_path_cache_folder ON path_cache(folder_path)');
}

function invalidateByFoldersBatchWithConn(conn: SqlExecutor, folderIds: string[]): number {
  if (folderIds.length === 0) return 0;
  ensurePathCacheTable(conn);
  let deleted = 0;
  for (let offset = 0; offset < folderIds.length; offset += MAX_BATCH_SIZE) {
    const chunk = folderIds.slice(offset, offset + MAX_BATCH_SIZE);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(', ');
    deleted += conn.run(
      `DELETE FROM path_cache WHERE item_type = 'folder' AND item_id IN (${placeholders})`,
      chunk,
    ).changes;
  }
  for (let offset = 0; offset < folderIds.length; offset += MAX_BATCH_SIZE) {
    const chunk = folderIds.slice(offset, offset + MAX_BATCH_SIZE);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(', ');
    const items = conn.all<{ item_type: string; item_id: string }>(
      `SELECT item_type, item_id FROM folder_items WHERE folder_id IN (${placeholders})`,
      chunk,
    );
    const byType = new Map<string, string[]>();
    for (const item of items) {
      const list = byType.get(item.item_type) ?? [];
      list.push(item.item_id);
      byType.set(item.item_type, list);
    }
    for (const [itemType, itemIds] of byType) {
      for (let index = 0; index < itemIds.length; index += MAX_BATCH_SIZE) {
        const ids = itemIds.slice(index, index + MAX_BATCH_SIZE);
        const idPlaceholders = ids.map((_, position) => `?${position + 2}`).join(', ');
        deleted += conn.run(
          `DELETE FROM path_cache WHERE item_type = ?1 AND item_id IN (${idPlaceholders})`,
          [itemType, ...ids],
        ).changes;
      }
    }
  }
  return deleted;
}

// -------------------------------------------------------------------------- soft delete cascade

/** folder_repo.rs:1230-1320; L11 owns the savepoint and same-connection entity cascade. */
export function deleteFolderWithConn(
  conn: SqlExecutor,
  folderId: string,
  _options: { deviceId?: string | null; log?: FolderLog } = {},
): void {
  callNoteRepository(() => vfsRepositories().folders.deleteFolder(conn, folderId));
}
