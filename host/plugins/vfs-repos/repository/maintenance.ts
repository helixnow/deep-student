/**
 * Table-owner maintenance operations handed over from L13b.
 *
 * Rust sources (read-only, owned by the command lanes):
 * - `handlers.rs:1044-1304` resource path cache
 * - `handlers.rs:5855-6020` index reset commands
 * - `handlers.rs:6976-7309` media cache clearing
 * - `handlers.rs:7793-7827` resource OCR clearing
 * - `todo_handlers.rs:1099-1140` AI breakdown persistence
 *
 * All SQL for the `vfs.db` tables owned by this plugin lives here; callers keep
 * their command-level logging, LanceDB work and `mark_pending` best-effort step.
 */
import { dirname, join } from '../../../platform/util/path.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { utf8ByteLength } from '../../../platform/util/index.ts';
import {
  VfsRepositoryError,
  type BeforeVectorClear,
  type BlobRepository,
  type ClearMediaCacheParams,
  type ClearMediaCacheResult,
  type FolderRepository,
  type MaintenanceRepository,
  type TodoItem,
  type TodoRepository,
  type VfsIndexResetCounts,
} from '../api.ts';
import { databaseResult } from './errors.ts';
import { logDebug, logError, logInfo, logWarn } from './logger.ts';
import { utcTimestamp } from './timestamps.ts';
import { withSavepoint } from './todo-utils.ts';

const MAX_PATH_BYTES = 1000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function storageError(text: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_STORAGE', text);
}

/** Rust `let _ = ...`: the error does not fail the command, but stays visible in the log. */
function ignoreFailure(what: string, run: () => void): void {
  try { run(); }
  catch (error) { logWarn(`[VfsHandlers] ${what}:`, error); }
}

/** `backup/mod.rs::sqlite_table_columns`: missing table -> empty set, else column names. */
function tableColumns(conn: SqlExecutor, table: string): Set<string> {
  const exists = conn.get<{ present: number }>(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1) AS present",
    [table]);
  if (exists === undefined || Number(exists.present) === 0) return new Set();
  return new Set(conn.all<{ name: string }>(`PRAGMA table_info(${table})`)
    .map((row) => row.name));
}

interface MaintenanceDependencies {
  readonly folders: FolderRepository;
  readonly todos: TodoRepository;
  readonly blobs: BlobRepository;
}

interface PreviewPage {
  readonly blobHash: string | null;
  readonly compressedBlobHash: string | null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

function stringField(page: Record<string, unknown>, primary: string, alias: string): string | null {
  const value = page[primary] === undefined ? page[alias] : page[primary];
  return typeof value === 'string' ? value : null;
}

/** handlers.rs:6976-7040 preview pages accept both snake_case and camelCase blob keys. */
function previewPages(raw: string): PreviewPage[] {
  const pages = objectValue(parseJson(raw))?.['pages'];
  if (!Array.isArray(pages)) return [];
  const result: PreviewPage[] = [];
  for (const page of pages) {
    const record = objectValue(page);
    if (record === null) continue;
    result.push({
      blobHash: stringField(record, 'blob_hash', 'blobHash'),
      compressedBlobHash: stringField(record, 'compressed_blob_hash', 'compressedBlobHash'),
    });
  }
  return result;
}

export class MaintenanceRepo implements MaintenanceRepository {
  private readonly deps: MaintenanceDependencies;

  constructor(deps: MaintenanceDependencies) {
    this.deps = deps;
  }

  /** indexing.rs:1978-2053; no self-owned transaction, each UPDATE is best-effort. */
  recoverStuckIndexingWithConn(conn: SqlExecutor, at: number): number {
    let textUnits = 0;
    try {
      textUnits = conn.run(`UPDATE vfs_index_units
        SET text_state = 'pending', text_error = 'recovered: interrupted by crash', updated_at = ?1
        WHERE text_state = 'indexing'`, [at]).changes;
    } catch (error) {
      logWarn(`[VfsFullIndexingService] Failed to recover stuck state: ${message(error)}`);
    }

    let mmUnits = 0;
    try {
      mmUnits = conn.run(`UPDATE vfs_index_units
        SET mm_state = 'pending', mm_error = 'recovered: interrupted by crash', updated_at = ?1
        WHERE mm_state = 'indexing'`, [at]).changes;
    } catch (error) {
      logWarn(`[VfsFullIndexingService] Failed to recover stuck state: ${message(error)}`);
    }

    let resources = 0;
    try {
      resources = conn.run(`UPDATE resources
        SET index_state = CASE WHEN index_state = 'indexing' THEN 'pending' ELSE index_state END,
            index_error = CASE WHEN index_state = 'indexing'
              THEN 'recovered: interrupted by crash' ELSE index_error END,
            index_retry_count = CASE WHEN index_state = 'indexing' THEN 0 ELSE index_retry_count END,
            index_next_retry_at = CASE WHEN index_state = 'indexing' THEN 0 ELSE index_next_retry_at END,
            mm_index_state = CASE WHEN mm_index_state = 'indexing' THEN 'pending' ELSE mm_index_state END,
            mm_index_error = CASE WHEN mm_index_state = 'indexing'
              THEN 'recovered: interrupted by crash' ELSE mm_index_error END,
            mm_index_retry_count = CASE WHEN mm_index_state = 'indexing' THEN 0 ELSE mm_index_retry_count END,
            mm_index_next_retry_at = CASE WHEN mm_index_state = 'indexing' THEN 0 ELSE mm_index_next_retry_at END
        WHERE index_state = 'indexing' OR mm_index_state = 'indexing'`).changes;
    } catch (error) {
      logWarn(`[VfsFullIndexingService] Failed to recover stuck state: ${message(error)}`);
    }

    const total = textUnits + mmUnits + resources;
    if (total > 0) {
      logWarn(`[VfsFullIndexingService] Recovered ${total} stuck indexing records at startup `
        + `(text_units=${textUnits}, mm_units=${mmUnits}, resources=${resources})`);
    } else {
      logDebug('[VfsFullIndexingService] No stuck indexing records found at startup');
    }
    return total;
  }

  /** handlers.rs:1044-1130 */
  getResourcePath(conn: SqlExecutor, sourceId: string): string {
    let cached: string | null;
    try {
      cached = conn.pluck<string | null>(
        'SELECT cached_path FROM folder_items WHERE item_id = ?1 AND cached_path IS NOT NULL LIMIT 1',
        [sourceId],
      ) ?? null;
    } catch (error) {
      throw storageError(`Query cached_path failed: ${message(error)}`);
    }
    if (cached !== null) {
      logDebug(`[VFS::handlers] Returning cached path for ${sourceId}: ${cached}`);
      return cached;
    }

    let item: { id: string; folder_id: string | null } | undefined;
    try {
      item = conn.get<{ id: string; folder_id: string | null }>(
        'SELECT id, folder_id FROM folder_items WHERE item_id = ?1 LIMIT 1',
        [sourceId],
      );
    } catch (error) {
      throw storageError(`Query folder_item failed: ${message(error)}`);
    }

    if (item === undefined) return `/${this.resourceTitle(conn, sourceId)}`;

    const path = this.computePath(conn, item.folder_id, sourceId);
    const bytes = utf8ByteLength(path);
    if (bytes <= MAX_PATH_BYTES) {
      try {
        conn.run('UPDATE folder_items SET cached_path = ?1 WHERE id = ?2', [path, item.id]);
      } catch (error) {
        throw storageError(`Update cached_path failed: ${message(error)}`);
      }
      logDebug(`[VFS::handlers] Updated cached_path for ${sourceId}: ${path}`);
    } else {
      logWarn(`[VFS::handlers] Path too long (${bytes}), not caching: ${sourceId}`);
    }
    return path;
  }

  /** handlers.rs:1143-1228 */
  updatePathCache(conn: SqlExecutor, folderId: string): number {
    if (!folderId.startsWith('fld_')) {
      const reason = `Invalid folder ID format: ${folderId}`;
      throw new VfsRepositoryError('VFS_INVALID_ARGUMENT',
        `Invalid argument 'folder_id': ${reason}`, { param: 'folder_id', reason });
    }
    conn.exec('BEGIN TRANSACTION');
    let updated: number;
    try {
      updated = this.updatePathCacheInternal(conn, folderId);
    } catch (error) {
      try { conn.exec('ROLLBACK'); }
      catch (rollbackError) { logWarn('[VFS::handlers] Failed to rollback path cache update:', rollbackError); }
      logError(`[VFS::handlers] Failed to update path cache: ${message(error)}`);
      throw error;
    }
    try { conn.exec('COMMIT'); }
    catch (error) {
      throw storageError(message(error));
    }
    logInfo(`[VFS::handlers] Updated ${updated} path caches for folder ${folderId}`);
    return updated;
  }

  /** handlers.rs:1189-1228 */
  private updatePathCacheInternal(conn: SqlExecutor, folderId: string): number {
    const folderIds = this.deps.folders.getFolderIdsRecursive(conn, folderId);
    if (folderIds.length === 0) return 0;

    const items = this.deps.folders.getItemsByFolders(conn, folderIds);
    let updated = 0;
    for (const item of items) {
      const path = this.computePath(conn, item.folderId ?? null, item.itemId);
      if (utf8ByteLength(path) > MAX_PATH_BYTES) {
        logWarn(`[VFS::handlers] Path too long for item ${item.itemId}, skipping cache update`);
        continue;
      }
      try {
        conn.run('UPDATE folder_items SET cached_path = ?1 WHERE id = ?2', [path, item.id]);
      } catch (error) {
        throw storageError(`Update cached_path failed: ${message(error)}`);
      }
      updated += 1;
    }
    return updated;
  }

  /** handlers.rs:1235-1248 */
  private computePath(conn: SqlExecutor, folderId: string | null, sourceId: string): string {
    const title = this.resourceTitle(conn, sourceId);
    if (folderId === null) return `/${title}`;
    const folderPath = this.deps.folders.buildFolderPath(conn, folderId);
    return `/${folderPath}/${title}`;
  }

  /** handlers.rs:1252-1304 */
  private resourceTitle(conn: SqlExecutor, sourceId: string): string {
    const prefix = sourceId.split('_')[0] ?? '';
    const lookup = (sql: string, label: string): string | null => {
      let row: { value: string | null } | undefined;
      try {
        row = conn.get<{ value: string | null }>(sql, [sourceId]);
      } catch (error) {
        throw storageError(`Query ${label} failed: ${message(error)}`);
      }
      if (row === undefined) return null;
      return typeof row.value === 'string' ? row.value : null;
    };

    let title: string | null;
    switch (prefix) {
      case 'note':
        title = lookup('SELECT title AS value FROM notes WHERE id = ?1', 'note title');
        break;
      case 'tb':
        title = lookup('SELECT file_name AS value FROM files WHERE id = ?1', 'textbook title');
        break;
      case 'exam':
        title = lookup('SELECT COALESCE(exam_name, id) AS value FROM exam_sheets WHERE id = ?1', 'exam title');
        break;
      case 'tr':
        title = lookup('SELECT id AS value FROM translations WHERE id = ?1', 'translation title');
        break;
      case 'essay':
        title = lookup('SELECT COALESCE(title, id) AS value FROM essays WHERE id = ?1', 'essay title');
        break;
      default:
        title = null;
    }
    return title ?? sourceId;
  }

  /** todo_handlers.rs:1099-1140 */
  createTodoSubtasks(conn: SqlExecutor, listId: string, parentId: string, titles: readonly string[]): TodoItem[] {
    return databaseResult(() => withSavepoint(conn, 'todo_ai_breakdown', () => titles.map(title =>
      this.deps.todos.createTodoItem(conn, {
        todoListId: listId,
        title,
        description: null,
        priority: 'none',
        dueDate: null,
        dueTime: null,
        reminder: null,
        tags: null,
        parentId,
        attachments: null,
        repeatJson: null,
      }))));
  }

  /** handlers.rs:5855-5880 */
  resetDisabledToPending(conn: SqlExecutor): number {
    const updated = databaseResult(() => conn.run(
      `UPDATE resources SET index_state = 'pending', index_error = NULL,
         index_retry_count = 0, index_next_retry_at = 0
       WHERE index_state = 'disabled'`,
    ).changes);
    logInfo(`[VFS::handlers] Reset ${updated} disabled resources to pending`);
    return updated;
  }

  /** handlers.rs:5885-5917 */
  resetIndexedWithoutEmbeddings(conn: SqlExecutor): number {
    const updated = databaseResult(() => conn.run(
      `UPDATE resources
         SET index_state = 'pending', index_error = NULL,
             index_retry_count = 0, index_next_retry_at = 0
       WHERE index_state = 'indexed'
         AND NOT EXISTS (
           SELECT 1 FROM vfs_index_units u
           JOIN vfs_index_segments s ON s.unit_id = u.id
           WHERE u.resource_id = resources.id
         )`,
    ).changes);
    logInfo(`[VFS::handlers] Reset ${updated} indexed-without-segments resources to pending`);
    return updated;
  }

  /** handlers.rs:5923-6020 (SQLite portion; the caller clears Lance before this call). */
  resetAllIndexStateRows(conn: SqlExecutor): VfsIndexResetCounts {
    const deletedSegments = databaseResult(() => conn.run('DELETE FROM vfs_index_segments').changes);
    logInfo(`[VFS::handlers] 删除 ${deletedSegments} 个 segments`);

    const deletedUnits = databaseResult(() => conn.run('DELETE FROM vfs_index_units').changes);
    logInfo(`[VFS::handlers] 删除 ${deletedUnits} 个 units`);

    databaseResult(() => conn.run('UPDATE vfs_embedding_dims SET record_count = 0'));

    const updatedResources = databaseResult(() => conn.run(
      `UPDATE resources
         SET index_state = 'pending',
             index_hash = NULL,
             index_error = NULL,
             index_retry_count = 0,
             index_next_retry_at = 0,
             mm_index_state = 'pending',
             mm_index_error = NULL,
             mm_index_retry_count = 0,
             mm_index_next_retry_at = 0,
             mm_embedding_dim = NULL,
             mm_indexing_mode = NULL,
             mm_indexed_at = NULL`,
    ).changes);

    const updatedFiles = databaseResult(() => conn.run(
      `UPDATE files
         SET mm_index_state = 'pending',
             mm_index_error = NULL,
             mm_indexed_pages_json = NULL,
             updated_at = datetime('now')`,
    ).changes);

    const updatedExams = databaseResult(() => conn.run(
      `UPDATE exam_sheets
         SET mm_index_state = 'pending',
             mm_index_error = NULL,
             mm_indexed_pages_json = NULL,
             mm_embedding_dim = NULL,
             mm_indexed_at = NULL,
             updated_at = datetime('now')`,
    ).changes);

    logInfo(`[VFS::handlers] 重置 ${updatedResources} 个资源为 pending 状态（files=${updatedFiles}, exam_sheets=${updatedExams})`);
    return { deletedSegments, deletedUnits, updatedResources, updatedFiles, updatedExams };
  }

  /**
   * `dstu-sync/backup/mod.rs:2307 reset_rebuildable_vfs_index` 的 SQLite 账本部分。
   * 逐表按 `PRAGMA table_info` 只更新存在的列；调用方（L11 `vfsMaintenance`
   * 或 L12/L21 的同一事务执行器）负责 `BEGIN IMMEDIATE`、Lance 目录删除与提交。
   */
  resetRebuildableIndex(conn: SqlExecutor): void {
    databaseResult(() => {
      const segmentColumns = tableColumns(conn, 'vfs_index_segments');
      const unitColumns = tableColumns(conn, 'vfs_index_units');
      const dimColumns = tableColumns(conn, 'vfs_embedding_dims');
      const profileColumns = tableColumns(conn, 'vfs_index_profiles');
      const resourceColumns = tableColumns(conn, 'resources');
      const fileColumns = tableColumns(conn, 'files');
      const examColumns = tableColumns(conn, 'exam_sheets');
      const orphanColumns = tableColumns(conn, '__lance_orphan_queue');

      if (segmentColumns.size > 0) conn.run('DELETE FROM vfs_index_segments');

      const unitResets: string[] = [];
      if (unitColumns.has('text_state')) {
        unitResets.push(unitColumns.has('text_required')
          ? "text_state = CASE WHEN text_required = 1 THEN 'pending' ELSE 'disabled' END"
          : "text_state = 'pending'");
      }
      for (const [column, value] of [
        ['text_error', 'NULL'],
        ['text_indexed_at', 'NULL'],
        ['text_chunk_count', '0'],
        ['text_embedding_dim', 'NULL'],
        ['text_profile_id', 'NULL'],
        ['text_generation', '0'],
      ] as const) {
        if (unitColumns.has(column)) unitResets.push(`${column} = ${value}`);
      }
      if (unitColumns.has('mm_state')) {
        unitResets.push(unitColumns.has('mm_required')
          ? "mm_state = CASE WHEN mm_required = 1 THEN 'pending' ELSE 'disabled' END"
          : "mm_state = 'disabled'");
      }
      for (const [column, value] of [
        ['mm_error', 'NULL'],
        ['mm_indexed_at', 'NULL'],
        ['mm_embedding_dim', 'NULL'],
        ['mm_profile_id', 'NULL'],
        ['mm_generation', '0'],
      ] as const) {
        if (unitColumns.has(column)) unitResets.push(`${column} = ${value}`);
      }
      if (unitResets.length > 0) {
        conn.run(`UPDATE vfs_index_units SET ${unitResets.join(', ')}`);
      }

      const dimResets: string[] = [];
      if (dimColumns.has('record_count')) dimResets.push('record_count = 0');
      if (dimColumns.has('last_used_at') && dimColumns.has('created_at')) {
        dimResets.push('last_used_at = created_at');
      }
      if (dimColumns.has('active_generation')) dimResets.push('active_generation = 0');
      if (dimColumns.has('ann_metric')) dimResets.push("ann_metric = 'exact'");
      if (dimColumns.has('ann_index_version')) dimResets.push('ann_index_version = 0');
      if (dimResets.length > 0) {
        conn.run(`UPDATE vfs_embedding_dims SET ${dimResets.join(', ')}`);
      }

      const profileResets: string[] = [];
      if (profileColumns.has('active_generation')) profileResets.push('active_generation = 0');
      if (profileColumns.has('ann_metric')) profileResets.push("ann_metric = 'exact'");
      if (profileColumns.has('ann_index_version')) profileResets.push('ann_index_version = 0');
      if (profileColumns.has('state')) {
        profileResets.push(dimColumns.has('active_profile_id')
          ? `state = CASE
              WHEN id IN (SELECT active_profile_id FROM vfs_embedding_dims
                          WHERE active_profile_id IS NOT NULL)
              THEN 'active' ELSE 'retired' END`
          : "state = 'retired'");
      }
      if (profileResets.length > 0) {
        conn.run(`UPDATE vfs_index_profiles SET ${profileResets.join(', ')}`);
      }

      const resourceResets: string[] = [];
      if (resourceColumns.has('index_state')) {
        resourceResets.push(
          "index_state = CASE WHEN index_state = 'disabled' THEN 'disabled' ELSE 'pending' END");
      }
      for (const [column, value] of [
        ['index_hash', 'NULL'],
        ['index_error', 'NULL'],
        ['indexed_at', 'NULL'],
        ['index_retry_count', '0'],
        ['index_next_retry_at', '0'],
        ['index_generation', '0'],
      ] as const) {
        if (resourceColumns.has(column)) resourceResets.push(`${column} = ${value}`);
      }
      if (resourceColumns.has('mm_index_state')) {
        resourceResets.push(`mm_index_state = CASE
            WHEN mm_index_state IS NULL THEN NULL
            WHEN mm_index_state = 'disabled' THEN 'disabled'
            ELSE 'pending' END`);
      }
      for (const [column, value] of [
        ['mm_index_error', 'NULL'],
        ['mm_indexed_at', 'NULL'],
        ['mm_embedding_dim', 'NULL'],
        ['mm_indexing_mode', 'NULL'],
        ['mm_indexed_pages_json', 'NULL'],
        ['mm_index_retry_count', '0'],
        ['mm_index_next_retry_at', '0'],
        ['mm_index_generation', '0'],
      ] as const) {
        if (resourceColumns.has(column)) resourceResets.push(`${column} = ${value}`);
      }
      if (resourceResets.length > 0) {
        conn.run(`UPDATE resources SET ${resourceResets.join(', ')}`);
      }

      for (const [tableName, columns] of [
        ['files', fileColumns],
        ['exam_sheets', examColumns],
      ] as const) {
        const resets: string[] = [];
        if (columns.has('mm_index_state')) {
          resets.push(`mm_index_state = CASE
              WHEN mm_index_state IS NULL THEN NULL
              WHEN mm_index_state = 'disabled' THEN 'disabled'
              ELSE 'pending' END`);
        }
        for (const column of [
          'mm_index_error',
          'mm_indexed_pages_json',
          'mm_embedding_dim',
          'mm_indexing_mode',
          'mm_indexed_at',
        ]) {
          if (columns.has(column)) resets.push(`${column} = NULL`);
        }
        if (resets.length > 0) conn.run(`UPDATE ${tableName} SET ${resets.join(', ')}`);
      }

      if (orphanColumns.size > 0) conn.run('DELETE FROM __lance_orphan_queue');
    });
  }

  /**
   * handlers.rs:6976-7309. SQLite/blob work is owned here; the Lance file primitive
   * is injected through `beforeVectorClear` at the exact handlers.rs:7161-7178 stage.
   */
  async clearMediaCache(conn: SqlExecutor, blobsDir: string, params: ClearMediaCacheParams,
    beforeVectorClear?: BeforeVectorClear): Promise<ClearMediaCacheResult> {
    const result: ClearMediaCacheResult = {
      pdfPreviewCleared: 0,
      compressedImagesCleared: 0,
      ocrTextCleared: 0,
      vectorIndexCleared: 0,
      totalBytesFreed: 0,
      filesReset: 0,
    };

    if (params.clearPdfPreview) {
      const rows = databaseResult(() => conn.all<{ id: string; preview_json: string }>(
        'SELECT id, preview_json FROM files WHERE preview_json IS NOT NULL'));
      for (const row of rows) {
        for (const page of previewPages(row.preview_json)) {
          if (page.blobHash !== null) {
            this.decrementBlob(conn, page.blobHash);
            result.pdfPreviewCleared += 1;
            result.totalBytesFreed += this.blobSize(conn, page.blobHash);
          }
          if (page.compressedBlobHash !== null && page.compressedBlobHash !== page.blobHash) {
            this.decrementBlob(conn, page.compressedBlobHash);
            result.pdfPreviewCleared += 1;
            result.totalBytesFreed += this.blobSize(conn, page.compressedBlobHash);
          }
        }
        ignoreFailure('Failed to clear preview_json', () => {
          conn.run('UPDATE files SET preview_json = NULL WHERE id = ?1', [row.id]);
        });
        result.filesReset += 1;
      }
      ignoreFailure('Blob cleanup failed after preview clear', () => {
        this.deps.blobs.cleanupUnreferenced(conn, blobsDir);
      });
    }

    if (params.clearCompressedImages) {
      const rows = databaseResult(() => conn.all<{ id: string; compressed_blob_hash: string; blob_hash: string | null }>(
        'SELECT id, compressed_blob_hash, blob_hash FROM files WHERE compressed_blob_hash IS NOT NULL'));
      for (const row of rows) {
        if (row.compressed_blob_hash !== row.blob_hash) {
          result.totalBytesFreed += this.blobSize(conn, row.compressed_blob_hash);
          this.decrementBlob(conn, row.compressed_blob_hash);
        }
        ignoreFailure('Failed to clear compressed_blob_hash', () => {
          conn.run('UPDATE files SET compressed_blob_hash = NULL WHERE id = ?1', [row.id]);
        });
        result.compressedImagesCleared += 1;
        result.filesReset += 1;
      }
      ignoreFailure('Blob cleanup failed after compressed-image clear', () => {
        this.deps.blobs.cleanupUnreferenced(conn, blobsDir);
      });
    }

    if (params.clearOcrText) {
      // Rust `.unwrap_or(0)`: a failed count does not fail the branch.
      let cleared = 0;
      try {
        cleared = conn.pluck<number>(
          `SELECT COUNT(*) FROM files f LEFT JOIN resources r ON r.id = f.resource_id
           WHERE r.ocr_text IS NOT NULL OR f.ocr_pages_json IS NOT NULL`) ?? 0;
      } catch (error) { logWarn('[VFS::handlers] Failed to count OCR rows:', error); }
      databaseResult(() => conn.run('UPDATE files SET ocr_pages_json = NULL WHERE ocr_pages_json IS NOT NULL'));
      databaseResult(() => conn.run('UPDATE resources SET ocr_text = NULL WHERE ocr_text IS NOT NULL'));
      result.ocrTextCleared = cleared;
      result.filesReset += cleared;
    }

    if (params.clearVectorIndex) {
      // handlers.rs:7161-7178: file stage runs after OCR and before every vector
      // DELETE. A later missing-column failure must not undo or pre-date it.
      if (beforeVectorClear !== undefined) {
        const lanceDir = join(dirname(blobsDir), 'lance', 'vfs');
        try {
          const cleared = await beforeVectorClear(lanceDir);
          if (cleared.removed) {
            result.vectorIndexCleared = 1;
            result.totalBytesFreed += cleared.bytesFreed;
          } else if (cleared.existed) {
            logWarn(`[VFS::handlers] Failed to remove lance dir: ${lanceDir}`);
          }
        } catch (error) {
          logWarn('[VFS::handlers] Failed to remove lance dir:', error);
        }
      }
      databaseResult(() => conn.run('DELETE FROM vfs_index_segments'));
      databaseResult(() => conn.run('DELETE FROM vfs_index_units'));
      databaseResult(() => conn.run('UPDATE vfs_embedding_dims SET record_count = 0'));
      // Rust `handlers.rs:7193-7200` uses `unwrap_or(0)` for the count and then lets the
      // UPDATE fail; the vfs schema does not actually contain `vector_indexed_at`, so the
      // original command is known to fail after segments/units/dims were already cleared.
      let resetCount = 0;
      try {
        resetCount = conn.pluck<number>('SELECT COUNT(*) FROM resources WHERE vector_indexed_at IS NOT NULL') ?? 0;
      } catch (error) { logWarn('[VFS::handlers] Failed to count vector-indexed resources:', error); }
      databaseResult(() => conn.run(
        'UPDATE resources SET vector_indexed_at = NULL WHERE vector_indexed_at IS NOT NULL'));
      result.filesReset += resetCount;
    }

    if (params.clearPdfPreview || params.clearCompressedImages || params.clearOcrText) {
      const rows = databaseResult(() => conn.all<{ id: string; processing_progress: string }>(
        `SELECT id, processing_progress FROM files
         WHERE processing_progress IS NOT NULL
           AND (mime_type LIKE 'application/pdf' OR mime_type LIKE 'image/%')`));
      for (const row of rows) {
        let progress: unknown;
        try { progress = JSON.parse(row.processing_progress); }
        catch { continue; }
        const record = objectValue(progress);
        if (record !== null) {
          const key = 'readyModes' in record ? 'readyModes' : 'ready_modes';
          const modes = record[key];
          if (Array.isArray(modes)) {
            record[key] = modes.filter(mode =>
              !(params.clearPdfPreview && mode === 'image') && !(params.clearOcrText && mode === 'ocr'));
          }
        }
        databaseResult(() => conn.run(
          `UPDATE files SET processing_status = 'pending', processing_progress = ?1,
             processing_error = NULL, processing_started_at = NULL, processing_completed_at = NULL
           WHERE id = ?2`, [JSON.stringify(progress), row.id]));
      }
      databaseResult(() => conn.run(
        `UPDATE files SET processing_status = 'pending', processing_error = NULL,
           processing_started_at = NULL, processing_completed_at = NULL
         WHERE processing_progress IS NULL
           AND (mime_type LIKE 'application/pdf' OR mime_type LIKE 'image/%')`));
    }

    logInfo(`[VFS::handlers] vfs_clear_media_cache: Complete! freed ${result.totalBytesFreed} bytes, reset ${result.filesReset} files`);
    return result;
  }

  /** handlers.rs:7793-7827; `mark_pending` stays with the command layer. */
  clearResourceOcr(conn: SqlExecutor, resourceId: string): void {
    try {
      conn.run('UPDATE resources SET ocr_text = NULL, updated_at = ?1 WHERE id = ?2', [Date.now(), resourceId]);
    } catch (error) {
      throw storageError(`Failed to clear ocr_text: ${message(error)}`);
    }

    const now = utcTimestamp();
    let filesUpdated: number;
    try {
      filesUpdated = conn.run(
        'UPDATE files SET ocr_pages_json = NULL, updated_at = ?1 WHERE resource_id = ?2',
        [now, resourceId],
      ).changes;
    } catch (error) {
      throw storageError(`Failed to clear ocr_pages_json: ${message(error)}`);
    }

    if (filesUpdated === 0) {
      let sourceId: string | null = null;
      try {
        const row = conn.get<{ source_id: string | null }>(
          'SELECT source_id FROM resources WHERE id = ?1', [resourceId]);
        sourceId = row?.source_id ?? null;
      } catch (error) { logWarn('[VfsHandlers] Failed to read source_id for OCR clear:', error); }
      if (sourceId !== null) {
        ignoreFailure('Failed to clear ocr_pages_json by source_id', () => {
          conn.run('UPDATE files SET ocr_pages_json = NULL, updated_at = ?1 WHERE id = ?2', [now, sourceId]);
        });
      }
    }
    logInfo(`[VFS::handlers] Cleared OCR data for resource ${resourceId} and marked as pending`);
  }

  private decrementBlob(conn: SqlExecutor, hash: string): void {
    ignoreFailure(`Failed to decrement blob ref ${hash}`, () => {
      this.deps.blobs.decrementRef(conn, hash);
    });
  }

  private blobSize(conn: SqlExecutor, hash: string): number {
    try { return conn.pluck<number>('SELECT size FROM blobs WHERE hash = ?1', [hash]) ?? 0; }
    catch (error) {
      logWarn(`[VFS::handlers] Failed to read blob size ${hash}:`, error);
      return 0;
    }
  }
}
