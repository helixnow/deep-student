/** Port of dstu-vfs folder_repo.rs. All functions take the caller's connection. */
import { logWarn } from './logger.ts';
import { nanoid } from 'nanoid';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type FolderCascadeDependencies,
  type FolderEntityAdapter,
  type FolderResourceInfo,
  type FolderRepository,
  type FolderResourcesResult,
  type FolderTreeNode,
  type VfsBreadcrumbItem,
  type ResourceLocation,
  type VfsFolder,
  type VfsFolderItem,
} from '../api.ts';
import { parseNaiveDateTime, parseRfc3339 } from '../../../platform/time/index.ts';
import { databaseResult } from './errors.ts';
import { getBreadcrumbs } from './folder-breadcrumbs.ts';
import { PathCacheRepo } from './path-cache.ts';
import { utcTimestamp } from './timestamps.ts';

const MAX_FOLDER_DEPTH = 10;
const MAX_FOLDERS_COUNT = 500;
const MAX_BATCH_SIZE = 100;

const FOLDER_COLUMNS = `id, parent_id, title, icon, color, is_expanded, is_favorite, sort_order,
  CASE typeof(created_at) WHEN 'text' THEN CAST(strftime('%s', created_at) AS INTEGER) * 1000 ELSE created_at END AS created_at,
  CASE typeof(updated_at) WHEN 'text' THEN CAST(strftime('%s', updated_at) AS INTEGER) * 1000 ELSE updated_at END AS updated_at`;
const FOLDER_ITEM_COLUMNS = 'id, folder_id, item_type, item_id, sort_order, created_at, cached_path';

const SUPPORTED_CASCADE_TYPES = new Set(['note', 'file', 'image', 'exam', 'translation', 'essay', 'essay_session', 'mindmap']);
const canonicalType = (type: string): string => type === 'textbook' ? 'file' : type;

function folderNotFound(folderId: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `FOLDER_NOT_FOUND: ${folderId}`, { id: folderId });
}
function itemNotFound(itemType: string, itemId: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `ITEM_NOT_FOUND: ${itemType}:${itemId}`, { resourceType: itemType, id: itemId });
}
function resourceNotFound(resourceType: string, id: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `${resourceType} not found: ${id}`, { resourceType, id });
}
function invalidParent(folderId: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_ARGUMENT', `INVALID_PARENT: ${folderId} - ${reason}`);
}
function depthExceeded(folderId: string, currentDepth: number, maxDepth: number): VfsRepositoryError {
  return new VfsRepositoryError('VFS_LIMIT_EXCEEDED',
    `FOLDER_DEPTH_EXCEEDED: ${folderId} (depth ${currentDepth} > max ${maxDepth})`);
}
function countExceeded(currentCount: number, maxCount: number): VfsRepositoryError {
  return new VfsRepositoryError('VFS_LIMIT_EXCEEDED', `FOLDER_COUNT_EXCEEDED: ${currentCount} folders (max ${maxCount})`);
}
function conflict(key: string, message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_CONFLICT', `CONFLICT(${key}): ${message}`, { key });
}

function valueKind(value: SqlValue | undefined): string {
  if (value === null || value === undefined) return 'Null';
  if (typeof value === 'string') return 'Text';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Real';
  if (typeof value === 'bigint') return 'Integer';
  return 'Blob';
}
function columnError(index: number, name: string, value: SqlValue | undefined): VfsRepositoryError {
  return new VfsRepositoryError('VFS_STORAGE',
    `Database error: Invalid column type ${valueKind(value)} at index: ${index}, name: ${name}`);
}
function readText(row: Row, name: string, index: number, nullable: false): string;
function readText(row: Row, name: string, index: number, nullable: true): string | null;
function readText(row: Row, name: string, index: number, nullable: boolean): string | null {
  const value = row[name];
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw columnError(index, name, value);
  }
  if (typeof value !== 'string') throw columnError(index, name, value);
  return value;
}
function readI32(row: Row, name: string, index: number): number {
  const value = row[name];
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < -2147483648 || number > 2147483647) {
    throw columnError(index, name, value);
  }
  return number;
}
function readI64(row: Row, name: string, index: number): number {
  const value = row[name];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number' || !Number.isInteger(value)) throw columnError(index, name, value);
  return value;
}
function readBool(row: Row, name: string, index: number): boolean {
  return readI32(row, name, index) !== 0;
}

/** Rust `parse_timestamp_text_to_millis`: integers, RFC3339, `%Y-%m-%d %H:%M:%S`, `%Y-%m-%d`. */
export function parseTimestampTextToMillis(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (/^[+-]?\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value)) return null;
    return Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
  }
  const rfc = parseRfc3339(trimmed);
  if (rfc !== null) return rfc.millis;
  // chrono's `%Y-%m-%d %H:%M:%S` only accepts a space separator; the platform
  // naive parser also accepts `T`, which Rust reaches only through RFC 3339.
  const naive = trimmed.includes('T') || trimmed.includes('t') ? null : parseNaiveDateTime(trimmed);
  if (naive !== null) return naive.millis;
  const dateOnly = parseNaiveDateTime(`${trimmed} 00:00:00`);
  if (dateOnly !== null) return dateOnly.millis;
  return null;
}

function readFolderItemTimestamp(row: Row, index: number, columnName: string): number {
  const value = row[columnName];
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = parseTimestampTextToMillis(value);
    if (parsed !== null) return parsed;
    logWarn(`[VFS::FolderRepo] Invalid ${columnName} value in folder_items, fallback to 0: ${JSON.stringify(value)}`);
    return 0;
  }
  logWarn(`[VFS::FolderRepo] ${value === null || value === undefined ? 'NULL' : 'BLOB'} ${columnName} value in folder_items, fallback to 0`);
  return 0;
}

function rowToFolder(row: Row): VfsFolder {
  const folder: VfsFolder = {
    id: readText(row, 'id', 0, false),
    title: readText(row, 'title', 2, false),
    isExpanded: readBool(row, 'is_expanded', 5),
    isFavorite: readBool(row, 'is_favorite', 6),
    sortOrder: readI32(row, 'sort_order', 7),
    createdAt: readI64(row, 'created_at', 8),
    updatedAt: readI64(row, 'updated_at', 9),
  };
  const parentId = readText(row, 'parent_id', 1, true);
  if (parentId !== null) folder.parentId = parentId;
  const icon = readText(row, 'icon', 3, true);
  if (icon !== null) folder.icon = icon;
  const color = readText(row, 'color', 4, true);
  if (color !== null) folder.color = color;
  return folder;
}

function rowToFolderItem(row: Row, createdIndex = 5): VfsFolderItem {
  const item: VfsFolderItem = {
    id: readText(row, 'id', 0, false),
    itemType: readText(row, 'item_type', 2, false),
    itemId: readText(row, 'item_id', 3, false),
    sortOrder: readI32(row, 'sort_order', 4),
    createdAt: readFolderItemTimestamp(row, createdIndex, 'created_at'),
  };
  const folderId = readText(row, 'folder_id', 1, true);
  if (folderId !== null) item.folderId = folderId;
  const cachedPath = readText(row, 'cached_path', 6, true);
  if (cachedPath !== null) item.cachedPath = cachedPath;
  return item;
}

function placeholders(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, index) => `?${index + 1 + offset}`).join(', ');
}

function executeUpdateInBatches(conn: SqlExecutor, ids: readonly string[], template: string): number {
  if (ids.length === 0) return 0;
  let total = 0;
  for (let start = 0; start < ids.length; start += MAX_BATCH_SIZE) {
    const chunk = ids.slice(start, start + MAX_BATCH_SIZE);
    total += conn.run(template.replace('{}', placeholders(chunk.length)), chunk).changes;
  }
  return total;
}

function queryInBatches<T>(conn: SqlExecutor, ids: readonly string[], template: string, map: (row: Row) => T): T[] {
  if (ids.length === 0) return [];
  const results: T[] = [];
  for (let start = 0; start < ids.length; start += MAX_BATCH_SIZE) {
    const chunk = ids.slice(start, start + MAX_BATCH_SIZE);
    const sql = template.replace('{}', placeholders(chunk.length));
    for (const row of conn.all(sql, chunk)) results.push(map(row));
  }
  return results;
}

function executeReorderInBatches(conn: SqlExecutor, items: readonly (readonly [string, number])[], table: string, now: number): number {
  if (items.length === 0) return 0;
  let total = 0;
  if (items.length <= MAX_BATCH_SIZE) {
    for (const [id, sortOrder] of items) {
      total += conn.run(`UPDATE ${table} SET sort_order = ?1, updated_at = ?2 WHERE id = ?3`,
        [sortOrder, now, id]).changes;
    }
    return total;
  }
  for (let start = 0; start < items.length; start += MAX_BATCH_SIZE) {
    const chunk = items.slice(start, start + MAX_BATCH_SIZE);
    const cases = chunk.map(([id, sortOrder]) => `WHEN '${id.replaceAll("'", "''")}' THEN ${sortOrder}`).join(' ');
    const ids = chunk.map(([id]) => `'${id.replaceAll("'", "''")}'`).join(', ');
    total += conn.run(`UPDATE ${table} SET sort_order = CASE id ${cases} END, updated_at = ?1 WHERE id IN (${ids})`,
      [now]).changes;
  }
  return total;
}

function withSavepoint<T>(conn: SqlExecutor, name: string, run: () => T): T {
  conn.exec(`SAVEPOINT ${name}`);
  try {
    const result = run();
    conn.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try { conn.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`); }
    catch (rollbackError) { logWarn('[VFS::FolderRepo] Savepoint rollback failed:', rollbackError); }
    throw error;
  }
}

export function newFolder(title: string, parentId: string | null = null, icon: string | null = null, color: string | null = null): VfsFolder {
  const now = Date.now();
  const folder: VfsFolder = {
    id: `fld_${nanoid(10)}`, title, isExpanded: true, isFavorite: false,
    sortOrder: 0, createdAt: now, updatedAt: now,
  };
  if (parentId !== null) folder.parentId = parentId;
  if (icon !== null) folder.icon = icon;
  if (color !== null) folder.color = color;
  return folder;
}

export function newFolderItem(folderId: string | null, itemType: string, itemId: string, cachedPath: string | null = null): VfsFolderItem {
  const item: VfsFolderItem = {
    id: `fi_${nanoid(10)}`, itemType, itemId, sortOrder: 0, createdAt: Date.now(),
  };
  if (folderId !== null) item.folderId = folderId;
  if (cachedPath !== null) item.cachedPath = cachedPath;
  return item;
}

export class FolderRepo implements FolderRepository {
  private readonly deps: FolderCascadeDependencies;
  private readonly pathCache = new PathCacheRepo();

  constructor(deps: FolderCascadeDependencies = {}) {
    this.deps = deps;
  }

  createFolder(conn: SqlExecutor, folder: VfsFolder): void {
    databaseResult(() => {
      const parentId = folder.parentId ?? null;
      if (parentId !== null) {
        if (!this.folderExists(conn, parentId)) {
          throw invalidParent(parentId, 'Parent folder does not exist');
        }
        const depth = this.getFolderDepth(conn, parentId);
        if (depth >= MAX_FOLDER_DEPTH) throw depthExceeded(folder.id, depth + 1, MAX_FOLDER_DEPTH);
      }
      const count = this.countAllFolders(conn);
      if (count >= MAX_FOLDERS_COUNT) throw countExceeded(count, MAX_FOLDERS_COUNT);
      conn.run(`INSERT INTO folders (id, parent_id, title, icon, color, is_expanded, sort_order, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`, [
        folder.id, parentId, folder.title, folder.icon ?? null, folder.color ?? null,
        folder.isExpanded ? 1 : 0, folder.sortOrder, folder.createdAt, folder.updatedAt,
      ]);
    });
  }

  getFolder(conn: SqlExecutor, folderId: string): VfsFolder | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${FOLDER_COLUMNS} FROM folders WHERE id = ?1`, [folderId]);
      return row === undefined ? null : rowToFolder(row);
    });
  }

  folderExists(conn: SqlExecutor, folderId: string): boolean {
    return databaseResult(() => (conn.pluck<number>(
      'SELECT COUNT(*) FROM folders WHERE id = ?1 AND deleted_at IS NULL', [folderId]) ?? 0) > 0);
  }

  getFolderDepth(conn: SqlExecutor, folderId: string): number {
    return databaseResult(() => {
      const row = conn.get<{ depth: number }>(`WITH RECURSIVE folder_path AS (
          SELECT id, parent_id, 1 as depth FROM folders WHERE id = ?1
          UNION ALL
          SELECT f.id, f.parent_id, fp.depth + 1 FROM folders f JOIN folder_path fp ON f.id = fp.parent_id
          WHERE fp.depth < ?2
        ) SELECT COALESCE(MAX(depth), 0) AS depth FROM folder_path`, [folderId, MAX_FOLDER_DEPTH + 1]);
      return Number(row?.depth ?? 0);
    });
  }

  countAllFolders(conn: SqlExecutor): number {
    return databaseResult(() => Number(conn.pluck<number>(
      'SELECT COUNT(*) FROM folders WHERE deleted_at IS NULL') ?? 0));
  }

  listAllFolders(conn: SqlExecutor): VfsFolder[] {
    return databaseResult(() => conn.all(`SELECT ${FOLDER_COLUMNS} FROM folders WHERE deleted_at IS NULL
      ORDER BY sort_order ASC, created_at ASC`).map(rowToFolder));
  }

  listFoldersByParent(conn: SqlExecutor, parentId: string | null): VfsFolder[] {
    return databaseResult(() => conn.all(`SELECT ${FOLDER_COLUMNS} FROM folders
      WHERE parent_id IS ?1 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, [parentId])
      .map(rowToFolder));
  }

  getResourceLocation(conn: SqlExecutor, itemType: string, itemId: string): ResourceLocation | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${FOLDER_ITEM_COLUMNS} FROM folder_items
        WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL`, [itemType, itemId]);
      if (row === undefined) return null;
      const folderItem = rowToFolderItem(row);
      const name = this.getItemTitle(conn, itemType, itemId);
      const hash = this.getItemHash(conn, itemType, itemId);
      let folderPath = '';
      let fullPath = name;
      if (folderItem.folderId !== undefined) {
        folderPath = this.buildFolderPath(conn, folderItem.folderId);
        fullPath = folderPath === '' ? name : `${folderPath}/${name}`;
      }
      const location: ResourceLocation = {
        id: itemId, resourceType: itemType, folderPath, fullPath,
      };
      if (folderItem.folderId !== undefined) location.folderId = folderItem.folderId;
      if (hash !== null) location.hash = hash;
      return location;
    });
  }

  private getItemHash(conn: SqlExecutor, itemType: string, itemId: string): string | null {
    const named = (sql: string, alias = 'value'): string | null => {
      const row = conn.get<Record<string, SqlValue>>(sql, [itemId]);
      if (row === undefined) return null;
      const value = row[alias];
      return typeof value === 'string' ? value : null;
    };
    switch (itemType) {
      case 'note': return named('SELECT r.hash AS value FROM notes n JOIN resources r ON n.resource_id = r.id WHERE n.id = ?1');
      case 'textbook': return named('SELECT sha256 AS value FROM files WHERE id = ?1');
      case 'file': return named('SELECT sha256 AS value FROM files WHERE id = ?1');
      case 'exam': {
        try { return named('SELECT r.hash AS value FROM exam_sheets e JOIN resources r ON e.resource_id = r.id WHERE e.id = ?1'); }
        catch (error) { logWarn('[VFS::FolderRepo] Failed to read exam hash:', error); return null; }
      }
      case 'translation': return named('SELECT r.hash AS value FROM translations t JOIN resources r ON t.resource_id = r.id WHERE t.id = ?1');
      case 'essay': return named('SELECT r.hash AS value FROM essays e JOIN resources r ON e.resource_id = r.id WHERE e.id = ?1');
      case 'mindmap': return named('SELECT r.hash AS value FROM mindmaps m JOIN resources r ON m.resource_id = r.id WHERE m.id = ?1');
      default:
        logWarn(`[VfsFolderRepo] Unknown item_type for hash: ${itemType}`);
        return null;
    }
  }

  getFolderItemByItemId(conn: SqlExecutor, itemType: string, itemId: string): VfsFolderItem | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${FOLDER_ITEM_COLUMNS} FROM folder_items
        WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL`, [itemType, itemId]);
      return row === undefined ? null : rowToFolderItem(row);
    });
  }

  getFolderItemByCachedPath(conn: SqlExecutor, cachedPath: string): VfsFolderItem | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${FOLDER_ITEM_COLUMNS} FROM folder_items
        WHERE cached_path = ?1 AND deleted_at IS NULL`, [cachedPath]);
      return row === undefined ? null : rowToFolderItem(row);
    });
  }

  removeItemByItemId(conn: SqlExecutor, itemType: string, itemId: string): boolean {
    return databaseResult(() => conn.run('DELETE FROM folder_items WHERE item_id = ?1 AND item_type = ?2',
      [itemId, canonicalType(itemType)]).changes > 0);
  }

  listItemsByFolder(conn: SqlExecutor, folderId: string | null): VfsFolderItem[] {
    return databaseResult(() => conn.all(`SELECT ${FOLDER_ITEM_COLUMNS} FROM folder_items
      WHERE folder_id IS ?1 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, [folderId])
      .map(row => rowToFolderItem(row)));
  }

  listAllAssignedItemIds(conn: SqlExecutor): Set<string> {
    return databaseResult(() => new Set(conn.all<{ item_id: string }>(
      'SELECT DISTINCT item_id FROM folder_items WHERE deleted_at IS NULL').map(row => row.item_id)));
  }

  moveItemByItemId(conn: SqlExecutor, itemType: string, itemId: string, newFolderId: string | null): void {
    databaseResult(() => {
      if (newFolderId !== null && !this.folderExists(conn, newFolderId)) {
        throw folderNotFound(newFolderId);
      }
      const affected = conn.run(`UPDATE folder_items SET folder_id = ?1, cached_path = NULL
        WHERE item_id = ?2 AND item_type = ?3 AND deleted_at IS NULL`,
      [newFolderId, itemId, canonicalType(itemType)]).changes;
      if (affected === 0) throw itemNotFound(itemType, itemId);
      this.markItemIndexesPending(conn, itemId);
    });
  }

  moveItemsBatch(conn: SqlExecutor, items: readonly (readonly [string, string])[], newFolderId: string | null): number {
    return databaseResult(() => {
      if (items.length === 0) return 0;
      if (newFolderId !== null && !this.folderExists(conn, newFolderId)) {
        throw folderNotFound(newFolderId);
      }
      const byType = new Map<string, string[]>();
      for (const [itemType, itemId] of items) {
        const bucket = byType.get(itemType);
        if (bucket === undefined) byType.set(itemType, [itemId]);
        else bucket.push(itemId);
      }
      let totalAffected = 0;
      for (const [itemType, itemIds] of byType) {
        for (let start = 0; start < itemIds.length; start += MAX_BATCH_SIZE) {
          const chunk = itemIds.slice(start, start + MAX_BATCH_SIZE);
          const sql = `UPDATE folder_items SET folder_id = ?1, cached_path = NULL
            WHERE item_type = ?2 AND item_id IN (${placeholders(chunk.length, 2)})`;
          const affected = conn.run(sql, [newFolderId, itemType, ...chunk]).changes;
          totalAffected += affected;
          if (affected > 0) {
            for (const itemId of chunk) this.markItemIndexesPending(conn, itemId);
          }
        }
      }
      return totalAffected;
    });
  }

  updateFolder(conn: SqlExecutor, folder: VfsFolder): void {
    databaseResult(() => {
      const now = Date.now();
      const affected = conn.run(`UPDATE folders
        SET parent_id = ?1, title = ?2, icon = ?3, color = ?4, is_expanded = ?5, sort_order = ?6, updated_at = ?7
        WHERE id = ?8`, [
        folder.parentId ?? null, folder.title, folder.icon ?? null, folder.color ?? null,
        folder.isExpanded ? 1 : 0, folder.sortOrder, now, folder.id,
      ]).changes;
      if (affected === 0) throw folderNotFound(folder.id);
      const folderIds = this.getFolderIdsRecursive(conn, folder.id);
      if (folderIds.length > 0) {
        executeUpdateInBatches(conn, folderIds,
          'UPDATE folder_items SET cached_path = NULL WHERE folder_id IN ({})');
        try { this.pathCache.invalidateByFoldersBatch(conn, folderIds); }
        catch (error) { logWarn(`[VFS::FolderRepo] Failed to invalidate path_cache for ${folderIds.length} folders:`, error); }
      }
    });
  }

  renameFolderIfVersion(conn: SqlExecutor, folderId: string, title: string, expectedUpdatedAt: number): void {
    databaseResult(() => {
      const now = Math.max(Date.now(), expectedUpdatedAt + 1);
      const affected = conn.run(`UPDATE folders SET title = ?1, updated_at = ?2
        WHERE id = ?3 AND deleted_at IS NULL AND updated_at = ?4`,
      [title, now, folderId, expectedUpdatedAt]).changes;
      if (affected === 0) {
        const exists = Number(conn.pluck<number>(
          'SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1 AND deleted_at IS NULL)', [folderId]) ?? 0) !== 0;
        if (!exists) throw folderNotFound(folderId);
        throw conflict('folders.conflict', `Folder ${folderId} changed before the rename could be applied`);
      }
      const folderIds = this.getFolderIdsRecursive(conn, folderId);
      if (folderIds.length > 0) {
        executeUpdateInBatches(conn, folderIds,
          'UPDATE folder_items SET cached_path = NULL WHERE folder_id IN ({})');
        try { this.pathCache.invalidateByFoldersBatch(conn, folderIds); }
        catch (error) { logWarn(`[VFS::FolderRepo] Failed to invalidate path_cache after rename for ${folderIds.length} folders:`, error); }
      }
    });
  }

  deleteFolder(conn: SqlExecutor, folderId: string): void {
    databaseResult(() => withSavepoint(conn, 'vfs_folder_delete_tx', () => {
      const nowStr = utcTimestamp();
      const nowMs = Date.now();
      const affected = conn.run(`UPDATE folders SET deleted_at = ?1, updated_at = ?2
        WHERE id = ?3 AND deleted_at IS NULL`, [nowStr, nowMs, folderId]).changes;
      if (affected === 0) {
        const alreadyDeleted = Number(conn.pluck<number>(
          'SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1 AND deleted_at IS NOT NULL)', [folderId]) ?? 0) !== 0;
        if (alreadyDeleted) return;
        throw folderNotFound(folderId);
      }
      conn.run(`WITH RECURSIVE descendants AS (
          SELECT id FROM folders WHERE parent_id = ?1 AND deleted_at IS NULL
          UNION ALL
          SELECT f.id FROM folders f INNER JOIN descendants d ON f.parent_id = d.id
          WHERE f.deleted_at IS NULL
        ) UPDATE folders SET deleted_at = ?2, updated_at = ?3 WHERE id IN (SELECT id FROM descendants)`,
      [folderId, nowStr, nowMs]);
      conn.run(`WITH RECURSIVE all_folders AS (
          SELECT ?1 as id
          UNION ALL
          SELECT f.id FROM folders f INNER JOIN all_folders af ON f.parent_id = af.id
        ) UPDATE folder_items SET deleted_at = ?2, updated_at = ?3
        WHERE folder_id IN (SELECT id FROM all_folders) AND deleted_at IS NULL`,
      [folderId, nowStr, nowMs]);
      const folderIds = this.getFolderIdsForPurge(conn, folderId);
      this.cascadeSoftDeleteFolderResources(conn, folderIds);
    }));
  }

  purgeFolder(conn: SqlExecutor, folderId: string, blobsDir?: string): void {
    databaseResult(() => {
      withSavepoint(conn, 'vfs_folder_purge_tx', () => {
        const folderExists = Number(conn.pluck<number>(
          'SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1)', [folderId]) ?? 0) !== 0;
        if (!folderExists) throw folderNotFound(folderId);
        const folderIds = this.getFolderIdsForPurge(conn, folderId);
        for (const descendantId of folderIds) {
          const isTrashed = Number(conn.pluck<number>(
            'SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1 AND deleted_at IS NOT NULL)', [descendantId]) ?? 0) !== 0;
          if (!isTrashed) {
            throw conflict('folders.purge_conflict',
              `Folder ${descendantId} was restored before its parent folder could be purged`);
          }
        }
        this.purgeFolderTreeResources(conn, blobsDir, folderIds);
        conn.run('DELETE FROM folders WHERE id = ?1', [folderId]);
      });
      try { this.deps.cleanupUnreferencedBlobs?.(conn, blobsDir); }
      catch (error) { logWarn('[VFS::FolderRepo] Post-purge blob sweep failed (will retry on next sweep):', error); }
    });
  }

  restoreFolder(conn: SqlExecutor, folderId: string): void {
    databaseResult(() => withSavepoint(conn, 'vfs_folder_restore_tx', () => {
      const nowTs = Date.now();
      const folder = this.getFolder(conn, folderId);
      if (folder === null) throw folderNotFound(folderId);
      let targetParentId: string | null = null;
      if (folder.parentId !== undefined) {
        const parentActive = conn.get('SELECT 1 FROM folders WHERE id = ?1 AND deleted_at IS NULL', [folder.parentId]) !== undefined;
        if (parentActive) targetParentId = folder.parentId;
      }
      const newTitle = this.generateUniqueFolderTitle(conn, folder.title, targetParentId, folderId);
      const affected = conn.run(`UPDATE folders SET deleted_at = NULL, title = ?1, parent_id = ?2, updated_at = ?3
        WHERE id = ?4 AND deleted_at IS NOT NULL`, [newTitle, targetParentId, nowTs, folderId]).changes;
      if (affected === 0) throw folderNotFound(folderId);
      conn.run(`WITH RECURSIVE descendants AS (
          SELECT id FROM folders WHERE parent_id = ?1 AND deleted_at IS NOT NULL
          UNION ALL
          SELECT f.id FROM folders f INNER JOIN descendants d ON f.parent_id = d.id
          WHERE f.deleted_at IS NOT NULL
        ) UPDATE folders SET deleted_at = NULL, updated_at = ?2 WHERE id IN (SELECT id FROM descendants)`,
      [folderId, nowTs]);
      conn.run(`WITH RECURSIVE all_folders AS (
          SELECT ?1 as id
          UNION ALL
          SELECT f.id FROM folders f INNER JOIN all_folders af ON f.parent_id = af.id
        ) UPDATE folder_items SET deleted_at = NULL, updated_at = ?2
        WHERE folder_id IN (SELECT id FROM all_folders) AND deleted_at IS NOT NULL`,
      [folderId, nowTs]);
      const folderIds = this.getFolderIdsForPurge(conn, folderId);
      this.cascadeRestoreFolderResources(conn, folderIds);
    }));
  }

  generateUniqueFolderTitle(conn: SqlExecutor, baseTitle: string, parentId: string | null, excludeId: string | null): string {
    return databaseResult(() => {
      if (!this.folderTitleExists(conn, baseTitle, parentId, excludeId)) return baseTitle;
      for (let index = 1; index < 100; index++) {
        const candidate = `${baseTitle} (${index})`;
        if (!this.folderTitleExists(conn, candidate, parentId, excludeId)) return candidate;
      }
      return `${baseTitle} (${Date.now()})`;
    });
  }

  private folderTitleExists(conn: SqlExecutor, title: string, parentId: string | null, excludeId: string | null): boolean {
    let count: number;
    if (parentId !== null) {
      count = excludeId !== null
        ? Number(conn.pluck<number>(
          'SELECT COUNT(*) FROM folders WHERE title = ?1 AND parent_id = ?2 AND deleted_at IS NULL AND id != ?3',
          [title, parentId, excludeId]) ?? 0)
        : Number(conn.pluck<number>(
          'SELECT COUNT(*) FROM folders WHERE title = ?1 AND parent_id = ?2 AND deleted_at IS NULL',
          [title, parentId]) ?? 0);
    } else {
      count = excludeId !== null
        ? Number(conn.pluck<number>(
          'SELECT COUNT(*) FROM folders WHERE title = ?1 AND parent_id IS NULL AND deleted_at IS NULL AND id != ?2',
          [title, excludeId]) ?? 0)
        : Number(conn.pluck<number>(
          'SELECT COUNT(*) FROM folders WHERE title = ?1 AND parent_id IS NULL AND deleted_at IS NULL',
          [title]) ?? 0);
    }
    return count > 0;
  }

  listDeletedFolders(conn: SqlExecutor, limit: number, offset: number): VfsFolder[] {
    return databaseResult(() => conn.all(`SELECT ${FOLDER_COLUMNS} FROM folders
      WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?1 OFFSET ?2`, [limit, offset])
      .map(rowToFolder));
  }

  purgeDeletedFolders(conn: SqlExecutor, blobsDir?: string): number {
    return databaseResult(() => {
      const folderIds = conn.all<{ id: string }>(`SELECT id FROM folders
        WHERE deleted_at IS NOT NULL
          AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM folders WHERE deleted_at IS NOT NULL))`)
        .map(row => row.id);
      for (const folderId of folderIds) this.purgeFolder(conn, folderId, blobsDir);
      return folderIds.length;
    });
  }

  private itemHasExternalLiveMembership(conn: SqlExecutor, itemId: string, folderIdSet: ReadonlySet<string>): boolean {
    const rows = conn.all<{ folder_id: string | null }>(
      'SELECT folder_id FROM folder_items WHERE item_id = ?1 AND deleted_at IS NULL', [itemId]);
    return rows.some(row => row.folder_id === null || !folderIdSet.has(row.folder_id));
  }

  private isFolderItemEntityTrashed(conn: SqlExecutor, itemType: string, itemId: string): boolean {
    let sql: string;
    switch (itemType) {
      case 'note': sql = 'SELECT deleted_at IS NOT NULL AS trashed FROM notes WHERE id = ?1'; break;
      case 'file':
      case 'image': sql = "SELECT status = 'deleted' OR deleted_at IS NOT NULL AS trashed FROM files WHERE id = ?1"; break;
      case 'exam': sql = 'SELECT deleted_at IS NOT NULL AS trashed FROM exam_sheets WHERE id = ?1'; break;
      case 'translation': sql = 'SELECT deleted_at IS NOT NULL AS trashed FROM translations WHERE id = ?1'; break;
      case 'essay':
        sql = itemId.startsWith('essay_session_')
          ? 'SELECT deleted_at IS NOT NULL AS trashed FROM essay_sessions WHERE id = ?1'
          : 'SELECT deleted_at IS NOT NULL AS trashed FROM essays WHERE id = ?1';
        break;
      case 'mindmap': sql = 'SELECT deleted_at IS NOT NULL AS trashed FROM mindmaps WHERE id = ?1'; break;
      default: return false;
    }
    const row = conn.get<{ trashed: number }>(sql, [itemId]);
    return row === undefined ? false : Number(row.trashed) !== 0;
  }

  private resolveAdapter(itemType: string, itemId: string): FolderEntityAdapter | null {
    const key = itemType === 'essay' && itemId.startsWith('essay_session_') ? 'essay_session' : itemType;
    const adapter = this.deps.adapters?.[key];
    if (adapter !== undefined) return adapter;
    if (SUPPORTED_CASCADE_TYPES.has(key)) {
      throw new VfsRepositoryError('VFS_INTERNAL',
        `Folder cascade for item type '${key}' requires a repository adapter that is not wired`);
    }
    return null;
  }

  private softDeleteFolderItemEntity(conn: SqlExecutor, itemType: string, itemId: string): void {
    const adapter = this.resolveAdapter(itemType, itemId);
    if (adapter === null) {
      logWarn(`[VFS::FolderRepo] Skipping unsupported folder item during cascade delete: type=${itemType}, id=${itemId}`);
      return;
    }
    adapter.softDelete(conn, itemId);
  }

  private restoreFolderItemEntityIfTrashed(conn: SqlExecutor, itemType: string, itemId: string): void {
    if (!this.isFolderItemEntityTrashed(conn, itemType, itemId)) return;
    const adapter = this.resolveAdapter(itemType, itemId);
    if (adapter === null) {
      logWarn(`[VFS::FolderRepo] Skipping unsupported folder item during cascade restore: type=${itemType}, id=${itemId}`);
      return;
    }
    try { adapter.restore(conn, itemId); }
    catch (error) {
      if (error instanceof VfsRepositoryError && error.code === 'VFS_NOT_FOUND') return;
      throw error;
    }
  }

  private cascadeSoftDeleteFolderResources(conn: SqlExecutor, folderIds: readonly string[]): void {
    if (folderIds.length === 0) return;
    const folderIdSet = new Set(folderIds);
    const items = this.getItemsByFoldersIncludingDeleted(conn, folderIds);
    const seen = new Set<string>();
    for (const item of items) {
      const itemType = canonicalType(item.itemType);
      const key = `${itemType}\u0000${item.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (this.itemHasExternalLiveMembership(conn, item.itemId, folderIdSet)) continue;
      this.softDeleteFolderItemEntity(conn, itemType, item.itemId);
    }
  }

  private cascadeRestoreFolderResources(conn: SqlExecutor, folderIds: readonly string[]): void {
    if (folderIds.length === 0) return;
    const items = this.getItemsByFoldersIncludingDeleted(conn, folderIds);
    const seen = new Set<string>();
    for (const item of items) {
      const itemType = canonicalType(item.itemType);
      const key = `${itemType}\u0000${item.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.restoreFolderItemEntityIfTrashed(conn, itemType, item.itemId);
    }
  }

  private getFolderIdsForPurge(conn: SqlExecutor, folderId: string): string[] {
    return conn.all<{ id: string }>(`WITH RECURSIVE folder_tree AS (
        SELECT id, parent_id, 0 as depth FROM folders WHERE id = ?1
        UNION ALL
        SELECT f.id, f.parent_id, ft.depth + 1 FROM folders f
        JOIN folder_tree ft ON f.parent_id = ft.id WHERE ft.depth < ?2
      ) SELECT id FROM folder_tree`, [folderId, MAX_FOLDER_DEPTH]).map(row => row.id);
  }

  private purgeFolderTreeResources(conn: SqlExecutor, blobsDir: string | undefined, folderIds: readonly string[]): void {
    if (folderIds.length === 0) return;
    const folderIdSet = new Set(folderIds);
    const items = this.getItemsByFoldersIncludingDeleted(conn, folderIds);
    const seen = new Set<string>();
    for (const item of items) {
      const itemType = canonicalType(item.itemType);
      const key = `${itemType}\u0000${item.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!SUPPORTED_CASCADE_TYPES.has(itemType)) {
        logWarn(`[VFS::FolderRepo] Skipping unsupported folder item during purge: type=${itemType}, id=${item.itemId}`);
        continue;
      }
      const linkTrashed = Number(conn.pluck<number>(
        'SELECT deleted_at IS NOT NULL FROM folder_items WHERE id = ?1', [item.id]) ?? 0) !== 0;
      const externalLive = this.itemHasExternalLiveMembership(conn, item.itemId, folderIdSet);
      if (!linkTrashed || externalLive) {
        throw conflict('folders.purge_conflict',
          `Resource ${itemType}:${item.itemId} was restored before its parent folder could be purged`);
      }
      if (!this.isFolderItemEntityTrashed(conn, itemType, item.itemId)) {
        conn.run('DELETE FROM folder_items WHERE id = ?1', [item.id]);
        continue;
      }
      const adapter = this.resolveAdapter(itemType, item.itemId);
      if (adapter === null) continue;
      adapter.purge(conn, item.itemId, blobsDir);
    }
  }

  private getItemsByFoldersIncludingDeleted(conn: SqlExecutor, folderIds: readonly string[]): VfsFolderItem[] {
    return queryInBatches(conn, folderIds,
      `SELECT ${FOLDER_ITEM_COLUMNS} FROM folder_items WHERE folder_id IN ({})`,
      row => rowToFolderItem(row));
  }

  setFolderExpanded(conn: SqlExecutor, folderId: string, isExpanded: boolean): void {
    databaseResult(() => {
      const affected = conn.run('UPDATE folders SET is_expanded = ?1, updated_at = ?2 WHERE id = ?3',
        [isExpanded ? 1 : 0, Date.now(), folderId]).changes;
      if (affected === 0) throw folderNotFound(folderId);
    });
  }

  setFavorite(conn: SqlExecutor, folderId: string, favorite: boolean): void {
    databaseResult(() => {
      const affected = conn.run('UPDATE folders SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3',
        [favorite ? 1 : 0, Date.now(), folderId]).changes;
      if (affected === 0) throw folderNotFound(folderId);
    });
  }

  moveFolder(conn: SqlExecutor, folderId: string, newParentId: string | null): void {
    databaseResult(() => {
      const folder = this.getFolder(conn, folderId);
      if (folder === null) throw folderNotFound(folderId);
      if (newParentId !== null) {
        if (!this.folderExists(conn, newParentId)) {
          throw invalidParent(newParentId, 'Target parent folder does not exist');
        }
        const descendantIds = this.getFolderIdsRecursive(conn, folderId);
        if (descendantIds.includes(newParentId)) {
          throw invalidParent(newParentId, 'Cannot move folder to its own descendant');
        }
        const parentDepth = this.getFolderDepth(conn, newParentId);
        const subtreeDepth = this.getSubtreeDepth(conn, folderId);
        if (parentDepth + subtreeDepth >= MAX_FOLDER_DEPTH) {
          throw depthExceeded(folderId, parentDepth + subtreeDepth, MAX_FOLDER_DEPTH);
        }
      }
      conn.run('UPDATE folders SET parent_id = ?1, updated_at = ?2 WHERE id = ?3',
        [newParentId, Date.now(), folderId]);
      const folderIds = this.getFolderIdsRecursive(conn, folderId);
      if (folderIds.length > 0) {
        executeUpdateInBatches(conn, folderIds,
          'UPDATE folder_items SET cached_path = NULL WHERE folder_id IN ({})');
        try { this.pathCache.invalidateByFoldersBatch(conn, folderIds); }
        catch (error) { logWarn(`[VFS::FolderRepo] Failed to invalidate path_cache for ${folderIds.length} folders:`, error); }
      }
    });
  }

  private getSubtreeDepth(conn: SqlExecutor, folderId: string): number {
    const row = conn.get<{ depth: number }>(`WITH RECURSIVE folder_tree AS (
        SELECT id, parent_id, 1 as depth FROM folders WHERE id = ?1
        UNION ALL
        SELECT f.id, f.parent_id, ft.depth + 1 FROM folders f JOIN folder_tree ft ON f.parent_id = ft.id
        WHERE ft.depth < ?2
      ) SELECT COALESCE(MAX(depth), 1) AS depth FROM folder_tree`, [folderId, MAX_FOLDER_DEPTH + 1]);
    return Number(row?.depth ?? 1);
  }

  getFolderIdsRecursive(conn: SqlExecutor, folderId: string): string[] {
    return databaseResult(() => conn.all<{ id: string }>(`WITH RECURSIVE folder_tree AS (
        SELECT id, parent_id, title, 0 as depth FROM folders WHERE id = ?1 AND deleted_at IS NULL
        UNION ALL
        SELECT f.id, f.parent_id, f.title, ft.depth + 1 FROM folders f
        JOIN folder_tree ft ON f.parent_id = ft.id
        WHERE ft.depth < ?2 AND f.deleted_at IS NULL
      ) SELECT id FROM folder_tree`, [folderId, MAX_FOLDER_DEPTH]).map(row => row.id));
  }

  getItemsByFolders(conn: SqlExecutor, folderIds: readonly string[]): VfsFolderItem[] {
    return databaseResult(() => {
      const items = queryInBatches(conn, folderIds,
        `SELECT ${FOLDER_ITEM_COLUMNS} FROM folder_items WHERE folder_id IN ({}) AND deleted_at IS NULL`,
        row => rowToFolderItem(row));
      items.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
      return items;
    });
  }

  buildFolderPath(conn: SqlExecutor, folderId: string): string {
    return databaseResult(() => conn.all<{ title: string }>(`WITH RECURSIVE folder_path AS (
        SELECT id, parent_id, title, 1 as depth FROM folders WHERE id = ?1
        UNION ALL
        SELECT f.id, f.parent_id, f.title, fp.depth + 1 FROM folders f
        JOIN folder_path fp ON f.id = fp.parent_id WHERE fp.depth < ?2
      ) SELECT title FROM folder_path ORDER BY depth DESC`, [folderId, MAX_FOLDER_DEPTH + 1])
      .map(row => row.title).join('/'));
  }

  buildResourcePath(conn: SqlExecutor, item: VfsFolderItem): string {
    return databaseResult(() => {
      const title = this.getItemTitle(conn, item.itemType, item.itemId);
      if (item.folderId !== undefined) {
        const folderPath = this.buildFolderPath(conn, item.folderId);
        return `${folderPath}/${title}`;
      }
      return title;
    });
  }

  private getItemTitle(conn: SqlExecutor, itemType: string, itemId: string): string {
    const lookup = (sql: string): string | null => {
      const row = conn.get<{ value: string | null }>(sql, [itemId]);
      if (row === undefined) return null;
      return typeof row.value === 'string' ? row.value : null;
    };
    let title: string | null;
    switch (itemType) {
      case 'note': title = lookup('SELECT title AS value FROM notes WHERE id = ?1'); break;
      case 'textbook': title = lookup('SELECT file_name AS value FROM files WHERE id = ?1'); break;
      case 'file': title = lookup('SELECT file_name AS value FROM files WHERE id = ?1'); break;
      case 'exam': title = lookup('SELECT COALESCE(exam_name, id) AS value FROM exam_sheets WHERE id = ?1'); break;
      case 'translation': title = lookup('SELECT COALESCE(title, id) AS value FROM translations WHERE id = ?1'); break;
      case 'essay': title = lookup('SELECT COALESCE(title, id) AS value FROM essays WHERE id = ?1'); break;
      case 'mindmap': title = lookup('SELECT title AS value FROM mindmaps WHERE id = ?1'); break;
      default:
        logWarn(`[VfsFolderRepo] Unknown item_type: ${itemType}`);
        return itemId;
    }
    return title ?? itemId;
  }

  getBreadcrumbs(conn: SqlExecutor, folderId: string): VfsBreadcrumbItem[] {
    return getBreadcrumbs(conn, folderId);
  }

  getFolderTree(conn: SqlExecutor): FolderTreeNode[] {
    return databaseResult(() => {
      const folders = this.listFoldersByParent(conn, null);
      return this.buildTreeRecursive(conn, folders, null);
    });
  }

  private buildTreeRecursive(conn: SqlExecutor, allFolders: readonly VfsFolder[], parentId: string | null): FolderTreeNode[] {
    const nodes: FolderTreeNode[] = [];
    for (const folder of allFolders) {
      if ((folder.parentId ?? null) === parentId) {
        const children = this.buildTreeRecursive(conn, allFolders, folder.id);
        const items = this.listItemsByFolder(conn, folder.id);
        nodes.push({ folder, children, items });
      }
    }
    nodes.sort((a, b) => a.folder.sortOrder - b.folder.sortOrder);
    return nodes;
  }

  getFolderTreeAll(conn: SqlExecutor): FolderTreeNode[] {
    return databaseResult(() => {
      const folders = this.listAllFolders(conn);
      return this.buildTreeRecursiveAll(conn, folders, null);
    });
  }

  private buildTreeRecursiveAll(conn: SqlExecutor, allFolders: readonly VfsFolder[], parentId: string | null): FolderTreeNode[] {
    const nodes: FolderTreeNode[] = [];
    for (const folder of allFolders) {
      if ((folder.parentId ?? null) === parentId) {
        const children = this.buildTreeRecursiveAll(conn, allFolders, folder.id);
        const items = this.getFolderItemsAll(conn, folder.id);
        nodes.push({ folder, children, items });
      }
    }
    nodes.sort((a, b) => a.folder.sortOrder - b.folder.sortOrder);
    return nodes;
  }

  getFolderItemsAll(conn: SqlExecutor, folderId: string | null): VfsFolderItem[] {
    return databaseResult(() => conn.all(`SELECT id, item_type, item_id, folder_id, sort_order, cached_path, created_at
      FROM folder_items WHERE folder_id IS ?1 AND deleted_at IS NULL ORDER BY sort_order ASC`, [folderId])
      .map(row => rowToFolderItem(row, 6)));
  }

  removeItemFromFolder(conn: SqlExecutor, itemType: string, itemId: string): void {
    databaseResult(() => {
      conn.run('DELETE FROM folder_items WHERE item_id = ?1 AND item_type = ?2', [itemId, canonicalType(itemType)]);
    });
  }

  moveItemToFolder(conn: SqlExecutor, itemType: string, itemId: string, newFolderId: string | null): void {
    databaseResult(() => {
      const canonical = canonicalType(itemType);
      if (newFolderId !== null && !this.folderExists(conn, newFolderId)) {
        throw folderNotFound(newFolderId);
      }
      const affected = conn.run(`UPDATE folder_items SET folder_id = ?1, cached_path = NULL
        WHERE item_id = ?2 AND item_type = ?3 AND deleted_at IS NULL`, [newFolderId, itemId, canonical]).changes;
      if (affected === 0) {
        const fiId = `fi_${nanoid(10)}`;
        conn.run(`INSERT INTO folder_items (id, item_type, item_id, folder_id, sort_order, cached_path, created_at)
          VALUES (?1, ?2, ?3, ?4, 0, NULL, ?5)`, [fiId, canonical, itemId, newFolderId, Date.now()]);
      }
      this.markItemIndexesPending(conn, itemId);
    });
  }

  private markItemIndexesPending(conn: SqlExecutor, itemId: string): void {
    conn.run(`UPDATE resources SET
        index_state = CASE WHEN index_state = 'disabled' THEN 'disabled' ELSE 'pending' END,
        index_hash = CASE WHEN index_state = 'disabled' THEN index_hash ELSE NULL END,
        index_error = CASE WHEN index_state = 'disabled' THEN index_error ELSE NULL END,
        indexed_at = CASE WHEN index_state = 'disabled' THEN indexed_at ELSE NULL END,
        index_retry_count = CASE WHEN index_state = 'disabled' THEN index_retry_count ELSE 0 END,
        index_next_retry_at = CASE WHEN index_state = 'disabled' THEN index_next_retry_at ELSE 0 END,
        mm_index_state = CASE WHEN mm_index_state IS NULL OR mm_index_state = 'disabled'
          THEN mm_index_state ELSE 'pending' END,
        mm_index_error = CASE WHEN mm_index_state IS NULL OR mm_index_state = 'disabled'
          THEN mm_index_error ELSE NULL END,
        mm_indexed_at = CASE WHEN mm_index_state IS NULL OR mm_index_state = 'disabled'
          THEN mm_indexed_at ELSE NULL END,
        mm_index_retry_count = CASE WHEN mm_index_state IS NULL OR mm_index_state = 'disabled'
          THEN mm_index_retry_count ELSE 0 END,
        mm_index_next_retry_at = CASE WHEN mm_index_state IS NULL OR mm_index_state = 'disabled'
          THEN mm_index_next_retry_at ELSE 0 END,
        updated_at = ?2
      WHERE id = ?1 OR source_id = ?1`, [itemId, Date.now()]);
  }

  reorderFolders(conn: SqlExecutor, folderIds: readonly string[]): void {
    databaseResult(() => {
      const now = Date.now();
      const items = folderIds.map((id, index) => [id, index] as const);
      executeReorderInBatches(conn, items, 'folders', now);
    });
  }

  reorderItems(conn: SqlExecutor, _folderId: string | null, itemIds: readonly string[]): void {
    databaseResult(() => {
      const now = Date.now();
      const items = itemIds.map((id, index) => [id, index] as const);
      executeReorderInBatches(conn, items, 'folder_items', now);
    });
  }

  countItemsInFolder(conn: SqlExecutor, folderId: string | null): number {
    return databaseResult(() => Number(conn.pluck<number>(
      'SELECT COUNT(*) FROM folder_items WHERE folder_id IS ?1 AND deleted_at IS NULL', [folderId]) ?? 0));
  }

  getAllResources(conn: SqlExecutor, folderId: string, includeSubfolders: boolean, includeContent: boolean): FolderResourcesResult {
    return databaseResult(() => {
      const folder = this.getFolder(conn, folderId);
      if (folder === null) throw resourceNotFound('Folder', folderId);
      const folderPath = this.buildFolderPath(conn, folderId);
      const folderIds = includeSubfolders ? this.getFolderIdsRecursive(conn, folderId) : [folderId];
      const items = this.getItemsByFolders(conn, folderIds);
      const resources = items.map(item => this.buildResourceInfo(conn, item, includeContent));
      return {
        folderId, folderTitle: folder.title, path: folderPath,
        totalCount: resources.length, resources,
      };
    });
  }

  private buildResourceInfo(conn: SqlExecutor, item: VfsFolderItem, includeContent: boolean): FolderResourceInfo {
    const title = this.getItemTitle(conn, item.itemType, item.itemId);
    const path = this.buildResourcePath(conn, item);
    const resourceId = this.getItemResourceId(conn, item.itemType, item.itemId);
    const content = includeContent
      ? this.getItemContent(conn, item.itemType, item.itemId, resourceId)
      : null;
    const info: FolderResourceInfo = { itemType: item.itemType, itemId: item.itemId, title, path };
    if (resourceId !== null) info.resourceId = resourceId;
    if (content !== null) info.content = content;
    return info;
  }

  private getItemResourceId(conn: SqlExecutor, itemType: string, itemId: string): string | null {
    const lookup = (sql: string): string | null => {
      const row = conn.get<{ value: string | null }>(sql, [itemId]);
      return row === undefined ? null : typeof row.value === 'string' ? row.value : null;
    };
    const lookupSwallowingErrors = (sql: string): string | null => {
      try { return lookup(sql); }
      catch (error) { logWarn('[VFS::FolderRepo] Failed to read resource_id:', error); return null; }
    };
    switch (itemType) {
      case 'note': return lookup('SELECT resource_id AS value FROM notes WHERE id = ?1');
      case 'textbook': return lookupSwallowingErrors('SELECT resource_id AS value FROM files WHERE id = ?1');
      case 'file': return lookupSwallowingErrors('SELECT resource_id AS value FROM files WHERE id = ?1');
      case 'exam': return lookupSwallowingErrors('SELECT resource_id AS value FROM exam_sheets WHERE id = ?1');
      case 'translation': return lookup('SELECT resource_id AS value FROM translations WHERE id = ?1');
      case 'essay': return lookup('SELECT resource_id AS value FROM essays WHERE id = ?1');
      case 'mindmap': return lookup('SELECT resource_id AS value FROM mindmaps WHERE id = ?1');
      default:
        logWarn(`[VfsFolderRepo] Unknown item_type for resource_id: ${itemType}`);
        return null;
    }
  }

  private getItemContent(conn: SqlExecutor, itemType: string, itemId: string, resourceId: string | null): string | null {
    if (resourceId !== null) {
      const row = conn.get<{ data: string | null }>('SELECT data FROM resources WHERE id = ?1', [resourceId]);
      const content = row === undefined ? null : row.data;
      if (content !== null && content !== undefined) return content;
    }
    const lookup = (sql: string): string | null => {
      const row = conn.get<{ value: string | null }>(sql, [itemId]);
      return row === undefined ? null : typeof row.value === 'string' ? row.value : null;
    };
    switch (itemType) {
      case 'note': return null;
      case 'textbook': return lookup("SELECT file_name || ' (PDF)' AS value FROM files WHERE id = ?1");
      case 'file': return lookup("SELECT file_name || ' (file)' AS value FROM files WHERE id = ?1");
      case 'exam': return lookup('SELECT preview_json AS value FROM exam_sheets WHERE id = ?1');
      case 'translation': return null;
      case 'essay': return null;
      case 'mindmap': return null;
      default:
        logWarn(`[VfsFolderRepo] Unknown item_type for content: ${itemType}`);
        return null;
    }
  }

  addItemToFolder(conn: SqlExecutor, item: VfsFolderItem): void {
    databaseResult(() => {
      const canonical = canonicalType(item.itemType);
      conn.run('DELETE FROM folder_items WHERE item_id = ?1 AND item_type = ?2', [item.itemId, canonical]);
      conn.run(`INSERT OR REPLACE INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`, [
        item.id, item.folderId ?? null, canonical, item.itemId, item.sortOrder,
        item.createdAt, item.cachedPath ?? null,
      ]);
    });
  }
}
