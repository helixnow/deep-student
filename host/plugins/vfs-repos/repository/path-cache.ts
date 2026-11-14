import { logWarn } from './logger.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { VfsRepositoryError, type PathCacheEntry, type PathCacheRepository, type PathCacheStats } from '../api.ts';
import { databaseResult, rollbackIgnoringFailure } from './errors.ts';
import { utcTimestamp } from './timestamps.ts';
import { utf8ByteLength as byteLength } from '../../../platform/util/portable.ts';

const MAX_PATH_LENGTH = 1000;
const MAX_FOLDER_DEPTH = 10;
const canonicalType = (type: string) => type === 'textbook' ? 'file' : type;
const columns = 'item_type AS itemType, item_id AS itemId, full_path AS fullPath, folder_path AS folderPath, updated_at AS updatedAt';
const upsert = `INSERT INTO path_cache (item_type, item_id, full_path, folder_path, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(item_type, item_id) DO UPDATE SET
  full_path=excluded.full_path, folder_path=excluded.folder_path, updated_at=excluded.updated_at`;

function recursiveFolderIds(conn: SqlExecutor, id: string): string[] {
  return conn.all<{ id: string }>(`WITH RECURSIVE folder_tree AS (
    SELECT id, parent_id, title, 0 as depth FROM folders WHERE id=?1 AND deleted_at IS NULL
    UNION ALL SELECT f.id, f.parent_id, f.title, ft.depth+1
    FROM folders f JOIN folder_tree ft ON f.parent_id=ft.id
    WHERE ft.depth < ?2 AND f.deleted_at IS NULL) SELECT id FROM folder_tree`, [id, MAX_FOLDER_DEPTH]).map(row => row.id);
}
function folderPath(conn: SqlExecutor, id: string): string {
  return conn.all<{ title: string }>(`WITH RECURSIVE folder_path AS (
    SELECT id, parent_id, title, 1 as depth FROM folders WHERE id=?1
    UNION ALL SELECT f.id, f.parent_id, f.title, fp.depth+1
    FROM folders f JOIN folder_path fp ON f.id=fp.parent_id WHERE fp.depth < ?2)
    SELECT title FROM folder_path ORDER BY depth DESC`, [id, MAX_FOLDER_DEPTH + 1]).map(row => row.title).join('/');
}
function folderEntry(conn: SqlExecutor, id: string, now: string): PathCacheEntry {
  const path = folderPath(conn, id);
  const slash = path.lastIndexOf('/');
  return { itemType: 'folder', itemId: id, fullPath: `/${path}`, folderPath: slash < 0 ? '/' : `/${path.slice(0, slash)}`, updatedAt: now };
}
function resourceEntry(conn: SqlExecutor, itemType: string, itemId: string, folderId: string | null, now: string): PathCacheEntry {
  // Rust fetches the unused title too: a missing table/invalid title must still fail here.
  const titleSql: Record<string, string> = {
    note: 'SELECT title FROM notes WHERE id=?1', file: 'SELECT file_name FROM files WHERE id=?1',
    exam: 'SELECT COALESCE(exam_name,id) FROM exam_sheets WHERE id=?1',
    translation: 'SELECT COALESCE(title,id) FROM translations WHERE id=?1', essay: 'SELECT COALESCE(title,id) FROM essays WHERE id=?1',
  };
  const query = titleSql[canonicalType(itemType)];
  if (query) {
    const title = conn.pluck(query, [itemId]);
    if (title !== undefined && typeof title !== 'string') {
      throw new VfsRepositoryError('VFS_STORAGE', 'Database error: Invalid column type Null at index: 0, name: title');
    }
  }
  const path = folderId === null ? '/' : `/${folderPath(conn, folderId)}`;
  return { itemType, itemId, fullPath: path === '/' ? `/${itemId}` : `${path}/${itemId}`, folderPath: path, updatedAt: now };
}
interface FolderItem { item_type: string; item_id: string; folder_id: string | null }
function liveItems(conn: SqlExecutor, ids?: readonly string[]): FolderItem[] {
  return conn.all<FolderItem>(`SELECT fi.item_type, fi.item_id, fi.folder_id FROM folder_items fi
    LEFT JOIN notes n ON fi.item_type='note' AND fi.item_id=n.id
    LEFT JOIN files f ON fi.item_type='file' AND fi.item_id=f.id
    LEFT JOIN exam_sheets e ON fi.item_type='exam' AND fi.item_id=e.id
    LEFT JOIN translations t ON fi.item_type='translation' AND fi.item_id=t.id
    LEFT JOIN essays es ON fi.item_type='essay' AND fi.item_id=es.id
    WHERE ${ids ? `fi.folder_id IN (${ids.map(() => '?').join(',')}) AND ` : ''}fi.deleted_at IS NULL AND (
      (fi.item_type='note' AND n.id IS NOT NULL AND (n.deleted_at IS NULL OR n.deleted_at='')) OR
      (fi.item_type='file' AND f.id IS NOT NULL AND (f.deleted_at IS NULL OR f.deleted_at='')) OR
      (fi.item_type='exam' AND e.id IS NOT NULL AND (e.deleted_at IS NULL OR e.deleted_at='')) OR
      (fi.item_type='translation' AND t.id IS NOT NULL AND (t.deleted_at IS NULL OR t.deleted_at='')) OR
      (fi.item_type='essay' AND es.id IS NOT NULL AND (es.deleted_at IS NULL OR es.deleted_at='')))`, ids);
}

export class PathCacheRepo implements PathCacheRepository {
  ensureTableExists(conn: SqlExecutor): void {
    databaseResult(() => {
      conn.run(`CREATE TABLE IF NOT EXISTS path_cache (item_type TEXT NOT NULL, item_id TEXT NOT NULL,
        full_path TEXT NOT NULL, folder_path TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(item_type,item_id))`);
      conn.run('CREATE INDEX IF NOT EXISTS idx_path_cache_path ON path_cache(full_path)');
      conn.run('CREATE INDEX IF NOT EXISTS idx_path_cache_folder ON path_cache(folder_path)');
    });
  }
  getPath(conn: SqlExecutor, type: string, id: string): PathCacheEntry | null {
    return databaseResult(() => {
      this.ensureTableExists(conn);
      return conn.get<PathCacheEntry>(`SELECT ${columns} FROM path_cache WHERE item_type=?1 AND item_id=?2`, [canonicalType(type), id]) ?? null;
    });
  }
  getByFullPath(conn: SqlExecutor, path: string): PathCacheEntry | null {
    return databaseResult(() => {
      this.ensureTableExists(conn);
      return conn.get<PathCacheEntry>(`SELECT ${columns} FROM path_cache WHERE full_path=?1`, [path]) ?? null;
    });
  }
  setPath(conn: SqlExecutor, entry: PathCacheEntry): void {
    databaseResult(() => {
      this.ensureTableExists(conn);
      if (byteLength(entry.fullPath) > MAX_PATH_LENGTH) {
        throw new VfsRepositoryError('VFS_INVALID_ARGUMENT', `Invalid argument 'full_path': Path too long: ${byteLength(entry.fullPath)} chars (max ${MAX_PATH_LENGTH})`, { param: 'full_path' });
      }
      conn.run(upsert, [entry.itemType, entry.itemId, entry.fullPath, entry.folderPath, entry.updatedAt]);
    });
  }
  setPathsBatch(conn: SqlExecutor, entries: readonly PathCacheEntry[]): number {
    if (entries.length === 0) return 0;
    return databaseResult(() => {
      this.ensureTableExists(conn);
      conn.exec('BEGIN TRANSACTION');
      let count = 0;
      try {
        for (const entry of entries) {
          if (byteLength(entry.fullPath) <= MAX_PATH_LENGTH) {
            conn.run(upsert, [entry.itemType, entry.itemId, entry.fullPath, entry.folderPath, entry.updatedAt]);
            count++;
          }
        }
      } catch (error) { rollbackIgnoringFailure(conn); throw error; }
      conn.exec('COMMIT');
      return count;
    });
  }
  invalidate(conn: SqlExecutor, type: string, id: string): boolean {
    return databaseResult(() => {
      this.ensureTableExists(conn);
      return conn.run('DELETE FROM path_cache WHERE item_type=?1 AND item_id=?2', [canonicalType(type), id]).changes > 0;
    });
  }
  invalidateByFolder(conn: SqlExecutor, id: string): number {
    return databaseResult(() => {
      this.ensureTableExists(conn);
      return this.invalidateByFoldersBatch(conn, recursiveFolderIds(conn, id));
    });
  }
  invalidateByFoldersBatch(conn: SqlExecutor, ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    return databaseResult(() => {
      this.ensureTableExists(conn);
      let deleted = 0;
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        deleted += conn.run(`DELETE FROM path_cache WHERE item_type='folder' AND item_id IN (${chunk.map(() => '?').join(',')})`, chunk).changes;
      }
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const items = conn.all<{ item_type: string; item_id: string }>(`SELECT item_type,item_id FROM folder_items WHERE folder_id IN (${chunk.map(() => '?').join(',')})`, chunk);
        const groups = new Map<string, string[]>();
        for (const item of items) {
          const group = groups.get(item.item_type) ?? [];
          group.push(item.item_id);
          groups.set(item.item_type, group);
        }
        for (const [type, itemIds] of groups) {
          for (let j = 0; j < itemIds.length; j += 100) {
            const itemChunk = itemIds.slice(j, j + 100);
            deleted += conn.run(`DELETE FROM path_cache WHERE item_type=? AND item_id IN (${itemChunk.map(() => '?').join(',')})`, [type, ...itemChunk]).changes;
          }
        }
      }
      return deleted;
    });
  }
  invalidateByPathPrefix(conn: SqlExecutor, prefix: string): number {
    return databaseResult(() => {
      this.ensureTableExists(conn);
      return conn.run('DELETE FROM path_cache WHERE full_path LIKE ?1 OR folder_path LIKE ?1', [`${prefix}%`]).changes;
    });
  }
  rebuildAll(conn: SqlExecutor): number {
    return databaseResult(() => {
      this.ensureTableExists(conn);
      conn.exec('BEGIN TRANSACTION');
      let count = 0;
      try {
        conn.run('DELETE FROM path_cache');
        const now = utcTimestamp();
        for (const { id } of conn.all<{ id: string }>('SELECT id FROM folders WHERE deleted_at IS NULL')) {
          const entry = folderEntry(conn, id, now);
          if (byteLength(entry.fullPath) <= MAX_PATH_LENGTH) { this.setPath(conn, entry); count++; }
        }
        for (const item of liveItems(conn)) {
          let entry: PathCacheEntry;
          try { entry = resourceEntry(conn, item.item_type, item.item_id, item.folder_id, now); }
          catch (error) { logWarn('[VFS::PathCacheRepo] Skipping resource cache:', error); continue; }
          if (byteLength(entry.fullPath) <= MAX_PATH_LENGTH) { this.setPath(conn, entry); count++; }
        }
      } catch (error) { rollbackIgnoringFailure(conn); throw error; }
      conn.exec('COMMIT');
      return count;
    });
  }
  rebuildFolder(conn: SqlExecutor, id: string): number {
    return databaseResult(() => {
      this.ensureTableExists(conn);
      const now = utcTimestamp();
      const ids = recursiveFolderIds(conn, id);
      if (ids.length === 0) return 0;
      let count = 0;
      for (const folderId of ids) {
        // Rust get_folder_with_conn fails on old/incomplete folder schemas; skip those rows.
        let folder;
        try {
          folder = conn.get(`SELECT id,parent_id,title,icon,color,is_expanded,is_favorite,sort_order,
            CASE typeof(created_at) WHEN 'text' THEN CAST(strftime('%s',created_at) AS INTEGER)*1000 ELSE created_at END AS created_at,
            CASE typeof(updated_at) WHEN 'text' THEN CAST(strftime('%s',updated_at) AS INTEGER)*1000 ELSE updated_at END AS updated_at FROM folders WHERE id=?1`, [folderId]);
        } catch (error) { logWarn('[VFS::PathCacheRepo] Skipping folder cache:', error); continue; }
        if (folder) { this.setPath(conn, folderEntry(conn, folderId, now)); count++; }
      }
      for (const item of liveItems(conn, ids)) {
        let entry: PathCacheEntry;
        try { entry = resourceEntry(conn, item.item_type, item.item_id, item.folder_id, now); }
        catch (error) { logWarn('[VFS::PathCacheRepo] Skipping resource cache:', error); continue; }
        this.setPath(conn, entry);
        count++;
      }
      return count;
    });
  }
  getOrComputePath(conn: SqlExecutor, type: string, id: string): PathCacheEntry {
    return databaseResult(() => {
      const cached = this.getPath(conn, type, id);
      if (cached) return cached;
      const now = utcTimestamp();
      const entry = type === 'folder' ? folderEntry(conn, id, now) : resourceEntry(conn, type, id,
        conn.pluck<string | null>('SELECT folder_id FROM folder_items WHERE item_type=?1 AND item_id=?2 AND deleted_at IS NULL', [canonicalType(type), id]) ?? null, now);
      if (byteLength(entry.fullPath) <= MAX_PATH_LENGTH) this.setPath(conn, entry);
      return entry;
    });
  }
  getStats(conn: SqlExecutor): PathCacheStats {
    this.ensureTableExists(conn);
    const count = (sql: string) => {
      try { return conn.pluck<number>(sql) ?? 0; }
      catch (error) { logWarn('[VFS::PathCacheRepo] Count failed:', error); return 0; }
    };
    const totalCount = count('SELECT COUNT(*) FROM path_cache');
    const folderCount = count("SELECT COUNT(*) FROM path_cache WHERE item_type='folder'");
    return { totalCount, folderCount, resourceCount: totalCount - folderCount };
  }
}
