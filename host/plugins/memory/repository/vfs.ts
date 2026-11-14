/**
 * VFS read surface used by `dstu-memory` plus thin write adapters.
 *
 * Note/folder/resource writes are owned by the `notes` and `vfs-repos` plugins:
 * memory passes their published service objects in as `MemoryVfsDependencies`
 * and never re-implements their SQL. Read-only projections (which the memory
 * lists and search decorate) stay here so the service layer stays SQL-free.
 */
import { nanoid } from 'nanoid';
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import type { SqlExecutor, SqlParam } from '../../../platform/storage/api.ts';
import { defineQuery } from '../../../platform/storage/query.ts';
import { chronoStamp, civilTime, nowEpochNanos, parseRfc3339 } from '../../../platform/time/index.ts';
import type { NoteRepository } from '../../notes/api.ts';
import type {
  FolderRepository, IndexStateRepository, ResourceRepository, TodoRepository, VfsReposService,
  VfsResourceMetadata, VfsResourceType,
} from '../../vfs-repos/api.ts';

export const MAX_FOLDER_DEPTH = 10;
export const MAX_FOLDERS_COUNT = 500;

/** Only the collaborators memory actually calls (the services satisfy these structurally). */
export interface MemoryVfsDependencies {
  readonly notes: Pick<NoteRepository,
    'createNoteInFolder' | 'updateNote' | 'deleteNoteWithFolderItem' | 'getNoteContent' | 'getNote'>
    & Required<Pick<NoteRepository, 'rewriteTagsWithoutTouchingUpdatedAtWithConn'>>;
  readonly repos: {
    readonly folders: Pick<FolderRepository,
      'createFolder' | 'moveFolder' | 'deleteFolder' | 'addItemToFolder' | 'moveItemToFolder'>;
    readonly resources: Pick<ResourceRepository, 'createOrReuseWithHash'>;
    readonly indexStates: Pick<IndexStateRepository,
      'markPending' | 'markDisabledWithReason' | 'markIndexed'>;
    readonly embeddingUnits: Pick<import('../../vfs-repos/api.ts').IndexUnitRepository,
      'purgeIndexArtifactsByResource'>;
    readonly todos: Pick<TodoRepository,
      'createTodoList' | 'listTodoLists' | 'createTodoItem' | 'listAllPendingItems'>;
  };
}

export function vfsDependencies(notes: { readonly repository: NoteRepository },
  repos: VfsReposService): MemoryVfsDependencies {
  const repository = notes.repository;
  const rewriteTags = repository.rewriteTagsWithoutTouchingUpdatedAtWithConn;
  if (rewriteTags === undefined) {
    throw new Error('notes.repository.rewriteTagsWithoutTouchingUpdatedAtWithConn is not available');
  }
  return {
    notes: {
      createNoteInFolder: repository.createNoteInFolder.bind(repository),
      updateNote: repository.updateNote.bind(repository),
      deleteNoteWithFolderItem: repository.deleteNoteWithFolderItem.bind(repository),
      getNoteContent: repository.getNoteContent.bind(repository),
      getNote: repository.getNote.bind(repository),
      rewriteTagsWithoutTouchingUpdatedAtWithConn: rewriteTags.bind(repository),
    },
    repos,
  };
}

export interface VfsFolder {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  color: string | null;
  isExpanded: boolean;
  isFavorite: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}
export interface VfsFolderItem {
  id: string;
  folderId: string | null;
  itemType: string;
  itemId: string;
  sortOrder: number;
  createdAt: number;
  cachedPath: string | null;
}
export interface VfsNote {
  id: string;
  resourceId: string;
  title: string;
  tags: string[];
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface CreateNoteParams {
  title: string;
  content: string;
  tags: string[];
}
export interface UpdateNoteParams {
  title?: string;
  content?: string;
  tags?: string[];
  expectedUpdatedAt?: string;
}
export interface ResourceLocation {
  folderId: string | null;
  folderPath: string;
}

const folderColumns = `id, parent_id AS parentId, title, icon, color, is_expanded AS isExpanded,
  is_favorite AS isFavorite, sort_order AS sortOrder,
  CASE typeof(created_at) WHEN 'text' THEN CAST(strftime('%s', created_at) AS INTEGER) * 1000 ELSE created_at END AS createdAt,
  CASE typeof(updated_at) WHEN 'text' THEN CAST(strftime('%s', updated_at) AS INTEGER) * 1000 ELSE updated_at END AS updatedAt`;

interface FolderRow {
  id: string; parentId: string | null; title: string; icon: string | null; color: string | null;
  isExpanded: number; isFavorite: number; sortOrder: number; createdAt: number; updatedAt: number;
}
function toFolder(row: FolderRow): VfsFolder {
  return {
    id: row.id, parentId: row.parentId, title: row.title, icon: row.icon, color: row.color,
    isExpanded: row.isExpanded !== 0, isFavorite: row.isFavorite !== 0, sortOrder: row.sortOrder,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

const getFolderQuery = defineQuery<[string], FolderRow>(
  `SELECT ${folderColumns} FROM folders WHERE id = ?1`, { name: 'vfs.folder.get' });

export function getFolder(db: SqlExecutor, folderId: string): VfsFolder | undefined {
  const row = db.get(getFolderQuery, [folderId]);
  return row === undefined ? undefined : toFolder(row);
}

const folderExistsQuery = defineQuery<[string], { count: number }>(
  'SELECT COUNT(*) AS count FROM folders WHERE id = ?1 AND deleted_at IS NULL',
  { name: 'vfs.folder.exists' });

export function folderExists(db: SqlExecutor, folderId: string): boolean {
  return (db.get(folderExistsQuery, [folderId])?.count ?? 0) > 0;
}

const listFoldersByParentQuery = defineQuery<[string | null], FolderRow>(
  `SELECT ${folderColumns} FROM folders
   WHERE parent_id IS ?1 AND deleted_at IS NULL
   ORDER BY sort_order ASC, created_at ASC`, { name: 'vfs.folder.listByParent' });

export function listFoldersByParent(db: SqlExecutor, parentId: string | null): VfsFolder[] {
  return db.all(listFoldersByParentQuery, [parentId]).map(toFolder);
}

const syncedRootQuery = defineQuery<void, { folderId: string; memoryNoteCount: number }>(
  `WITH RECURSIVE marker(folder_id, note_count) AS (
     SELECT fi.folder_id, COUNT(*)
     FROM notes n JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
     WHERE n.deleted_at IS NULL AND fi.deleted_at IS NULL
       AND (n.title LIKE '\\_\\_cat\\_%' ESCAPE '\\'
         OR n.title LIKE '\\_\\_daily\\_log\\_%' ESCAPE '\\'
         OR n.title LIKE '\\_\\_user\\_profile\\_\\_%' ESCAPE '\\'
         OR n.title LIKE '\\_\\_learner\\_profile%' ESCAPE '\\')
     GROUP BY fi.folder_id
     UNION ALL
     SELECT f.id, 0 FROM folders f WHERE f.deleted_at IS NULL AND f.title = '__system__'
   ),
   climb(marker_folder_id, folder_id, parent_id, note_count) AS (
     SELECT m.folder_id, f.id, f.parent_id, m.note_count
     FROM marker m JOIN folders f ON f.id = m.folder_id AND f.deleted_at IS NULL
     UNION
     SELECT c.marker_folder_id, f.id, f.parent_id, c.note_count
     FROM climb c JOIN folders f ON f.id = c.parent_id AND f.deleted_at IS NULL
   )
   SELECT folder_id AS folderId, SUM(note_count) AS memoryNoteCount
   FROM climb WHERE parent_id IS NULL
   GROUP BY folder_id ORDER BY memoryNoteCount DESC, folder_id ASC`,
  { name: 'vfs.folder.syncedRoot' });

/** Rust `MemoryConfig::find_synced_memory_root` (J8a cross-device root claim). */
export function findSyncedMemoryRoot(db: SqlExecutor,
  warn: (message: string) => void = () => undefined): string | null {
  const rows = db.all(syncedRootQuery);
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    warn(`[Memory::Config] 检测到 ${rows.length} 个记忆根候选（设备间已分叉），选记忆笔记数最多的为主根；`
      + `其余根中的记忆不会自动合并，候选: ${rows.map(row => `(${row.folderId}, ${row.memoryNoteCount})`).join(', ')}`);
  }
  return rows[0]!.folderId;
}

const categoryNotesQuery = defineQuery<[string], { id: string; title: string; tags: string | null }>(
  `SELECT n.id AS id, n.title AS title, n.tags AS tags
   FROM notes n JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
   WHERE fi.folder_id = ?1 AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
     AND n.title LIKE '!_!_cat!_%!_!_' ESCAPE '!'
   ORDER BY n.title`, { name: 'vfs.note.categoryNotes' });

export interface CategoryNote { id: string; title: string; tags: string[] }

export function listCategoryNotes(db: SqlExecutor, folderId: string): CategoryNote[] {
  return db.all(categoryNotesQuery, [folderId]).map(row => ({
    id: row.id, title: row.title, tags: parseTags(row.tags ?? '[]'),
  }));
}

const folderIdsRecursiveQuery = defineQuery<[string, number], { id: string }>(
  `WITH RECURSIVE folder_tree AS (
     SELECT id, parent_id, title, 0 as depth FROM folders WHERE id = ?1 AND deleted_at IS NULL
     UNION ALL
     SELECT f.id, f.parent_id, f.title, ft.depth + 1
     FROM folders f JOIN folder_tree ft ON f.parent_id = ft.id
     WHERE ft.depth < ?2 AND f.deleted_at IS NULL
   )
   SELECT id FROM folder_tree`, { name: 'vfs.folder.idsRecursive' });

export function getFolderIdsRecursive(db: SqlExecutor, folderId: string): string[] {
  return db.all(folderIdsRecursiveQuery, [folderId, MAX_FOLDER_DEPTH]).map(row => row.id);
}

const folderPathQuery = defineQuery<[string, number], { title: string }>(
  `WITH RECURSIVE folder_path AS (
     SELECT id, parent_id, title, 1 as depth FROM folders WHERE id = ?1
     UNION ALL
     SELECT f.id, f.parent_id, f.title, fp.depth + 1
     FROM folders f JOIN folder_path fp ON f.id = fp.parent_id
     WHERE fp.depth < ?2
   )
   SELECT title FROM folder_path ORDER BY depth DESC`, { name: 'vfs.folder.path' });

export function buildFolderPath(db: SqlExecutor, folderId: string): string {
  return db.all(folderPathQuery, [folderId, MAX_FOLDER_DEPTH + 1]).map(row => row.title).join('/');
}

const listItemsQuery = defineQuery<[string | null], {
  id: string; folderId: string | null; itemType: string; itemId: string;
  sortOrder: number; createdAt: number | string; cachedPath: string | null;
}>(
  `SELECT id, folder_id AS folderId, item_type AS itemType, item_id AS itemId,
          sort_order AS sortOrder, created_at AS createdAt, cached_path AS cachedPath
   FROM folder_items WHERE folder_id IS ?1 AND deleted_at IS NULL
   ORDER BY sort_order ASC, created_at ASC`, { name: 'vfs.folder.items' });

function itemTimestamp(value: number | string): number {
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function listItemsByFolder(db: SqlExecutor, folderId: string | null): VfsFolderItem[] {
  return db.all(listItemsQuery, [folderId]).map(row => ({
    id: row.id, folderId: row.folderId, itemType: row.itemType, itemId: row.itemId,
    sortOrder: row.sortOrder, createdAt: itemTimestamp(row.createdAt), cachedPath: row.cachedPath,
  }));
}

const getResourceLocationQuery = defineQuery<[string, string], {
  folderId: string | null; createdAt: number | string;
}>(
  `SELECT folder_id AS folderId, created_at AS createdAt FROM folder_items
   WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL`, { name: 'vfs.folder.location' });

/** Rust `VfsFolderRepo::get_resource_location_with_conn` (single-row folder + built path). */
export function getNoteLocation(db: SqlExecutor, noteId: string): ResourceLocation | undefined {
  const row = db.get(getResourceLocationQuery, ['note', noteId]);
  if (row === undefined) return undefined;
  const folderPath = row.folderId === null ? '' : buildFolderPath(db, row.folderId);
  return { folderId: row.folderId, folderPath };
}

export function listNoteIdsInFolders(db: SqlExecutor, folderIds: readonly string[], limit: number,
  offset: number): string[] {
  if (folderIds.length === 0) return [];
  const placeholders = folderIds.map((_, index) => `?${index + 1}`).join(', ');
  const query = defineQuery<SqlParam[], { id: string }>(
    `SELECT DISTINCT n.id AS id
     FROM notes n JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
     WHERE fi.folder_id IN (${placeholders}) AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
       AND n.title NOT LIKE '\\_\\_%\\_\\_%' ESCAPE '\\'
     ORDER BY n.updated_at DESC
     LIMIT ?${folderIds.length + 1} OFFSET ?${folderIds.length + 2}`,
    { name: `vfs.note.list.${folderIds.length}` });
  const params: SqlParam[] = [...folderIds, limit, offset];
  return db.all(query, params).map(row => row.id);
}

// ------------------------------------------------------------------ notes (read)

const noteColumns = `n.id, n.resource_id AS resourceId, n.title, n.tags, n.is_favorite AS isFavorite,
  n.created_at AS createdAt, n.updated_at AS updatedAt, n.deleted_at AS deletedAt`;

interface NoteRow {
  id: string; resourceId: string; title: string; tags: string; isFavorite: number;
  createdAt: string; updatedAt: string; deletedAt: string | null;
}
function parseTags(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    // Rust `serde_json::from_str::<Vec<String>>(..).unwrap_or_default()`: one non-string
    // element fails the whole Vec, so the column reads as empty rather than filtered.
    return Array.isArray(value) && value.every((tag): tag is string => typeof tag === 'string') ? value : [];
  } catch {
    return [];
  }
}
function toNote(row: NoteRow): VfsNote {
  return {
    id: row.id, resourceId: row.resourceId, title: row.title, tags: parseTags(row.tags),
    isFavorite: row.isFavorite !== 0, createdAt: row.createdAt, updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** Rust VfsNoteRepo::get_note_with_conn, including row_to_note's invalid-tags warning. */
export function getNote(deps: MemoryVfsDependencies, db: SqlExecutor, noteId: string): VfsNote | undefined {
  const note = deps.notes.getNote(noteId, db);
  return note === null ? undefined : { ...note, deletedAt: note.deletedAt ?? null };
}

const getNoteTagsQuery = defineQuery<[string], { tags: string | null }>(
  'SELECT tags FROM notes WHERE id = ?1 AND deleted_at IS NULL', { name: 'vfs.note.tags' });

/**
 * Raw `notes.tags` JSON for the evolution cycle (`evolution.rs` reads it with
 * `query_row(...).ok()`); `null` covers both a missing row and SQL errors.
 */
export function getNoteTagsJson(db: SqlExecutor, noteId: string): string | null {
  try {
    const row = db.get(getNoteTagsQuery, [noteId]);
    return row === undefined ? null : row.tags;
  } catch {
    return null;
  }
}

/** `getNoteTagsJson` decoded like `serde_json::from_str::<Vec<String>>(..).unwrap_or_default()`. */
export function readNoteTags(db: SqlExecutor, noteId: string): string[] | null {
  const raw = getNoteTagsJson(db, noteId);
  return raw === null ? null : parseTags(raw);
}

/** Rust `conn.execute("UPDATE notes SET tags = ?1 WHERE id = ?2")?` via L10 (no `updated_at` bump); errors propagate. */
export function rewriteNoteTags(deps: MemoryVfsDependencies, db: SqlExecutor, noteId: string,
  tags: readonly string[]): void {
  deps.notes.rewriteTagsWithoutTouchingUpdatedAtWithConn(db, noteId, JSON.stringify(tags));
}

const dedupReviewBacklogQuery = defineQuery<[string, number], { id: string }>(
  `SELECT id FROM notes WHERE deleted_at IS NULL AND tags LIKE ?1
   ORDER BY updated_at ASC LIMIT ?2`, { name: 'memory.semanticDedup.backlog' });

/** Rust `SemanticDedup::list_review_backlog` (`semantic_dedup.rs:437-448`): oldest first. */
export function listDedupReviewBacklog(db: SqlExecutor, limit: number): string[] {
  return db.all(dedupReviewBacklogQuery, ['%"_needs_dedup_review"%', limit]).map(row => row.id);
}

/** Rust evolution `conn.execute("UPDATE notes SET tags = ?1 WHERE id = ?2").is_ok()`, via L10. */
export function setNoteTagsJson(deps: MemoryVfsDependencies, db: SqlExecutor, noteId: string,
  tagsJson: string): boolean {
  try {
    deps.notes.rewriteTagsWithoutTouchingUpdatedAtWithConn(db, noteId, tagsJson);
    return true;
  } catch {
    return false;
  }
}

const getNoteByResourceIdQuery = defineQuery<[string], NoteRow>(
  `SELECT ${noteColumns} FROM notes n WHERE n.resource_id = ?1 AND n.deleted_at IS NULL
   LIMIT 1`, { name: 'vfs.note.getByResource' });

/** Rust `MemoryService::get_note_by_resource_id`. */
export function getNoteByResourceId(db: SqlExecutor, resourceId: string): VfsNote | undefined {
  try {
    const row = db.get(getNoteByResourceIdQuery, [resourceId]);
    return row === undefined ? undefined : toNote(row);
  } catch {
    // Rust service.rs:3251-3274: query_row(..).ok(), not optional()?. No warning.
    return undefined;
  }
}

/**
 * Rust `VfsNoteRepo::get_note_content` through the L10 owner: `null` for a missing or
 * deleted note; a live note whose resource row is gone throws "Missing resource for note".
 */
export function readNoteContent(deps: MemoryVfsDependencies, db: SqlExecutor,
  noteId: string): string | null {
  return deps.notes.getNoteContent(noteId, db);
}

/** Rust `get_note_content(..)?.unwrap_or_default()`: errors propagate, absence is empty. */
export function getNoteContent(deps: MemoryVfsDependencies, db: SqlExecutor,
  noteId: string): string {
  return readNoteContent(deps, db, noteId) ?? '';
}

const findNoteInFolderQuery = defineQuery<[string, string], NoteRow>(
  `SELECT ${noteColumns} FROM notes n
   JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
   WHERE n.title = ?1 AND fi.folder_id = ?2 AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
   LIMIT 1`, { name: 'vfs.note.findByTitle' });

export function findNoteByTitle(db: SqlExecutor, folderId: string, title: string): VfsNote | undefined {
  try {
    const row = db.get(findNoteInFolderQuery, [title, folderId]);
    return row === undefined ? undefined : toNote(row);
  } catch {
    // Rust service.rs:3181-3208: ordinary memory title queries discard SQL/row errors.
    return undefined;
  }
}

export interface SystemNoteSnapshot {
  noteId: string;
  updatedAt: string;
  content: string;
}

const systemNoteSnapshotQuery = defineQuery<[string, string], SystemNoteSnapshot>(
  `SELECT n.id AS noteId, n.updated_at AS updatedAt, r.data AS content
   FROM notes n
   JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
   JOIN resources r ON r.id = n.resource_id
   WHERE n.title = ?1 AND fi.folder_id = ?2
     AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
   LIMIT 1`, { name: 'memory.systemNote.snapshot' });

/**
 * Rust daily_log.rs:100-127 / learner_profile.rs:658-685: CAS version and content from
 * one SELECT. JOIN absence is None, but SQL errors propagate (`optional().map_err(..)`).
 */
export function findSystemNoteSnapshot(db: SqlExecutor, folderId: string,
  title: string): SystemNoteSnapshot | undefined {
  return db.get(systemNoteSnapshotQuery, [title, folderId]);
}

const dailyLogNotesSinceQuery = defineQuery<[string, string], { id: string; title: string }>(
  `SELECT n.id AS id, n.title AS title FROM notes n
   JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
   WHERE fi.folder_id = ?1 AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
     AND n.title LIKE '!_!_daily!_log!_%!_!_' ESCAPE '!'
     AND n.title >= ?2
   ORDER BY n.title ASC`, { name: 'memory.dailyLog.listSince' });

/** Rust daily_log.rs:317-345 `list_recent` query: dated log notes titled at or after `minTitle`. */
export function listDailyLogNotesSince(db: SqlExecutor, folderId: string,
  minTitle: string): { id: string; title: string }[] {
  return db.all(dailyLogNotesSinceQuery, [folderId, minTitle]);
}

export function hashContent(content: string): string {
  return sha256HexSync(content);
}

/** Rust `VfsNoteRepo::validate_title` (500 chars, no control characters except tab). */
export function validateTitle(title: string): void {
  if (title.trim().length === 0) {
    throw new Error("Invalid argument 'title': 标题不能为空");
  }
  if (Array.from(title).length > 500) {
    throw new Error("Invalid argument 'title': 标题过长（最多 500 个字符）");
  }
  for (const ch of title) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      if (ch !== '\t') throw new Error("Invalid argument 'title': 标题不能包含换行等控制字符");
    }
  }
}

/** chrono `format("%Y-%m-%dT%H:%M:%S%.3fZ")` (note_repo.rs:33). */
function threeDecimalZ(epochNanos: bigint): string {
  return `${chronoStamp(civilTime(epochNanos, false), ':', true)}Z`;
}

export function isoNow(): string {
  return threeDecimalZ(nowEpochNanos());
}

/** Rust `note_repo::next_updated_at`: now, or current + 1ms when that is larger. */
export function nextUpdatedAt(current: string): string {
  const now = nowEpochNanos();
  const parsed = parseRfc3339(current);
  const minimum = parsed === null ? now : parsed.epochNanos + 1_000_000n;
  return threeDecimalZ(now > minimum ? now : minimum);
}

// ------------------------------------------------------------------ writes via plugins

/** Rust `VfsFolderRepo::create_folder` lives in `vfsRepo#folders`. */
export function createFolder(deps: MemoryVfsDependencies, db: SqlExecutor, title: string,
  parentId: string | null): VfsFolder {
  const now = Date.now();
  const folder: VfsFolder = {
    id: `fld_${nanoid(10)}`, parentId, title, icon: null, color: null, isExpanded: true,
    isFavorite: false, sortOrder: 0, createdAt: now, updatedAt: now,
  };
  deps.repos.folders.createFolder(db, {
    ...folder, parentId: parentId ?? undefined, icon: undefined, color: undefined,
  });
  return folder;
}

export function moveFolder(deps: MemoryVfsDependencies, db: SqlExecutor, folderId: string,
  parentId: string | null): void {
  deps.repos.folders.moveFolder(db, folderId, parentId);
}

/** Rust `VfsFolderRepo::delete_folder_with_conn` for an already-emptied repair folder. */
export function softDeleteFolder(deps: MemoryVfsDependencies, db: SqlExecutor, folderId: string): void {
  deps.repos.folders.deleteFolder(db, folderId);
}

export function addItemToFolder(deps: MemoryVfsDependencies, db: SqlExecutor, folderId: string | null,
  itemType: string, itemId: string): void {
  deps.repos.folders.addItemToFolder(db, {
    id: `fi_${nanoid(10)}`, folderId: folderId ?? undefined, itemType, itemId, sortOrder: 0,
    createdAt: Date.now(),
  });
}

export function moveItemToFolder(deps: MemoryVfsDependencies, db: SqlExecutor, itemType: string,
  itemId: string, folderId: string | null): void {
  deps.repos.folders.moveItemToFolder(db, itemType, itemId, folderId);
}

/** Rust `VfsNoteRepo::create_note_in_folder` runs in the notes plugin's transaction. */
export function createNote(deps: MemoryVfsDependencies, db: SqlExecutor,
  params: CreateNoteParams, folderId: string | null): VfsNote {
  const note = deps.notes.createNoteInFolder(params, folderId, db);
  return { ...note, deletedAt: note.deletedAt ?? null };
}

/** Rust `VfsNoteRepo::update_note_with_conn` (CAS + resource swap). */
export function updateNote(deps: MemoryVfsDependencies, db: SqlExecutor, noteId: string,
  params: UpdateNoteParams): VfsNote {
  const note = deps.notes.updateNote(noteId, params, db);
  return { ...note, deletedAt: note.deletedAt ?? null };
}

/** Rust `VfsNoteRepo::delete_note_with_folder_item_with_conn`. */
export function deleteNoteWithFolderItem(deps: MemoryVfsDependencies, db: SqlExecutor,
  noteId: string): void {
  deps.notes.deleteNoteWithFolderItem(noteId, db);
}

export type MemoryResourceWriter = Pick<ResourceRepository, 'createOrReuseWithHash'>;

/** Rust `VfsResourceRepo::create_or_reuse_with_conn` for non-note resource types. */
export function createOrReuseTypedResource(resources: MemoryResourceWriter, db: SqlExecutor,
  params: {
    type: VfsResourceType;
    content: string;
    hash: string;
    sourceId: string | null;
    sourceTable: string | null;
    metadata: VfsResourceMetadata | null;
  }): string {
  return resources.createOrReuseWithHash(db, params.type, params.content, params.hash,
    params.sourceId, params.sourceTable, params.metadata).resourceId;
}

/** Direct index-state writes exist only in the repository; service callers warn on failure. */
export function markPending(deps: MemoryVfsDependencies, db: SqlExecutor, resourceId: string): void {
  deps.repos.indexStates.markPending(db, resourceId);
}
export function markDisabled(deps: MemoryVfsDependencies, db: SqlExecutor, resourceId: string,
  reason: string): void {
  deps.repos.indexStates.markDisabledWithReason(db, resourceId, reason);
}
export function markIndexed(deps: MemoryVfsDependencies, db: SqlExecutor, resourceId: string,
  hash: string): void {
  deps.repos.indexStates.markIndexed(db, resourceId, hash);
}

const notesWithRefQuery = defineQuery<[string], { id: string; tags: string | null }>(
  'SELECT id, tags FROM notes WHERE deleted_at IS NULL AND tags LIKE ?1', { name: 'vfs.note.withTag' });

/**
 * Rust `MemoryService::remove_incoming_refs` (service.rs:3495-3532): tags-only rewrite through
 * the L10 owner seam (no `updated_at` bump); the first write error propagates.
 */
export function removeIncomingRefs(deps: MemoryVfsDependencies, db: SqlExecutor,
  deletedNoteId: string, info: (message: string) => void): number {
  const refTag = `_ref:${deletedNoteId}`;
  let cleaned = 0;
  for (const row of db.all(notesWithRefQuery, [`%"${refTag}"%`])) {
    const tags = parseTags(row.tags ?? '[]');
    const kept = tags.filter(tag => tag !== refTag);
    if (kept.length === tags.length) continue;
    deps.notes.rewriteTagsWithoutTouchingUpdatedAtWithConn(db, row.id, JSON.stringify(kept));
    cleaned += 1;
  }
  if (cleaned > 0) {
    info(`[Memory] Removed dangling _ref tags pointing to ${deletedNoteId} from ${cleaned} notes`);
  }
  return cleaned;
}

const aliveNotesQuery = (count: number) => defineQuery<string[], { id: string }>(
  `SELECT id FROM notes WHERE id IN (${Array.from({ length: count }, () => '?').join(', ')}) AND deleted_at IS NULL`,
  { name: 'vfs.note.alive' });
const aliveCache = new Map<number, ReturnType<typeof aliveNotesQuery>>();

export function filterAliveNoteIds(db: SqlExecutor, noteIds: readonly string[]): string[] {
  if (noteIds.length === 0) return [];
  let query = aliveCache.get(noteIds.length);
  if (query === undefined) {
    query = aliveNotesQuery(noteIds.length);
    aliveCache.set(noteIds.length, query);
  }
  const alive = new Set(db.all(query, [...noteIds]).map(row => row.id));
  return noteIds.filter(id => alive.has(id));
}

export const SEARCH_HITS_BOOST_TOP_N = 3;
const TAG_HITS_PREFIX = '_hits:';
const TAG_LAST_HIT_PREFIX = '_last_hit:';
const TAG_LAST_INJECTED_PREFIX = '_last_injected:';

/**
 * Rust `MemoryService::record_search_hits`: direct tag rewrite (no `updated_at`
 * change). Ranked results only boost `_hits` for the first
 * `SEARCH_HITS_BOOST_TOP_N`; every hit refreshes `_last_hit` and drops `_stale`.
 */
export function recordSearchHits(deps: MemoryVfsDependencies, db: SqlExecutor,
  noteIds: readonly string[], nowMs: number): void {
  for (const [rank, noteId] of noteIds.entries()) {
    const row = db.get<{ tags: string | null }>(
      'SELECT tags FROM notes WHERE id = ?1 AND deleted_at IS NULL', [noteId]);
    if (row === undefined) continue;
    const tags = parseTags(row.tags ?? '[]');
    const boostHits = rank < SEARCH_HITS_BOOST_TOP_N;
    let hits = 1;
    const kept = tags.filter(tag => {
      if (tag.startsWith(TAG_HITS_PREFIX)) {
        if (!boostHits) return true;
        hits = Number.parseInt(tag.slice(TAG_HITS_PREFIX.length), 10) + 1;
        return false;
      }
      if (tag.startsWith(TAG_LAST_HIT_PREFIX)) return false;
      return tag !== '_stale';
    });
    if (boostHits) kept.push(`${TAG_HITS_PREFIX}${Number.isFinite(hits) ? hits : 1}`);
    kept.push(`${TAG_LAST_HIT_PREFIX}${nowMs}`);
    deps.notes.rewriteTagsWithoutTouchingUpdatedAtWithConn(db, noteId, JSON.stringify(kept));
  }
}

/**
 * Rust `MemoryService::record_injection_presence` loop body: replace `_last_injected:` with
 * the current stamp; `_hits`/`_stale` untouched, `updated_at` untouched. A failed UPDATE for
 * one note only warns and the loop continues.
 */
export function recordInjectionPresenceNotes(deps: MemoryVfsDependencies, db: SqlExecutor,
  noteIds: readonly string[], nowMs: number, warn: (message: string) => void): void {
  for (const noteId of noteIds) {
    const row = db.get<{ tags: string | null }>(
      'SELECT tags FROM notes WHERE id = ?1 AND deleted_at IS NULL', [noteId]);
    if (row === undefined || row.tags === null) continue;
    const kept = parseTags(row.tags).filter(tag => !tag.startsWith(TAG_LAST_INJECTED_PREFIX));
    kept.push(`${TAG_LAST_INJECTED_PREFIX}${nowMs}`);
    try { deps.notes.rewriteTagsWithoutTouchingUpdatedAtWithConn(db, noteId, JSON.stringify(kept)); }
    catch (error) { warn(`[Memory] Failed to record injection presence for ${noteId}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

const TAG_USED_PREFIX = '_used:';
const U32_MAX = 4_294_967_295;

/** Rust `str::parse::<u32>()`: optional `+`, ASCII digits only, no overflow. */
function parseU32(value: string): number | null {
  if (!/^\+?[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= U32_MAX ? parsed : null;
}

/**
 * Rust `MemoryService::record_used` loop body: `_used:N` +1 (unparsable → 1),
 * refresh `_last_hit`, drop `_stale`; direct tag rewrite without `updated_at`.
 * A failed UPDATE for one note only warns and the loop continues.
 */
export function recordUsedNotes(deps: MemoryVfsDependencies, db: SqlExecutor,
  noteIds: readonly string[], nowMs: number, warn: (message: string) => void): void {
  for (const noteId of noteIds) {
    const row = db.get<{ tags: string | null }>(
      'SELECT tags FROM notes WHERE id = ?1 AND deleted_at IS NULL', [noteId]);
    if (row === undefined || row.tags === null) continue;
    const tags = parseTags(row.tags);
    let used = 1;
    const kept = tags.filter(tag => {
      if (tag.startsWith(TAG_USED_PREFIX)) {
        used = (parseU32(tag.slice(TAG_USED_PREFIX.length)) ?? 0) + 1;
        return false;
      }
      if (tag.startsWith(TAG_LAST_HIT_PREFIX)) return false;
      return tag !== '_stale';
    });
    kept.push(`${TAG_USED_PREFIX}${used}`, `${TAG_LAST_HIT_PREFIX}${nowMs}`);
    try { deps.notes.rewriteTagsWithoutTouchingUpdatedAtWithConn(db, noteId, JSON.stringify(kept)); }
    catch (error) { warn(`[Memory] Failed to record usage signal for ${noteId}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
