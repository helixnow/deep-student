/** Update-side repositories used by dstu_update / dstu_set_metadata (Rust vfs/repos/*). */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { VfsRepositoryError, type JsonValue } from '../../vfs-repos/api.ts';
import { parseRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import type { NoteLeaseAuth, VfsNote } from '../../../../contracts/ipc/generated/_shared.ts';
import { nanoid } from '../src/nanoid.ts';
import { VfsError } from '../src/error.ts';
import {
  computeHash,
  computeHashWithSalt,
  createOrReuseResourceWithConn,
  currentDeviceId,
  normalizeMindmapContent,
  nowIso,
  validateNoteTags,
  validateNoteTitle,
} from './create.ts';
import { parseSerdeJson } from './json.ts';
import { callNoteRepository, notesLeaseRepository, notesRepository, vfsRepositories } from './services.ts';
import {
  getExamWithConn,
  getFileWithConn,
  getMindmapWithConn,
  getNoteWithConn,
  getTextbookWithConn,
  getTranslationWithConn,
} from './resources.ts';

function database<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw error instanceof VfsError
      ? error
      : new VfsError('Database', error instanceof Error ? error.message : String(error));
  }
}

function withSavepoint<T>(conn: SqlExecutor, name: string, operation: () => T): T {
  conn.exec(`SAVEPOINT ${name}`);
  try {
    const value = operation();
    conn.exec(`RELEASE SAVEPOINT ${name}`);
    return value;
  } catch (error) {
    try { conn.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`); }
    catch { // boundary-allow empty-catch: mindmap_repo.rs:797-804 discards rollback errors and returns the original update error
      // Preserve the original failure, as Rust does.
    }
    throw error;
  }
}

/** `next_updated_at` (note_repo.rs:56-68) / `next_timestamp_after` (mindmap_repo.rs:62-69). */
export function nextTimestampAfter(current: string): string {
  const now = Date.now();
  const parsed = parseRfc3339(current);
  const minimum = parsed === null ? now : parsed.millis + 1;
  return toRfc3339Opts(BigInt(Math.max(now, minimum)) * 1_000_000n, 'Millis', true);
}

export interface ResourceRow {
  id: string;
  hash: string;
  data: string | null;
}

/** `VfsResourceRepo::get_resource_with_conn` (resource_repo.rs:317-334). */
export function getResourceWithConn(conn: SqlExecutor, resourceId: string): ResourceRow | undefined {
  return database(() => conn.get<ResourceRow>(
    'SELECT id, hash, data FROM resources WHERE id = ?1', [resourceId]));
}

/** `VfsResourceRepo::update_resource_data_with_conn` (resource_repo.rs:778-835); writer is L11. */
export function updateResourceDataWithConn(
  conn: SqlExecutor,
  resourceId: string,
  newData: string,
): boolean {
  return vfsRepositories().resources.updateResourceData(conn, resourceId, newData);
}

export interface UpdateNoteParams {
  content?: string;
  title?: string;
  tags?: string[];
  expectedUpdatedAt?: string | null;
}

/**
 * `NoteLeaseRepo::authorized` (note_lease_repo.rs:307-361): cross-WebView freeze
 * barrier, ownership check and frozen-draft flush, all in the note_history_write
 * savepoint used by Rust.
 */
export function authorizedNoteLeaseWrite<T>(
  conn: SqlExecutor,
  auth: NoteLeaseAuth,
  webview: string,
  now: number,
  commit: boolean,
  work: () => T,
): T {
  return callNoteRepository(() => notesLeaseRepository().authorized(conn, auth, webview, now, commit, work));
}

/**
 * `VfsNoteRepo::update_note_authorized` (note_repo.rs:653-930).
 * L10 owns format capabilities, revision snapshots, note_links, relation invalidation
 * and index cleanup; delegate so those hooks run.
 */
export function updateNoteWithConn(
  conn: SqlExecutor,
  noteId: string,
  params: UpdateNoteParams,
): VfsNote {
  if (params.title !== undefined) validateNoteTitle(params.title);
  if (params.tags !== undefined) validateNoteTags(params.tags);
  return callNoteRepository(() => notesRepository().updateNote(noteId, params, conn));
}

/**
 * `VfsExamRepo::update_preview_json_with_conn` (exam_repo.rs:1352-1394); `preview` is the already
 * serialized `serde_json::Value` text (exact numbers / key order).
 */
export function updateExamPreviewJsonTextWithConn(
  conn: SqlExecutor,
  examId: string,
  preview: string,
): void {
  database(() => {
    const now = nowIso();
    const affected = conn.run(
      'UPDATE exam_sheets SET preview_json = ?1, updated_at = ?2 WHERE id = ?3',
      [preview, now, examId],
    ).changes;
    if (affected === 0) {
      throw new VfsError('NotFound', { resource_type: 'ExamSheet', id: examId });
    }
    const resourceId = conn.pluck<string | null>(
      'SELECT resource_id FROM exam_sheets WHERE id = ?1', [examId]);
    if (resourceId !== undefined && resourceId !== null) {
      updateResourceDataWithConn(conn, resourceId, preview);
    }
  });
}

export interface EssaySessionUpdate {
  title?: string;
  isFavorite?: boolean;
  essayType?: string;
  gradeLevel?: string;
  customPrompt?: string;
}

/** `VfsEssayRepo::update_session` (essay_repo.rs:934-1000). */
export function updateEssaySessionWithConn(
  conn: SqlExecutor,
  sessionId: string,
  update: EssaySessionUpdate,
): void {
  database(() => {
    const exists = conn.pluck<number>(
      'SELECT EXISTS(SELECT 1 FROM essay_sessions WHERE id = ?1)', [sessionId]);
    if ((exists ?? 0) === 0) {
      throw new VfsError('NotFound', { resource_type: 'EssaySession', id: sessionId });
    }
    const now = nowIso();
    if (update.title !== undefined) {
      conn.run('UPDATE essay_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3',
        [update.title, now, sessionId]);
    }
    if (update.isFavorite !== undefined) {
      conn.run('UPDATE essay_sessions SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3',
        [update.isFavorite ? 1 : 0, now, sessionId]);
    }
    if (update.essayType !== undefined) {
      conn.run('UPDATE essay_sessions SET essay_type = ?1, updated_at = ?2 WHERE id = ?3',
        [update.essayType, now, sessionId]);
    }
    if (update.gradeLevel !== undefined) {
      conn.run('UPDATE essay_sessions SET grade_level = ?1, updated_at = ?2 WHERE id = ?3',
        [update.gradeLevel, now, sessionId]);
    }
    if (update.customPrompt !== undefined) {
      conn.run('UPDATE essay_sessions SET custom_prompt = ?1, updated_at = ?2 WHERE id = ?3',
        [update.customPrompt, now, sessionId]);
    }
  });
}

/** `count_active_mindmaps_by_resource_id_with_conn` (mindmap_repo.rs). */
export function countActiveMindmapsByResourceIdWithConn(
  conn: SqlExecutor,
  resourceId: string,
): number {
  return Number(conn.pluck<number>(
    'SELECT COUNT(*) FROM mindmaps WHERE resource_id = ?1 AND deleted_at IS NULL',
    [resourceId],
  ) ?? 0);
}

export interface MindmapUpdate {
  title?: string;
  description?: string;
  content?: string;
  defaultView?: string;
  theme?: string;
  settings?: unknown;
  expectedUpdatedAt?: string;
}

export type MindmapContentUpdate = MindmapUpdate & { content: string };

export interface MindmapLog {
  warn(message: string, ...args: unknown[]): void;
}

const MINDMAP_AUTOSAVE_MERGE_WINDOW_MINUTES = 30;
const MAX_AUTOSAVE_VERSIONS = 20;

interface MindmapVersionRow {
  version_id: string;
  mindmap_id: string;
  resource_id: string;
  title: string;
  label: string | null;
  source: string | null;
  created_at: string;
}

function latestMindmapVersionInMergeWindow(
  conn: SqlExecutor,
  mindmapId: string,
  source: string | null,
): MindmapVersionRow | undefined {
  const latest = conn.get<MindmapVersionRow>(
    `SELECT version_id, mindmap_id, resource_id, title, label, source, created_at
     FROM mindmap_versions WHERE mindmap_id = ?1
     ORDER BY created_at DESC, version_id DESC LIMIT 1`,
    [mindmapId],
  );
  if (latest === undefined || latest.label !== null) return undefined;
  const normalizedSource = source ?? 'manual';
  if ((latest.source ?? 'manual') !== normalizedSource) return undefined;
  const createdAt = parseRfc3339(latest.created_at);
  if (createdAt === null) return undefined;
  const ageMs = Date.now() - createdAt.millis;
  if (ageMs >= MINDMAP_AUTOSAVE_MERGE_WINDOW_MINUTES * 60_000 || ageMs < 0) return undefined;
  return latest;
}

function pruneMindmapVersionsWithConn(
  conn: SqlExecutor,
  mindmapId: string,
  keepCount: number,
): void {
  const pruned = conn.all<{ version_id: string; resource_id: string }>(
    `SELECT version_id, resource_id FROM mindmap_versions
     WHERE mindmap_id = ?1
       AND (source IS NULL OR source NOT LIKE 'chat%')
       AND version_id NOT IN (
         SELECT version_id FROM mindmap_versions
         WHERE mindmap_id = ?1 AND (source IS NULL OR source NOT LIKE 'chat%')
         ORDER BY created_at DESC, version_id DESC LIMIT ?2
       )`,
    [mindmapId, keepCount],
  );
  if (pruned.length === 0) return;
  for (const row of pruned) {
    conn.run('DELETE FROM mindmap_versions WHERE version_id = ?1', [row.version_id]);
  }
  const resourceIds = [...new Set(pruned.map(row => row.resource_id))].sort();
  for (const resourceId of resourceIds) {
    vfsRepositories().resources.decrementRef(conn, resourceId);
    const mindmapRefs = Number(conn.pluck<number>(
      'SELECT COUNT(*) FROM mindmaps WHERE resource_id = ?1', [resourceId]) ?? 0);
    const versionRefs = Number(conn.pluck<number>(
      'SELECT COUNT(*) FROM mindmap_versions WHERE resource_id = ?1', [resourceId]) ?? 0);
    if (mindmapRefs === 0 && versionRefs === 0) {
      conn.run('DELETE FROM resources WHERE id = ?1', [resourceId]);
    }
  }
}

/** `VfsMindMapRepo::create_version_with_conn` (mindmap_repo.rs:1525-1611). */
function createMindmapVersionWithConn(
  conn: SqlExecutor,
  mindmapId: string,
  oldContent: string,
  title: string,
  label: string | null,
  source: string | null,
  log?: MindmapLog,
): void {
  const isChatSource = source !== null && source.startsWith('chat');
  const isMergeable = source === null || source === 'manual' || source === 'auto';
  if (isMergeable && label === null && latestMindmapVersionInMergeWindow(conn, mindmapId, source)) {
    return;
  }
  const versionId = `mv_${nanoid(10)}`;
  const now = nowIso();
  const snapshot = vfsRepositories().resources.createOrReuse(
    conn, 'mindmap', oldContent, versionId, 'mindmap_versions', null,
  );
  conn.run(
    `INSERT INTO mindmap_versions (version_id, mindmap_id, resource_id, title, label, source, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    [versionId, mindmapId, snapshot.resourceId, title, label, source, now],
  );
  if (!isChatSource) {
    try {
      pruneMindmapVersionsWithConn(conn, mindmapId, MAX_AUTOSAVE_VERSIONS);
    } catch (error) {
      log?.warn(
        '[VFS::MindMapRepo] Failed to prune autosave versions for %s: %s',
        mindmapId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * `VfsMindMapRepo::update_mindmap_returning_version_with_conn` (mindmap_repo.rs:540-790).
 * Mirrors the manual/DSTU path: `BEGIN IMMEDIATE`, old-content snapshot before the
 * content write, fail-open snapshot errors, and autosave-version pruning.
 */
export function updateMindmapWithConn(
  conn: SqlExecutor,
  mindmapId: string,
  update: MindmapUpdate,
  _log?: MindmapLog,
): void {
  vfsRepositories().mindmaps.updateMindmapWithConn(conn, mindmapId, {
    ...update,
    settings: update.settings as JsonValue | undefined,
    versionSource: 'manual',
  });
}

/** `VfsMindMapRepo::update_mindmap` content path used by dstu_update. */
export function updateMindmapContentWithConn(
  conn: SqlExecutor,
  mindmapId: string,
  update: MindmapContentUpdate,
  _log?: MindmapLog,
): void {
  try {
    vfsRepositories().mindmaps.updateMindmapWithConn(conn, mindmapId, {
      content: update.content,
      expectedUpdatedAt: update.expectedUpdatedAt,
      versionSource: 'manual',
    });
  } catch (error) {
    // Keep the existing Rust JSON Display at the DSTU boundary. Decode only
    // after the owner rejects content, preserving its not-found/OCC ordering.
    if (error instanceof VfsRepositoryError && error.code === 'VFS_INVALID_ARGUMENT'
      && error.data?.param === 'content') {
      try { parseSerdeJson(update.content); }
      catch (syntaxError) {
        throw new VfsError('InvalidArgument', { param: 'content',
          reason: `Invalid JSON: ${syntaxError instanceof Error ? syntaxError.message : String(syntaxError)}` });
      }
    }
    throw error;
  }
}

/** `VfsExamRepo::update_exam_name_with_conn` (exam_repo.rs:749-778). */
export function updateExamNameWithConn(
  conn: SqlExecutor,
  examId: string,
  newName: string,
): NonNullable<ReturnType<typeof getExamWithConn>> {
  return database(() => {
    const updated = conn.run(
      'UPDATE exam_sheets SET exam_name = ?1, updated_at = ?2 WHERE id = ?3',
      [newName, nowIso(), examId],
    ).changes;
    if (updated === 0) {
      throw new VfsError('NotFound', { resource_type: 'ExamSheet', id: examId });
    }
    const exam = getExamWithConn(conn, examId);
    if (exam === undefined) {
      throw new VfsError('NotFound', { resource_type: 'ExamSheet', id: examId });
    }
    return exam;
  });
}

/** `VfsTranslationRepo::update_title_with_conn` (translation_repo.rs:1032-1060). */
export function updateTranslationTitleWithConn(
  conn: SqlExecutor,
  translationId: string,
  newTitle: string,
): NonNullable<ReturnType<typeof getTranslationWithConn>> {
  return database(() => {
    const updated = conn.run(
      `UPDATE translations
       SET title = ?1, updated_at = ?2,
           local_version = COALESCE(local_version, 0) + 1, device_id = ?3
       WHERE id = ?4 AND deleted_at IS NULL`,
      [newTitle, nowIso(), currentDeviceId(), translationId],
    ).changes;
    if (updated === 0) {
      throw new VfsError('NotFound', { resource_type: 'Translation', id: translationId });
    }
    const translation = getTranslationWithConn(conn, translationId);
    if (translation === undefined) {
      throw new VfsError('NotFound', { resource_type: 'Translation', id: translationId });
    }
    return translation;
  });
}

function updateStoredFileName(
  conn: SqlExecutor,
  fileId: string,
  newName: string,
  resourceType: string,
): void {
  database(() => {
    const updated = conn.run(
      'UPDATE files SET file_name = ?1, updated_at = ?2 WHERE id = ?3',
      [newName, nowIso(), fileId],
    ).changes;
    if (updated === 0) {
      throw new VfsError('NotFound', { resource_type: resourceType, id: fileId });
    }
    const file = getFileWithConn(conn, fileId);
    if (file === undefined) {
      throw new VfsError('NotFound', { resource_type: resourceType, id: fileId });
    }
  });
}

/** `VfsFileRepo::update_file_name_with_conn` (file_repo.rs:907-933). */
export function updateFileNameWithConn(
  conn: SqlExecutor,
  fileId: string,
  newName: string,
): NonNullable<ReturnType<typeof getFileWithConn>> {
  updateStoredFileName(conn, fileId, newName, 'File');
  const file = getFileWithConn(conn, fileId);
  if (file === undefined) {
    throw new VfsError('NotFound', { resource_type: 'File', id: fileId });
  }
  return file;
}

/** `VfsTextbookRepo::update_file_name_with_conn` (textbook_repo.rs:626-656). */
export function updateTextbookFileNameWithConn(
  conn: SqlExecutor,
  textbookId: string,
  newName: string,
): void {
  updateStoredFileName(conn, textbookId, newName, 'Textbook');
}

// ============================================================================
// dstu_set_metadata repositories
// ============================================================================

const MAX_PROPS = 32;
const MAX_PROP_KEY_CHARS = 64;
const MAX_PROP_VALUE_CHARS = 512;
const PROPS_RESERVED_KEYS = ['tags', 'tag', 'path', 'title', 'isfavorite', 'snippet', 'props'];

function codePointLength(value: string): number {
  return [...value].length;
}

/** Rust `char::is_control` covers exactly the Unicode Cc category. */
function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** `note_props::validate_prop_key` + `PropKeyError::reason` (note_props.rs:62-93). */
function validatePropKey(key: string): string {
  const trimmed = rustTrim(key);
  if (trimmed === '') {
    throw new VfsError('InvalidArgument', { param: 'props', reason: '属性名不能为空' });
  }
  if (codePointLength(trimmed) > MAX_PROP_KEY_CHARS) {
    throw new VfsError('InvalidArgument', {
      param: 'props',
      reason: `属性名过长（最多 ${MAX_PROP_KEY_CHARS} 个字符）`,
    });
  }
  if (PROPS_RESERVED_KEYS.includes(trimmed.toLowerCase())) {
    throw new VfsError('InvalidArgument', {
      param: 'props',
      reason: `属性名 ${JSON.stringify(trimmed)} 为保留字`,
    });
  }
  if (hasControl(trimmed)) {
    throw new VfsError('InvalidArgument', { param: 'props', reason: '属性名不能包含控制字符' });
  }
  return trimmed;
}

/** `VfsNoteRepo::normalize_note_props` (note_repo.rs:1934-1956). */
function normalizeNoteProps(props: unknown): string | null {
  if (props === null || typeof props !== 'object' || Array.isArray(props)) {
    throw new VfsError('InvalidArgument', { param: 'props', reason: 'props 必须是键值对象' });
  }
  const entries = Object.entries(props as Record<string, unknown>);
  if (entries.length > MAX_PROPS) {
    throw new VfsError('InvalidArgument', {
      param: 'props',
      reason: `属性数量超出上限（最多 ${MAX_PROPS} 个）`,
    });
  }
  const normalizedKeys = new Set<string>();
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const trimmed = validatePropKey(key);
    const lowered = trimmed.toLowerCase();
    if (normalizedKeys.has(lowered)) {
      throw new VfsError('InvalidArgument', {
        param: 'props',
        reason: `属性名 ${JSON.stringify(trimmed)} 与已有属性重复`,
      });
    }
    normalizedKeys.add(lowered);
    if (typeof value === 'string') {
      if (codePointLength(value) > MAX_PROP_VALUE_CHARS) {
        throw new VfsError('InvalidArgument', {
          param: 'props',
          reason: `属性值过长（最多 ${MAX_PROP_VALUE_CHARS} 个字符）`,
        });
      }
      if (hasControl(value)) {
        throw new VfsError('InvalidArgument', { param: 'props', reason: '属性值不能包含控制字符' });
      }
    } else if (typeof value !== 'number' && typeof value !== 'boolean') {
      throw new VfsError('InvalidArgument', {
        param: 'props',
        reason: '属性值只支持字符串、数字或布尔',
      });
    }
    normalized[trimmed] = value;
  }
  if (Object.keys(normalized).length === 0) return null;
  return JSON.stringify(normalized);
}

export interface NoteMetadataUpdate {
  title?: string;
  tags?: string[];
  isFavorite?: boolean;
  props?: unknown;
  expectedUpdatedAt?: string | null;
}

/** `VfsNoteRepo::update_note_metadata_with_conn` (note_repo.rs:1972-2098); L10 hooks. */
export function updateNoteMetadataWithConn(
  conn: SqlExecutor,
  noteId: string,
  update: NoteMetadataUpdate,
): VfsNote {
  if (update.title !== undefined) validateNoteTitle(update.title);
  if (update.tags !== undefined) validateNoteTags(update.tags);
  if (update.props !== undefined) normalizeNoteProps(update.props);
  return callNoteRepository(() => notesRepository().updateNoteMetadata(noteId, update, conn));
}

/** `VfsTranslationRepo::set_favorite_with_conn` (translation_repo.rs:527-553). */
export function setTranslationFavoriteWithConn(
  conn: SqlExecutor,
  translationId: string,
  favorite: boolean,
): void {
  const updated = conn.run(
    `UPDATE translations
     SET is_favorite = ?1, updated_at = ?2,
         local_version = COALESCE(local_version, 0) + 1, device_id = ?3
     WHERE id = ?4 AND deleted_at IS NULL`,
    [favorite ? 1 : 0, nowIso(), currentDeviceId(), translationId],
  ).changes;
  if (updated === 0) {
    throw new VfsError('NotFound', { resource_type: 'Translation', id: translationId });
  }
}

/** `VfsTranslationRepo::set_quality_rating_with_conn` (translation_repo.rs:566-595). */
export function setTranslationQualityRatingWithConn(
  conn: SqlExecutor,
  translationId: string,
  rating: number,
): void {
  if (!(rating >= 1 && rating <= 5)) {
    throw new VfsError('InvalidArgument', {
      param: 'rating',
      reason: 'Rating must be between 1 and 5',
    });
  }
  const updated = conn.run(
    `UPDATE translations
     SET quality_rating = ?1, updated_at = ?2,
         local_version = COALESCE(local_version, 0) + 1, device_id = ?3
     WHERE id = ?4 AND deleted_at IS NULL`,
    [rating, nowIso(), currentDeviceId(), translationId],
  ).changes;
  if (updated === 0) {
    throw new VfsError('NotFound', { resource_type: 'Translation', id: translationId });
  }
}

/** `VfsTranslationRepo::get_translation_content_with_conn` (translation_repo.rs:316-334). */
export function getTranslationContentWithConn(
  conn: SqlExecutor,
  translationId: string,
): string | undefined {
  const row = conn.get<{ data: string | null }>(
    `SELECT r.data FROM translations t
     LEFT JOIN resources r ON t.resource_id = r.id
     WHERE t.id = ?1 AND t.deleted_at IS NULL`,
    [translationId],
  );
  if (row === undefined || row.data === null || row.data === '') return undefined;
  return row.data;
}

/** `VfsTranslationRepo::update_translation_content_with_conn` (translation_repo.rs:772-856). */
export function updateTranslationContentWithConn(
  conn: SqlExecutor,
  translationId: string,
  source: string,
  translated: string,
): void {
  const resourceId = conn.pluck<string | null>(
    'SELECT resource_id FROM translations WHERE id = ?1 AND deleted_at IS NULL',
    [translationId],
  );
  if (resourceId === undefined || resourceId === null) {
    throw new VfsError('NotFound', { resource_type: 'Translation', id: translationId });
  }
  const content = JSON.stringify({ source, translated });
  const saltedHash = computeHashWithSalt(content, translationId);
  const sharers = Number(conn.pluck<number>(
    'SELECT COUNT(*) FROM translations WHERE resource_id = ?1 AND id != ?2',
    [resourceId, translationId],
  ) ?? 0);
  const now = nowIso();
  const nowMs = Date.now();

  withSavepoint(conn, 'update_translation_content', () => {
    if (sharers > 0) {
      const newResourceId = createOrReuseResourceWithConn(
        conn, 'translation', content, saltedHash, translationId, 'translations',
      );
      conn.run(
        `UPDATE translations
         SET resource_id = ?1, updated_at = ?2,
             local_version = COALESCE(local_version, 0) + 1, device_id = ?3
         WHERE id = ?4`,
        [newResourceId, now, currentDeviceId(), translationId],
      );
    } else {
      conn.run(
        `UPDATE resources SET data = ?1, hash = ?2, updated_at = ?3,
            index_state = 'pending', index_error = NULL,
            index_retry_count = 0, index_next_retry_at = 0
         WHERE id = ?4`,
        [content, saltedHash, nowMs, resourceId],
      );
      conn.run(
        `UPDATE translations
         SET updated_at = ?1,
             local_version = COALESCE(local_version, 0) + 1, device_id = ?2
         WHERE id = ?3`,
        [now, currentDeviceId(), translationId],
      );
    }
  });
}

/** `VfsEssayRepo::update_title_with_conn` (essay_repo.rs:457-475). */
export function updateEssayTitleWithConn(
  conn: SqlExecutor,
  essayId: string,
  title: string,
): void {
  const updated = conn.run(
    'UPDATE essays SET title = ?1, updated_at = ?2 WHERE id = ?3',
    [title, nowIso(), essayId],
  ).changes;
  if (updated === 0) {
    throw new VfsError('NotFound', { resource_type: 'Essay', id: essayId });
  }
}

/** `VfsEssayRepo` raw favorite write in dstu_set_metadata (handlers.rs:3599-3619). */
export function setEssayFavoriteLooseWithConn(
  conn: SqlExecutor,
  essayId: string,
  favorite: boolean,
): void {
  // Rust ignores the affected-row count here; a missing essay surfaces later as
  // `操作失败` when the node is re-read.
  conn.run(
    'UPDATE essays SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3',
    [favorite ? 1 : 0, nowIso(), essayId],
  );
}

/** handlers.rs:3615-3690 raw essay field writes; missing rows fail open. */
export function updateEssayFieldLooseWithConn(
  conn: SqlExecutor,
  essayId: string,
  field: 'grade_level' | 'essay_type',
  value: string,
): void {
  // The column name is a closed union rather than caller-supplied input.
  conn.run(
    `UPDATE essays SET ${field} = ?1, updated_at = ?2 WHERE id = ?3`,
    [value, nowIso(), essayId],
  );
}

/** `VfsTextbookRepo::update_reading_progress_with_conn` (textbook_repo.rs:570-585). */
export function updateTextbookReadingProgressWithConn(
  conn: SqlExecutor,
  textbookId: string,
  lastPage: number,
): void {
  const now = nowIso();
  conn.run(
    'UPDATE files SET last_page = ?1, last_opened_at = ?2, updated_at = ?2 WHERE id = ?3',
    [lastPage, now, textbookId],
  );
}

/** `VfsTextbookRepo::set_favorite_with_conn` (textbook_repo.rs:667-682). */
export function setTextbookFavoriteWithConn(
  conn: SqlExecutor,
  textbookId: string,
  favorite: boolean,
): void {
  conn.run(
    'UPDATE files SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3',
    [favorite ? 1 : 0, nowIso(), textbookId],
  );
}

/** `VfsTextbookRepo::update_bookmarks_with_conn` (textbook_repo.rs:695-712). */
export function updateTextbookBookmarksWithConn(
  conn: SqlExecutor,
  textbookId: string,
  bookmarks: unknown[],
): void {
  conn.run(
    'UPDATE files SET bookmarks_json = ?1, updated_at = ?2 WHERE id = ?3',
    [JSON.stringify(bookmarks), nowIso(), textbookId],
  );
}

/** `ensure_annotation_revision` (textbook_repo.rs:2030-2041). */
function ensureAnnotationRevision(
  textbook: { updatedAt: string },
  expectedUpdatedAt: string,
): void {
  if (textbook.updatedAt === expectedUpdatedAt) return;
  throw new VfsError('Conflict', {
    key: 'textbooks.annotations_conflict',
    message: `The textbook annotations changed (expected ${expectedUpdatedAt}, `
      + `current ${textbook.updatedAt}).`,
  });
}

/** `VfsTextbookRepo::replace_bookmarks_if_version` (textbook_repo.rs:715-752). */
export function replaceTextbookBookmarksIfVersion(
  conn: SqlExecutor,
  textbookId: string,
  bookmarks: unknown[],
  expectedUpdatedAt: string,
): NonNullable<ReturnType<typeof getTextbookWithConn>> {
  return database(() => withSavepoint(conn, 'replace_textbook_bookmarks', () => {
    const current = getTextbookWithConn(conn, textbookId);
    if (current === undefined) {
      throw new VfsError('NotFound', { resource_type: 'Textbook', id: textbookId });
    }
    ensureAnnotationRevision(current, expectedUpdatedAt);
    const nextUpdatedAt = nextTimestampAfter(current.updatedAt);
    const changed = conn.run(
      'UPDATE files SET bookmarks_json = ?1, updated_at = ?2 WHERE id = ?3 AND updated_at = ?4',
      [JSON.stringify(bookmarks), nextUpdatedAt, textbookId, current.updatedAt],
    ).changes;
    if (changed !== 1) {
      throw new VfsError('Conflict', {
        key: 'textbooks.annotations_conflict',
        message: 'The textbook annotations changed before the bookmark update committed.',
      });
    }
    const updated = getTextbookWithConn(conn, textbookId);
    if (updated === undefined) {
      throw new VfsError('NotFound', { resource_type: 'Textbook', id: textbookId });
    }
    return updated;
  }));
}

const MAX_ANNOTATION_METADATA_BYTES = 512 * 1024;

/** `VfsTextbookRepo::replace_highlights_if_version` (textbook_repo.rs:755-852). */
export function replaceTextbookHighlightsIfVersion(
  conn: SqlExecutor,
  textbookId: string,
  highlights: unknown[],
  expectedUpdatedAt: string,
): NonNullable<ReturnType<typeof getTextbookWithConn>> {
  return database(() => withSavepoint(conn, 'replace_textbook_highlights', () => {
    const current = getTextbookWithConn(conn, textbookId);
    if (current === undefined) {
      throw new VfsError('NotFound', { resource_type: 'Textbook', id: textbookId });
    }
    ensureAnnotationRevision(current, expectedUpdatedAt);
    const resourceId = current.resourceId;
    if (resourceId === undefined || resourceId === null) {
      throw new VfsError('InvalidState', {
        message: `Textbook ${textbookId} has no associated VFS resource`,
      });
    }

    const row = conn.get<{ metadata_json: string | null }>(
      'SELECT metadata_json FROM resources WHERE id = ?1', [resourceId],
    );
    if (row === undefined) {
      throw new VfsError('NotFound', { resource_type: 'Resource', id: resourceId });
    }
    let metadata: unknown;
    if (row.metadata_json === null) {
      metadata = {};
    } else {
      try {
        metadata = parseSerdeJson(row.metadata_json);
      } catch (error) {
        throw new VfsError('Serialization', error instanceof Error ? error.message : String(error));
      }
    }
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      throw new VfsError(
        'Serialization', 'Textbook resource metadata must be a JSON object',
      );
    }
    const object = metadata as Record<string, unknown>;
    if (object.extra === undefined) object.extra = {};
    if (typeof object.extra !== 'object' || object.extra === null || Array.isArray(object.extra)) {
      throw new VfsError(
        'Serialization', 'Textbook resource metadata.extra must be a JSON object',
      );
    }
    (object.extra as Record<string, unknown>).highlights = highlights;

    const serialized = JSON.stringify(metadata);
    if (utf8ByteLength(serialized) > MAX_ANNOTATION_METADATA_BYTES) {
      throw new VfsError('InvalidArgument', {
        param: 'highlights',
        reason: `serialized annotation metadata exceeds ${MAX_ANNOTATION_METADATA_BYTES} bytes`,
      });
    }

    const nextUpdatedAt = nextTimestampAfter(current.updatedAt);
    const nowMs = parseRfc3339(nextUpdatedAt)?.millis ?? Date.now();
    const resourceChanged = conn.run(
      'UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3',
      [serialized, nowMs, resourceId],
    ).changes;
    if (resourceChanged !== 1) {
      throw new VfsError('NotFound', { resource_type: 'Resource', id: resourceId });
    }
    const fileChanged = conn.run(
      'UPDATE files SET updated_at = ?1 WHERE id = ?2 AND updated_at = ?3',
      [nextUpdatedAt, textbookId, current.updatedAt],
    ).changes;
    if (fileChanged !== 1) {
      throw new VfsError('Conflict', {
        key: 'textbooks.annotations_conflict',
        message: 'The textbook annotations changed before the highlight update committed.',
      });
    }

    const updated = getTextbookWithConn(conn, textbookId);
    if (updated === undefined) {
      throw new VfsError('NotFound', { resource_type: 'Textbook', id: textbookId });
    }
    return updated;
  }));
}

/** `VfsExamRepo::set_favorite_with_conn` (exam_repo.rs:789-816). */
export function setExamFavoriteWithConn(
  conn: SqlExecutor,
  examId: string,
  favorite: boolean,
): void {
  const updated = conn.run(
    'UPDATE exam_sheets SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3',
    [favorite ? 1 : 0, nowIso(), examId],
  ).changes;
  if (updated === 0) {
    throw new VfsError('NotFound', { resource_type: 'ExamSheet', id: examId });
  }
}

/** `VfsFileRepo::set_favorite_with_conn` (file_repo.rs:940-955); no row check. */
export function setFileFavoriteWithConn(
  conn: SqlExecutor,
  fileId: string,
  favorite: boolean,
): void {
  conn.run(
    'UPDATE files SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3',
    [favorite ? 1 : 0, nowIso(), fileId],
  );
}

/** `VfsMindMapRepo::set_favorite_with_conn` (mindmap_repo.rs:1370-1393); no updated_at bump. */
export function setMindmapFavoriteWithConn(
  conn: SqlExecutor,
  mindmapId: string,
  favorite: boolean,
): void {
  const affected = conn.run(
    'UPDATE mindmaps SET is_favorite = ?1 WHERE id = ?2 AND deleted_at IS NULL',
    [favorite ? 1 : 0, mindmapId],
  ).changes;
  if (affected === 0) {
    throw new VfsError('NotFound', { resource_type: 'MindMap', id: mindmapId });
  }
}

/** `VfsNoteRepo::set_favorite_with_conn` (note_repo.rs:1917-1932); no row check. */
export function setNoteFavoriteLooseWithConn(
  conn: SqlExecutor,
  noteId: string,
  favorite: boolean,
): void {
  callNoteRepository(() => notesRepository().setFavorite(noteId, favorite, conn));
}

/** `VfsFolderRepo::set_favorite_with_conn` (folder_repo.rs:2022-2045). */
export function setFolderFavoriteWithConn(
  conn: SqlExecutor,
  folderId: string,
  favorite: boolean,
): void {
  const affected = conn.run(
    'UPDATE folders SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3',
    [favorite ? 1 : 0, Date.now(), folderId],
  ).changes;
  if (affected === 0) throw new VfsError('FolderNotFound', { folder_id: folderId });
}
