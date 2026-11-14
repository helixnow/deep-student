import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach } from 'vitest';
import { createTestHost, type TestHost, type TestHostOptions } from '../../../kernel/testing.ts';
import type { StorageServiceImpl } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import type { SettingsService } from '../../../platform/settings/api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type { LogService } from '../../../platform/log/api.ts';
import type { NoteRepository, NotesService, VfsNote } from '../../notes/api.ts';
import type {
  FolderRepository, IndexStateRepository, ResourceRepository, TodoRepository, VfsReposService,
} from '../../vfs-repos/api.ts';
import type {
  FusedRetrievalHit, RetrievalService, UnifiedRetrievalRequest, UnifiedRetrievalResponse,
  VfsIndexService,
} from '../../vfs-index/api.ts';
import type { VfsHandlersHooks } from '../../vfs-handlers/api.ts';
import type { AgentToolsService } from '../../agent-skills/api.ts';
import memory, { type MemoryPluginConfig } from '../index.ts';
import { vfsDependencies, type MemoryVfsDependencies } from '../repository/vfs.ts';
import { createMigratedMemoryStorage } from './fixtures/migrated-schema.ts';

/**
 * better-sqlite3 is synchronous. A long file can keep the worker in a
 * microtask chain for over a minute, starving vitest's `onTaskUpdate` RPC and
 * producing a spurious "Timeout calling onTaskUpdate" error after all tests
 * passed. Yield one macrotask after each test so the heartbeat is processed.
 */
afterEach(async () => {
  await new Promise<void>(resolve => setImmediate(resolve));
});

export interface MemoryDecisionDouble {
  calls: Array<{ prompt: string; signal?: AbortSignal }>;
  callMemoryDecisionRawPrompt(prompt: string,
    signal?: AbortSignal): Promise<{ assistant_message: string }>;
}

export interface MemoryHost {
  host: TestHost;
  storage: StorageServiceImpl;
  db: DatabaseHandle;
  dir: string;
  deps: MemoryVfsDependencies;
  notes: NotesService;
  repos: VfsReposService;
  retrieval: RetrievalDouble;
  index: IndexDouble;
  warnings: string[];
  infos: string[];
  memoryDecision: MemoryDecisionDouble | null;
  vfsHooks: VfsHandlersHooks | undefined;
  dispose(): Promise<void>;
}

const isoNow = (): string => `${new Date().toISOString().slice(0, 23)}Z`;
const hashContent = (content: string): string => createHash('sha256').update(content).digest('hex');
const hashWithSalt = (content: string, salt: string): string =>
  createHash('sha256').update(salt).update(':').update(content).digest('hex');

function insertResource(conn: SqlExecutor, params: {
  type: string; content: string; hash: string; sourceId: string | null;
  sourceTable: string | null; metadataJson: string | null;
}): string {
  const id = `res_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const now = Date.now();
  const changes = conn.run(
    `INSERT OR IGNORE INTO resources
       (id, hash, type, source_id, source_table, storage_mode, data, metadata_json, ref_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'inline', ?6, ?7, 0, ?8, ?9)`,
    [id, params.hash, params.type, params.sourceId, params.sourceTable, params.content,
      params.metadataJson, now, now],
  ).changes;
  if (changes > 0) return id;
  const existing = conn.get<{ id: string }>('SELECT id FROM resources WHERE hash = ?1', [params.hash]);
  if (existing === undefined) throw new Error('Database error: resource hash vanished during reuse');
  return existing.id;
}

function insertFolderItem(conn: SqlExecutor, folderId: string | null, itemType: string,
  itemId: string): void {
  conn.run('DELETE FROM folder_items WHERE item_id = ?1 AND item_type = ?2', [itemId, itemType]);
  conn.run(
    `INSERT OR REPLACE INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
     VALUES (?1, ?2, ?3, ?4, 0, ?5, NULL)`,
    [`fi_${randomUUID().replaceAll('-', '').slice(0, 10)}`, folderId, itemType, itemId, Date.now()],
  );
}

function notesRepositoryDouble(db: SqlExecutor): NoteRepository {
  const executor = (conn?: SqlExecutor): SqlExecutor => conn ?? db;
  const getNoteRow = (id: string, conn?: SqlExecutor): Record<string, unknown> | undefined =>
    executor(conn).get<Record<string, unknown>>(
      'SELECT id, resource_id AS resourceId, title, tags, is_favorite AS isFavorite, created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt FROM notes WHERE id = ?1 AND deleted_at IS NULL', [id]);
  const createNoteInFolder = (params: { title: string; content: string; tags?: string[] },
    folderId: string | null, conn?: SqlExecutor): VfsNote => {
    const conn2 = executor(conn);
    const noteId = `note_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const now = isoNow();
    const tags = params.tags ?? [];
    const resourceId = insertResource(conn2, {
      type: 'note', content: params.content, hash: hashWithSalt(params.content, noteId),
      sourceId: noteId, sourceTable: 'notes', metadataJson: null,
    });
    conn2.run(
      `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)`,
      [noteId, resourceId, params.title, JSON.stringify(tags), now, now],
    );
    conn2.run('UPDATE resources SET source_id = ?1 WHERE id = ?2', [noteId, resourceId]);
    insertFolderItem(conn2, folderId, 'note', noteId);
    return {
      id: noteId, resourceId, title: params.title, tags: [...tags], isFavorite: false,
      createdAt: now, updatedAt: now, deletedAt: null,
    };
  };
  return {
    getNote: (id, conn) => {
      const row = getNoteRow(id, conn);
      return row === undefined ? null : noteFromRow(row);
    },
    getNoteContent: (id, conn) => {
      const row = executor(conn).get<{ data: string | null }>(
        'SELECT r.data AS data FROM notes n JOIN resources r ON n.resource_id = r.id WHERE n.id = ?1 AND n.deleted_at IS NULL', [id]);
      return row === undefined ? null : row.data ?? '';
    },
    // Same statement as L10 notes/repository/notes.ts rewriteTagsWithoutTouchingUpdatedAtWithConn.
    rewriteTagsWithoutTouchingUpdatedAtWithConn: (conn, id, tagsJson) => {
      conn.run('UPDATE notes SET tags = ?1 WHERE id = ?2', [tagsJson, id]);
    },
    getNoteWithContent: (id, conn) => {
      const row = getNoteRow(id, conn);
      return row === undefined ? null : [noteFromRow(row), ''];
    },
    createNote: (params, conn) => createNoteInFolder(params, null, conn),
    createNoteInFolder,
    updateNote: (id, params, conn) => updateNoteDouble(db, id, params, conn),
    updateNoteMetadata: () => { throw new Error('notes double: updateNoteMetadata is unused'); },
    listNotes: () => [],
    listNotesByFolder: () => [],
    listDeletedNotes: () => [],
    deleteNote: (id, conn) => deleteNoteDouble(executor(conn), id),
    deleteNoteWithFolderItem: (id, conn) => deleteNoteDouble(executor(conn), id),
    restoreNote: () => { throw new Error('notes double: restoreNote is unused'); },
    purgeNote: () => { throw new Error('notes double: purgeNote is unused'); },
    purgeDeletedNotes: () => 0,
    setFavorite: () => { throw new Error('notes double: setFavorite is unused'); },
    setNoteProps: () => { throw new Error('notes double: setNoteProps is unused'); },
    getNoteLocation: () => null,
    backfillNoteLinksOnce: () => false,
  };
}

function noteFromRow(row: Record<string, unknown>): VfsNote {
  const rawTags = row['tags'];
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(typeof rawTags === 'string' ? rawTags : '[]');
    tags = Array.isArray(parsed) && parsed.every((tag): tag is string => typeof tag === 'string') ? parsed : [];
  } catch {
    tags = [];
  }
  return {
    id: String(row['id']), resourceId: String(row['resourceId']), title: String(row['title']),
    tags, isFavorite: Number(row['isFavorite']) !== 0, createdAt: String(row['createdAt']),
    updatedAt: String(row['updatedAt']),
    deletedAt: row['deletedAt'] === null || row['deletedAt'] === undefined
      ? null : String(row['deletedAt']),
  };
}

function updateNoteDouble(connection: SqlExecutor, id: string, params: {
  title?: string | null; content?: string | null; tags?: string[] | null;
  expectedUpdatedAt?: string | null;
}, conn?: SqlExecutor): VfsNote {
  const db = conn ?? connection;
  const row = db.get<Record<string, unknown>>(
    'SELECT id, resource_id AS resourceId, title, tags, is_favorite AS isFavorite, created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt FROM notes WHERE id = ?1 AND deleted_at IS NULL', [id]);
  if (row === undefined) throw new Error(`Note not found: ${id}`);
  const current = noteFromRow(row);
  const now = new Date(Math.max(Date.now(), (Date.parse(current.updatedAt) || 0) + 1))
    .toISOString().slice(0, 23) + 'Z';
  let resourceId = current.resourceId;
  if (params.content !== undefined && params.content !== null) {
    const hash = hashWithSalt(params.content, id);
    const currentHash = db.get<{ hash: string }>('SELECT hash FROM resources WHERE id = ?1', [resourceId])?.hash;
    if (hash !== currentHash && hashContent(params.content) !== currentHash) {
      resourceId = insertResource(db, {
        type: 'note', content: params.content, hash, sourceId: id,
        sourceTable: 'notes', metadataJson: null,
      });
    }
  }
  const title = params.title ?? current.title;
  const tags = params.tags ?? current.tags;
  const expected = params.expectedUpdatedAt?.trim();
  const changes = expected === undefined || expected === ''
    ? db.run('UPDATE notes SET resource_id = ?1, title = ?2, tags = ?3, updated_at = ?4 WHERE id = ?5 AND deleted_at IS NULL',
      [resourceId, title, JSON.stringify(tags), now, id]).changes
    : db.run('UPDATE notes SET resource_id = ?1, title = ?2, tags = ?3, updated_at = ?4 WHERE id = ?5 AND deleted_at IS NULL AND updated_at = ?6',
      [resourceId, title, JSON.stringify(tags), now, id, expected]).changes;
  if (changes === 0) {
    if (expected !== undefined && expected !== '') {
      throw new Error('CONFLICT(notes.conflict): The note has been updated elsewhere, please refresh.');
    }
    throw new Error(`Note not found: ${id}`);
  }
  if (resourceId !== current.resourceId) {
    const refs = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM notes WHERE resource_id = ?1', [current.resourceId])?.count ?? 0;
    if (refs === 0) db.run('DELETE FROM resources WHERE id = ?1', [current.resourceId]);
  }
  return {
    id, resourceId, title, tags: [...tags], isFavorite: current.isFavorite,
    createdAt: current.createdAt, updatedAt: now, deletedAt: null,
  };
}

function deleteNoteDouble(db: SqlExecutor, id: string): void {
  const now = isoNow();
  if (db.run('UPDATE notes SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL',
    [now, now, id]).changes === 0) {
    throw new Error(`Note not found: ${id}`);
  }
  db.run("UPDATE folder_items SET deleted_at = ?1, updated_at = ?2 WHERE item_type = 'note' AND item_id = ?3 AND deleted_at IS NULL",
    [now, Date.now(), id]);
}

export function createNotesDouble(db: SqlExecutor): NotesService {
  return {
    version: 1,
    repository: notesRepositoryDouble(db),
    format: {} as never,
    revisions: {} as never,
    state: {} as never,
  };
}

function foldersDouble(): FolderRepository & {
  getBreadcrumbs(conn: SqlExecutor, folderId: string): Array<{ id: string; name: string }>;
} {
  const count = (conn: SqlExecutor): number =>
    conn.get<{ count: number }>('SELECT COUNT(*) AS count FROM folders WHERE deleted_at IS NULL')?.count ?? 0;
  const depth = (conn: SqlExecutor, folderId: string): number => {
    const row = conn.get<{ depth: number | null }>(
      `WITH RECURSIVE path AS (
         SELECT id, parent_id, 1 AS depth FROM folders WHERE id = ?1
         UNION ALL SELECT f.id, f.parent_id, p.depth + 1 FROM folders f JOIN path p ON f.id = p.parent_id WHERE p.depth < 20
       ) SELECT COALESCE(MAX(depth), 0) AS depth FROM path`, [folderId]);
    return row?.depth ?? 0;
  };
  return {
    getBreadcrumbs: () => { throw new Error('vfs-repos double: getBreadcrumbs is unused'); },
    createFolder: (conn, folder) => {
      if (folder.parentId !== null && folder.parentId !== undefined) {
        const exists = conn.get<{ count: number }>('SELECT COUNT(*) AS count FROM folders WHERE id = ?1 AND deleted_at IS NULL', [folder.parentId])?.count ?? 0;
        if (exists === 0) throw new Error(`INVALID_PARENT: ${folder.parentId} - Parent folder does not exist`);
        if (depth(conn, folder.parentId) >= 10) throw new Error(`FOLDER_DEPTH_EXCEEDED: ${folder.id}`);
      }
      if (count(conn) >= 500) throw new Error('FOLDER_COUNT_EXCEEDED: 500 folders (max 500)');
      conn.run(`INSERT INTO folders (id, parent_id, title, icon, color, is_expanded, sort_order, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      [folder.id, folder.parentId ?? null, folder.title, folder.icon ?? null, folder.color ?? null,
        folder.isExpanded ? 1 : 0, folder.sortOrder, folder.createdAt, folder.updatedAt]);
    },
    getFolder: () => null,
    folderExists: (conn, id) => (conn.get<{ count: number }>('SELECT COUNT(*) AS count FROM folders WHERE id = ?1 AND deleted_at IS NULL', [id])?.count ?? 0) > 0,
    getFolderDepth: (conn, id) => depth(conn, id),
    countAllFolders: (conn) => count(conn),
    listAllFolders: () => [],
    listFoldersByParent: () => [],
    getResourceLocation: () => null,
    getFolderItemByItemId: () => null,
    getFolderItemByCachedPath: () => null,
    removeItemByItemId: () => false,
    listItemsByFolder: () => [],
    listAllAssignedItemIds: () => new Set<string>(),
    addItemToFolder: (conn, item) => insertFolderItem(conn, item.folderId ?? null, item.itemType, item.itemId),
    moveItemByItemId: () => { throw new Error('vfs-repos double: moveItemByItemId is unused'); },
    moveItemsBatch: () => 0,
    updateFolder: () => { throw new Error('vfs-repos double: updateFolder is unused'); },
    renameFolderIfVersion: () => { throw new Error('vfs-repos double: renameFolderIfVersion is unused'); },
    deleteFolder: (conn, folderId) => {
      const now = new Date().toISOString();
      const nowMs = Date.now();
      if (conn.run('UPDATE folders SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL',
        [now, nowMs, folderId]).changes === 0) {
        throw new Error(`FOLDER_NOT_FOUND: ${folderId}`);
      }
      conn.run(`WITH RECURSIVE descendants AS (
          SELECT id FROM folders WHERE parent_id = ?1 AND deleted_at IS NULL
          UNION ALL SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.id WHERE f.deleted_at IS NULL
        ) UPDATE folders SET deleted_at = ?2, updated_at = ?3 WHERE id IN (SELECT id FROM descendants)`,
      [folderId, now, nowMs]);
      conn.run(`WITH RECURSIVE all_folders AS (
          SELECT ?1 AS id UNION ALL SELECT f.id FROM folders f INNER JOIN all_folders af ON f.parent_id = af.id
        ) UPDATE folder_items SET deleted_at = ?2, updated_at = ?3
          WHERE folder_id IN (SELECT id FROM all_folders) AND deleted_at IS NULL`,
      [folderId, now, nowMs]);
    },
    purgeFolder: () => { throw new Error('vfs-repos double: purgeFolder is unused'); },
    restoreFolder: () => { throw new Error('vfs-repos double: restoreFolder is unused'); },
    generateUniqueFolderTitle: () => '',
    listDeletedFolders: () => [],
    purgeDeletedFolders: () => 0,
    setFolderExpanded: () => { throw new Error('vfs-repos double: setFolderExpanded is unused'); },
    setFavorite: () => { throw new Error('vfs-repos double: setFavorite is unused'); },
    moveFolder: (conn, folderId, newParentId) => {
      if (newParentId !== null) {
        const exists = conn.get<{ count: number }>('SELECT COUNT(*) AS count FROM folders WHERE id = ?1 AND deleted_at IS NULL', [newParentId])?.count ?? 0;
        if (exists === 0) throw new Error(`FOLDER_NOT_FOUND: ${newParentId}`);
      }
      conn.run('UPDATE folders SET parent_id = ?1, updated_at = ?2 WHERE id = ?3',
        [newParentId, Date.now(), folderId]);
    },
    getFolderIdsRecursive: () => [],
    getItemsByFolders: () => [],
    buildFolderPath: () => '',
    buildResourcePath: () => '',
    getFolderTree: () => [],
    getFolderTreeAll: () => [],
    getFolderItemsAll: () => [],
    removeItemFromFolder: () => { throw new Error('vfs-repos double: removeItemFromFolder is unused'); },
    moveItemToFolder: (conn, itemType, itemId, newFolderId) => {
      const affected = conn.run('UPDATE folder_items SET folder_id = ?1, cached_path = NULL WHERE item_id = ?2 AND item_type = ?3 AND deleted_at IS NULL',
        [newFolderId, itemId, itemType]).changes;
      if (affected === 0) insertFolderItem(conn, newFolderId, itemType, itemId);
    },
    reorderFolders: () => { throw new Error('vfs-repos double: reorderFolders is unused'); },
    reorderItems: () => { throw new Error('vfs-repos double: reorderItems is unused'); },
    countItemsInFolder: () => 0,
    getAllResources: () => { throw new Error('vfs-repos double: getAllResources is unused'); },
  };
}

function resourcesDouble(): ResourceRepository {
  const unused = (): never => { throw new Error('vfs-repos double: resource method is unused'); };
  return {
    createOrReuse: (conn, type, data, sourceId, sourceTable, metadata) =>
      resourcesDouble().createOrReuseWithHash(conn, type, data, hashContent(data), sourceId, sourceTable, metadata),
    createOrReuseWithHash: (conn, type, data, hash, sourceId, sourceTable, metadata) => {
      const resourceId = insertResource(conn, {
        type, content: data, hash, sourceId, sourceTable,
        metadataJson: metadata === null ? null : JSON.stringify(metadata),
      });
      return { resourceId, hash, isNew: true };
    },
    createOrReuseExternal: () => unused(),
    getResource: () => null,
    getByHash: () => null,
    exists: () => false,
    incrementRef: () => 0,
    decrementRef: () => 0,
    decrementRefs: () => undefined,
    cleanupUnreferencedRetrievals: () => 0,
    cleanupOrphanNoteMindmapResources: () => 0,
    getBySourceId: () => null,
    listByType: () => [],
    search: () => [],
    updateResourceData: () => false,
    computeHash: (data) => hashContent(data),
    computeHashWithSalt: (data, salt) => hashWithSalt(data, salt),
    saveOcrText: () => undefined,
    getOcrText: () => null,
    hasOcrText: () => false,
    getOcrTextBySource: () => null,
  };
}

function indexStatesDouble(): IndexStateRepository {
  const unused = (): never => { throw new Error('vfs-repos double: index-state method is unused'); };
  return {
    getIndexState: () => null,
    setIndexState: (conn, id, state, hash, error) => {
      conn.run('UPDATE resources SET index_state = ?1, index_hash = ?2, index_error = ?3 WHERE id = ?4',
        [state, hash, error, id]);
    },
    markPending: (conn, id) => {
      conn.run(`UPDATE resources SET index_state = 'pending', index_hash = NULL, index_error = NULL,
        indexed_at = NULL, index_retry_count = 0, index_next_retry_at = 0 WHERE id = ?1`, [id]);
    },
    markIndexing: () => undefined,
    markIndexed: (conn, id, hash) => {
      conn.run(`UPDATE resources SET index_state = 'indexed', index_hash = ?1, index_error = NULL,
        indexed_at = ?2, index_retry_count = 0, index_next_retry_at = 0 WHERE id = ?3`,
      [hash, Date.now(), id]);
    },
    markFailed: () => undefined,
    reviveConfigBlocked: () => 0,
    requeuePagedPdfsOnce: () => 0,
    markDisabled: (conn, id) => {
      conn.run("UPDATE resources SET index_state = 'disabled', index_error = NULL WHERE id = ?1", [id]);
    },
    markDisabledWithReason: (conn, id, reason) => {
      conn.run("UPDATE resources SET index_state = 'disabled', index_error = ?1 WHERE id = ?2", [reason, id]);
    },
    getPendingResources: () => [],
    claimPendingResources: () => [],
    getDisabledResources: () => [],
    getResourcesNeedingReindex: () => [],
    getMmIndexState: () => null,
    setMmIndexState: () => undefined,
    markMmPending: () => undefined,
    markMmIndexing: () => undefined,
    markMmIndexed: () => undefined,
    markMmFailed: () => undefined,
    markMmDisabled: unused,
    getMmPendingResources: () => [],
    claimMmIndexingResources: () => [],
  };
}

/** Minimal TodoRepository backed by the real `todo_lists` / `todo_items` tables. */
function todosDouble(): Pick<TodoRepository,
  'createTodoList' | 'listTodoLists' | 'createTodoItem' | 'listAllPendingItems'> {
  return {
    createTodoList: (conn, params) => {
      const id = `tl_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
      const now = isoNow();
      const sortOrder = (conn.pluck<number>(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 FROM todo_lists') ?? 0);
      conn.run(`INSERT INTO todo_lists
        (id, title, description, icon, color, sort_order, is_default, is_favorite, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)`, [
        id, params.title.trim(), params.description ?? null, params.icon ?? null,
        params.color ?? null, sortOrder, params.isDefault ? 1 : 0, now,
      ]);
      return {
        id, title: params.title.trim(),
        description: params.description ?? undefined, icon: params.icon ?? undefined,
        color: params.color ?? undefined, sortOrder, isDefault: params.isDefault ?? false,
        isFavorite: false, createdAt: now, updatedAt: now,
      };
    },
    listTodoLists: conn => conn.all<Record<string, unknown>>(
      `SELECT id, title, description, icon, color, sort_order AS sortOrder,
              is_default AS isDefault, is_favorite AS isFavorite,
              created_at AS createdAt, updated_at AS updatedAt
       FROM todo_lists WHERE deleted_at IS NULL
       ORDER BY is_default DESC, sort_order ASC, updated_at DESC`).map(row => ({
      id: String(row['id']), title: String(row['title']),
      description: row['description'] === null ? undefined : String(row['description']),
      icon: row['icon'] === null ? undefined : String(row['icon']),
      color: row['color'] === null ? undefined : String(row['color']),
      sortOrder: Number(row['sortOrder']), isDefault: Number(row['isDefault']) !== 0,
      isFavorite: Number(row['isFavorite']) !== 0,
      createdAt: String(row['createdAt']), updatedAt: String(row['updatedAt']),
    })),
    createTodoItem: (conn, params) => {
      const list = conn.get<{ id: string }>(
        'SELECT id FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL', [params.todoListId]);
      if (list === undefined) throw new Error(`TodoList not found: ${params.todoListId}`);
      const id = `ti_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
      const now = isoNow();
      const sortOrder = (conn.pluck<number>(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 FROM todo_items
         WHERE todo_list_id = ?1 AND parent_id IS NULL AND deleted_at IS NULL`,
        [params.todoListId]) ?? 0);
      const tagsJson = JSON.stringify(params.tags ?? []);
      const attachmentsJson = JSON.stringify(params.attachments ?? []);
      conn.run(`INSERT INTO todo_items
        (id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
         tags_json, sort_order, parent_id, repeat_json, attachments_json, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, 'pending', ?5, NULL, NULL, NULL, ?6, ?7, NULL, NULL, ?8, ?9, ?9)`, [
        id, params.todoListId, params.title.trim(), params.description ?? null,
        params.priority ?? 'none', tagsJson, sortOrder, attachmentsJson, now,
      ]);
      return {
        id, todoListId: params.todoListId, title: params.title.trim(),
        description: params.description ?? undefined, status: 'pending',
        priority: params.priority ?? 'none', tagsJson, sortOrder, attachmentsJson,
        estimatedPomodoros: 0, completedPomodoros: 0, createdAt: now, updatedAt: now,
      };
    },
    listAllPendingItems: conn => conn.all<Record<string, unknown>>(
      `SELECT id, todo_list_id AS todoListId, title, description, status, priority,
              tags_json AS tagsJson, sort_order AS sortOrder,
              attachments_json AS attachmentsJson, created_at AS createdAt, updated_at AS updatedAt
       FROM todo_items WHERE status = 'pending' AND deleted_at IS NULL
       ORDER BY sort_order ASC, created_at ASC`).map(row => ({
      id: String(row['id']), todoListId: String(row['todoListId']),
      title: String(row['title']),
      description: row['description'] === null ? undefined : String(row['description']),
      status: String(row['status']), priority: String(row['priority']),
      tagsJson: String(row['tagsJson']), sortOrder: Number(row['sortOrder']),
      attachmentsJson: String(row['attachmentsJson']),
      createdAt: String(row['createdAt']), updatedAt: String(row['updatedAt']),
    })),
  };
}

export function createReposDouble(): VfsReposService {
  return {
    folders: foldersDouble(),
    resources: resourcesDouble(),
    indexStates: indexStatesDouble(),
    todos: todosDouble(),
    // Not exercised by the ordinary memory unit fixture; atomic DELETE replacement is
    // verified with the real L11 owner in note-content-owner.test.ts, not a purge clone.
    embeddingUnits: {
      purgeIndexArtifactsByResource: () => {
        throw new Error('vfs-repos double: purgeIndexArtifactsByResource is not implemented');
      },
    },
  } as unknown as VfsReposService;
}

export interface RetrievalDouble extends RetrievalService {
  readonly requests: UnifiedRetrievalRequest[];
  responder: ((request: UnifiedRetrievalRequest) => UnifiedRetrievalResponse | Promise<UnifiedRetrievalResponse>) | null;
}

/** Lexical-only stand-in for L12 `retrieval` (memory owns the post-processing under test). */
export function createRetrievalDouble(db: SqlExecutor): RetrievalDouble {
  const requests: UnifiedRetrievalRequest[] = [];
  const double: RetrievalDouble = {
    requests,
    responder: null,
    async retrieve(request: UnifiedRetrievalRequest): Promise<UnifiedRetrievalResponse> {
      requests.push(request);
      if (double.responder !== null) return await double.responder(request);
      const rows = request.queryText === null ? [] : db.all<{
        resourceId: string; unitIndex: number; text: string;
      }>(
        `SELECT u.resource_id AS resourceId, u.unit_index AS unitIndex, u.text_content AS text
         FROM vfs_index_units u JOIN notes n ON n.resource_id = u.resource_id
         WHERE n.deleted_at IS NULL AND u.text_content LIKE ?1
         ORDER BY u.unit_index ASC LIMIT ?2`,
        [`%${request.queryText}%`, request.topK],
      );
      const hits: FusedRetrievalHit[] = rows.map((row, index) => ({
        hit: {
          identity: { resourceId: row.resourceId, chunkIndex: row.unitIndex, pageIndex: null, timeRange: null },
          embeddingId: '', text: row.text, title: null, resourceType: 'note', sourceId: null,
          folderId: null, blobHash: null, imageUrl: null, rawScore: null, metadata: null,
        },
        rrfScore: 1 / (index + 1),
        normalizedScore: null,
        rerankScore: null,
        provenance: [],
      }));
      return {
        capabilitySnapshot: {} as never,
        plan: { queryModality: 'text', topK: request.topK, routes: [], imageFallbackChain: [] },
        result: { hits, failures: [] },
        queryDerivations: [],
      };
    },
    async search(request: UnifiedRetrievalRequest): Promise<UnifiedRetrievalResponse> {
      return double.retrieve(request);
    },
    async searchMultimodal(request: UnifiedRetrievalRequest): Promise<UnifiedRetrievalResponse> {
      return double.retrieve(request);
    },
    async inspectCapabilities() { return {} as never; },
  };
  return double;
}

export interface IndexDouble extends VfsIndexService {
  readonly indexed: string[];
  readonly deleted: string[];
}

export function createIndexDouble(): IndexDouble {
  const indexed: string[] = [];
  const deleted: string[] = [];
  return {
    indexed,
    deleted,
    lance: {
      deleteByResource: async (_modality: string, resourceId: string) => { deleted.push(resourceId); return 1; },
    } as never,
    pdf: {} as never,
    search: {} as never,
    multimodal: {} as never,
    indexing: {
      indexResource: async (resourceId: string) => { indexed.push(resourceId); return [0, 0] as [number, number]; },
      deleteResourceIndex: async (resourceId: string) => { deleted.push(resourceId); },
    } as never,
  };
}

export function createLogDouble(warnings: string[], infos: string[] = []): LogService {
  const logger = (target: string) => ({
    target,
    error: () => undefined,
    warn: (message: string) => { warnings.push(message); },
    info: (message: string) => { infos.push(message); },
    debug: () => undefined,
    trace: () => undefined,
  });
  return {
    logger,
    write: (level: string, target: string, message: string) => {
      if (level === 'warn') warnings.push(`${target}: ${message}`);
      if (level === 'info') infos.push(`${target}: ${message}`);
    },
  } as unknown as LogService;
}

export function createSettingsDouble(db: SqlExecutor): SettingsService {
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  return createSettingsStore({
    db: () => db, secureStore: () => null, isSensitiveKey: () => false,
  }) as unknown as SettingsService;
}

/** Fresh `vfs.db` migrated with the real VFS SQL, plus the compiled memory plugin. */
export function createMemoryDecisionDouble(
  handler: (prompt: string, signal?: AbortSignal) => string | Promise<string>,
): MemoryDecisionDouble {
  const calls: Array<{ prompt: string; signal?: AbortSignal }> = [];
  return {
    calls,
    async callMemoryDecisionRawPrompt(prompt, signal) {
      calls.push({ prompt, ...(signal === undefined ? {} : { signal }) });
      return { assistant_message: await handler(prompt, signal) };
    },
  };
}

export async function setupMemoryHost(options: {
  agentTools?: Pick<AgentToolsService, 'registerToolExecutors'>;
  ownerPlugins?: TestHostOptions['plugins'];
  debug?: boolean;
  shell?: (op: string, args: unknown) => unknown | Promise<unknown>;
  memoryDecision?: (prompt: string, signal?: AbortSignal) => string | Promise<string>;
  /** Extra L02 methods merged into the `llm` double (e.g. `callUnifiedModel2`). */
  llmMethods?: Record<string, unknown>;
  /** Extra host services (e.g. `chatPipeline`). */
  services?: Record<string, unknown>;
  vfsHooks?: VfsHandlersHooks;
  retrievalCancellable?: {
    search(request: UnifiedRetrievalRequest, signal: AbortSignal | null): Promise<UnifiedRetrievalResponse>;
  };
  /** memory 插件配置；对象按引用传入，测试可在调用之间修改（插件每次调用时读取）。 */
  memoryConfig?: MemoryPluginConfig;
} = {}): Promise<MemoryHost> {
  const { dir, storage } = await createMigratedMemoryStorage();
  const db = storage.database('vfs');
  const notes = createNotesDouble(db);
  const repos = createReposDouble();
  const retrieval = createRetrievalDouble(db);
  const index = createIndexDouble();
  const warnings: string[] = [];
  const infos: string[] = [];
  const memoryDecision = options.memoryDecision === undefined
    ? null : createMemoryDecisionDouble(options.memoryDecision);
  const host = await createTestHost({
    plugins: [...(options.ownerPlugins ?? []), [memory, options.memoryConfig ?? {}] as const],
    provide: {
      storage, 'notes': notes,
      'vfsRepo': repos, 'retrieval': retrieval,
      'vfsIndex': index, log: createLogDouble(warnings, infos),
      settings: createSettingsDouble(db),
      ...(options.agentTools === undefined ? {} : { agentTools: options.agentTools }),
      ...(memoryDecision === null ? {} : { llmRawPrompt: memoryDecision }),
      ...(memoryDecision === null && options.llmMethods === undefined
        ? {} : { llm: { ...(options.llmMethods ?? {}) } }),
      ...(options.services ?? {}),
      ...(options.vfsHooks === undefined ? {} : { vfsHooks: options.vfsHooks }),
      ...(options.retrievalCancellable === undefined
        ? {} : { retrievalCancellable: options.retrievalCancellable }),
    },
    ...(options.debug === undefined ? {} : { app: { debug: options.debug } }),
    ...(options.shell === undefined ? {} : { shell: options.shell }),
  });
  return {
    host, storage, db, dir, notes, repos, retrieval, index, warnings, infos, memoryDecision,
    vfsHooks: options.vfsHooks,
    deps: vfsDependencies(notes, repos),
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
