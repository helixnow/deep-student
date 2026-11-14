import { rustTrim } from '../../../platform/util/portable.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  VfsEssay,
  VfsExamSheet,
  VfsFile,
  VfsMindMap,
  VfsTextbook,
  VfsTranslation,
} from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import type { VfsNote } from '../../../../contracts/ipc/generated/_shared.ts';
import type { VfsEssaySession } from '../src/node-converters.ts';
import { VfsError } from '../src/error.ts';
import { nowIso } from './create.ts';
import { getFolderWithConn } from './folders.ts';
import { vfsRepositories, vfsRepositoryLog } from './services.ts';
import { parseOcrPages } from '../src/ocr.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import { fs } from '../src/local-runtime.ts';

function withSavepoint<T>(conn: SqlExecutor, name: string, operation: () => T): T {
  conn.exec(`SAVEPOINT ${name}`);
  try {
    const value = operation();
    conn.exec(`RELEASE SAVEPOINT ${name}`);
    return value;
  } catch (error) {
    try { conn.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`); }
    catch { // boundary-allow empty-catch: mindmap_repo.rs:1199,1236,1499 discards rollback results before returning the original failure
      // Preserve the original failure, as Rust does.
    }
    throw error;
  }
}

function database<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw error instanceof VfsError
      ? error
      : new VfsError('Database', error instanceof Error ? error.message : String(error));
  }
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === undefined || raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseStringArray(raw: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(raw, []);
  return Array.isArray(parsed) && parsed.every(value => typeof value === 'string') ? parsed : [];
}

function parseValueArray(raw: string | null | undefined): unknown[] {
  const parsed = parseJson<unknown>(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

interface NoteRow {
  id: string;
  resource_id: string;
  title: string;
  tags: string;
  is_favorite: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  props: string | null;
}

function noteFromRow(row: NoteRow): VfsNote {
  const props = parseJson<unknown>(row.props, undefined);
  return {
    id: row.id,
    resourceId: row.resource_id,
    title: row.title,
    tags: parseStringArray(row.tags),
    isFavorite: row.is_favorite !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
    ...(props === undefined || typeof props !== 'object' || props === null || Array.isArray(props)
      ? {}
      : { props }),
  };
}

const NOTE_COLUMNS = 'id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props';

export function getNoteWithConn(conn: SqlExecutor, noteId: string): VfsNote | undefined {
  return database(() => {
    const row = conn.get<NoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?1 AND deleted_at IS NULL`,
      [noteId],
    );
    return row === undefined ? undefined : noteFromRow(row);
  });
}

/** `escape_like_pattern` (note_repo.rs:1069-1073). */
export function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/** `build_fts_match_query` (note_repo.rs:1085-1091); trigram needs 3+ chars. */
export function buildFtsMatchQuery(keyword: string): string | undefined {
  const trimmed = rustTrim(keyword);
  if ([...trimmed].length < 3) return undefined;
  return `"${trimmed.replaceAll('"', '""')}"`;
}

export interface NoteListLog {
  warn(message: string, ...args: unknown[]): void;
}

/** `VfsNoteRepo::list_notes_with_conn` (note_repo.rs:1281-1350). */
export function listNotesWithConn(
  conn: SqlExecutor,
  search: string | null | undefined,
  limit: number,
  offset: number,
  log?: NoteListLog,
): VfsNote[] {
  return database(() => {
    if (search !== undefined && search !== null && rustTrim(search) !== '') {
      const matchQuery = buildFtsMatchQuery(search);
      if (matchQuery !== undefined) {
        let ftsRows: NoteRow[] = [];
        try {
          ftsRows = conn.all<NoteRow>(
            `SELECT ${NOTE_COLUMNS.split(', ').map(column => `n.${column}`).join(', ')}
             FROM notes_fts
             JOIN notes n ON n.rowid = notes_fts.rowid
             WHERE notes_fts MATCH ?1 AND n.deleted_at IS NULL
             ORDER BY bm25(notes_fts, 5.0, 1.0), n.updated_at DESC, n.id ASC
             LIMIT ?2 OFFSET ?3`,
            [matchQuery, limit, offset],
          );
        } catch (error) {
          // note_repo.rs:1297-1303 warns and falls back to the LIKE path.
          log?.warn(
            '[VFS::NoteRepo] FTS search failed, falling back to LIKE: %s',
            error instanceof Error ? error.message : String(error),
          );
        }
        if (ftsRows.length > 0) return ftsRows.map(noteFromRow);
      }
    }

    if (search !== undefined && search !== null) {
      const pattern = `%${escapeLikePattern(search)}%`;
      return conn.all<NoteRow>(
        `SELECT ${NOTE_COLUMNS.split(', ').map(column => `n.${column}`).join(', ')}
         FROM notes n
         WHERE n.deleted_at IS NULL
           AND (n.title LIKE ?1 ESCAPE '\\' OR EXISTS (
             SELECT 1 FROM resources r WHERE r.id = n.resource_id AND r.data LIKE ?2 ESCAPE '\\'
           ))
         ORDER BY n.updated_at DESC LIMIT ?3 OFFSET ?4`,
        [pattern, pattern, limit, offset],
      ).map(noteFromRow);
    }

    return conn.all<NoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM notes
       WHERE deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2`,
      [limit, offset],
    ).map(noteFromRow);
  });
}

/** `VfsNoteRepo::list_deleted_notes_with_conn` (note_repo.rs:2140-2166). */
export function listDeletedNotesWithConn(
  conn: SqlExecutor,
  limit: number,
  offset: number,
): VfsNote[] {
  return database(() => conn.all<NoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM notes
     WHERE deleted_at IS NOT NULL
     ORDER BY deleted_at DESC
     LIMIT ?1 OFFSET ?2`,
    [limit, offset],
  ).map(noteFromRow));
}

interface FileRow {
  id: string;
  resource_id: string | null;
  blob_hash: string | null;
  sha256: string;
  file_name: string;
  original_path: string | null;
  size: number;
  page_count: number | null;
  file_type: string;
  mime_type: string | null;
  tags_json: string | null;
  is_favorite: number;
  last_opened_at: string | null;
  last_page: number | null;
  bookmarks_json: string | null;
  cover_key: string | null;
  extracted_text: string | null;
  preview_json: string | null;
  ocr_pages_json: string | null;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  processing_status: string | null;
  processing_progress: string | null;
  processing_error: string | null;
  processing_started_at: number | null;
  processing_completed_at: number | null;
  compressed_blob_hash: string | null;
}

function fileFromRow(row: FileRow): VfsFile {
  return {
    id: row.id,
    resourceId: row.resource_id,
    blobHash: row.blob_hash,
    sha256: row.sha256,
    fileName: row.file_name,
    originalPath: row.original_path,
    size: row.size,
    pageCount: row.page_count,
    fileType: row.file_type,
    mimeType: row.mime_type,
    tags: parseStringArray(row.tags_json),
    isFavorite: row.is_favorite !== 0,
    lastOpenedAt: row.last_opened_at,
    lastPage: row.last_page,
    bookmarks: parseValueArray(row.bookmarks_json),
    coverKey: row.cover_key,
    extractedText: row.extracted_text,
    previewJson: row.preview_json,
    ocrPagesJson: row.ocr_pages_json,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    processingStatus: row.processing_status,
    processingProgress: row.processing_progress,
    processingError: row.processing_error,
    processingStartedAt: row.processing_started_at,
    processingCompletedAt: row.processing_completed_at,
    compressedBlobHash: row.compressed_blob_hash,
  } satisfies VfsFile;
}

/** `VfsFileRepo::get_file` intentionally does not filter `deleted_at` (file_repo.rs:729-749). */
export function getFileWithConn(conn: SqlExecutor, fileId: string): VfsFile | undefined {
  return database(() => {
    const row = conn.get<FileRow>(
      `SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
              "type" AS file_type, mime_type, tags_json, is_favorite, last_opened_at, last_page,
              bookmarks_json, cover_key, extracted_text, preview_json, ocr_pages_json, description,
              status, created_at, updated_at, deleted_at, processing_status, processing_progress,
              processing_error, processing_started_at, processing_completed_at, compressed_blob_hash
       FROM files WHERE id = ?1`,
      [fileId],
    );
    return row === undefined ? undefined : fileFromRow(row);
  });
}

interface TextbookRow {
  id: string;
  resource_id: string | null;
  blob_hash: string | null;
  sha256: string;
  file_name: string;
  original_path: string | null;
  size: number;
  page_count: number | null;
  tags_json: string | null;
  is_favorite: number;
  last_opened_at: string | null;
  last_page: number | null;
  bookmarks_json: string | null;
  cover_key: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  resource_metadata_json: string | null;
}

/** `VfsTextbookRepo::get_textbook_with_conn` (textbook_repo.rs:425-445). */
export function getTextbookWithConn(conn: SqlExecutor, textbookId: string): VfsTextbook | undefined {
  return database(() => {
    const row = conn.get<TextbookRow>(
      `SELECT ${TEXTBOOK_COLUMNS}
       FROM files f
       LEFT JOIN resources r ON r.id = f.resource_id
       WHERE f.id = ?1`,
      [textbookId],
    );
    return row === undefined ? undefined : textbookFromRow(row);
  });
}

const TEXTBOOK_COLUMNS = `f.id, f.resource_id, f.blob_hash, f.sha256, f.file_name, f.original_path, f.size,
              f.page_count, f.tags_json, f.is_favorite, f.last_opened_at, f.last_page,
              f.bookmarks_json, f.cover_key, f.status, f.created_at, f.updated_at, r.metadata_json AS resource_metadata_json`;

function textbookFromRow(row: TextbookRow): VfsTextbook {
  const metadata = parseJson<Record<string, unknown> | null>(row.resource_metadata_json, null);
  const extra = metadata !== null && typeof metadata.extra === 'object' && metadata.extra !== null
    ? metadata.extra as Record<string, unknown>
    : undefined;
  const highlights = extra !== undefined && Array.isArray(extra.highlights) ? extra.highlights : [];
  return {
    id: row.id,
    resourceId: row.resource_id,
    blobHash: row.blob_hash,
    sha256: row.sha256,
    fileName: row.file_name,
    originalPath: row.original_path,
    size: row.size,
    pageCount: row.page_count,
    tags: parseStringArray(row.tags_json),
    isFavorite: row.is_favorite !== 0,
    lastOpenedAt: row.last_opened_at,
    lastPage: row.last_page,
    bookmarks: parseValueArray(row.bookmarks_json),
    highlights,
    coverKey: row.cover_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies VfsTextbook;
}

/** `VfsTextbookRepo::list_textbooks_with_conn` (textbook_repo.rs:491-512). */
export function listTextbooksWithConn(conn: SqlExecutor, limit: number, offset: number): VfsTextbook[] {
  return database(() => conn.all<TextbookRow>(
    `SELECT ${TEXTBOOK_COLUMNS}
     FROM files f
     LEFT JOIN resources r ON r.id = f.resource_id
     WHERE f.status = 'active'
     ORDER BY f.updated_at DESC
     LIMIT ?1 OFFSET ?2`,
    [limit, offset],
  ).map(textbookFromRow));
}

/** `VfsTextbookRepo::list_deleted_textbooks_with_conn` (textbook_repo.rs:1246-1266). */
export function listDeletedTextbooksWithConn(conn: SqlExecutor, limit: number, offset: number): VfsTextbook[] {
  return database(() => conn.all<TextbookRow>(
    `SELECT ${TEXTBOOK_COLUMNS}
     FROM files f
     LEFT JOIN resources r ON r.id = f.resource_id
     WHERE f.status = 'deleted' AND f.id LIKE 'tb_%'
     ORDER BY f.updated_at DESC
     LIMIT ?1 OFFSET ?2`,
    [limit, offset],
  ).map(textbookFromRow));
}

interface ExamRow {
  id: string;
  resource_id: string | null;
  exam_name: string | null;
  status: string;
  temp_id: string;
  metadata_json: string;
  preview_json: string;
  linked_mistake_ids: string | null;
  is_favorite: number;
  created_at: string;
  updated_at: string;
}

const EXAM_COLUMNS = `id, resource_id, exam_name, status, temp_id, metadata_json, preview_json,
              linked_mistake_ids, is_favorite, created_at, updated_at`;

function examFromRow(row: ExamRow): VfsExamSheet {
  const linked = parseJson<unknown>(row.linked_mistake_ids, undefined);
  return {
    id: row.id,
    resourceId: row.resource_id,
    examName: row.exam_name,
    status: row.status,
    tempId: row.temp_id,
    metadataJson: parseJson<unknown>(row.metadata_json, null),
    previewJson: parseJson<unknown>(row.preview_json, null),
    ...(Array.isArray(linked) && linked.every(value => typeof value === 'string')
      ? { linkedMistakeIds: linked as string[] }
      : {}),
    isFavorite: row.is_favorite !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getExamWithConn(conn: SqlExecutor, examId: string): VfsExamSheet | undefined {
  return database(() => {
    const row = conn.get<ExamRow>(
      `SELECT ${EXAM_COLUMNS}
       FROM exam_sheets WHERE id = ?1 AND deleted_at IS NULL`,
      [examId],
    );
    return row === undefined ? undefined : examFromRow(row);
  });
}

/** `VfsExamRepo::list_exam_sheets_with_conn` (exam_repo.rs:73-115). */
export function listExamsWithConn(
  conn: SqlExecutor,
  search: string | null | undefined,
  limit: number,
  offset: number,
): VfsExamSheet[] {
  return database(() => {
    if (search !== undefined && search !== null) {
      return conn.all<ExamRow>(
        `SELECT ${EXAM_COLUMNS}
         FROM exam_sheets
         WHERE deleted_at IS NULL AND exam_name LIKE ?1 ESCAPE '\\'
         ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3`,
        [`%${escapeLikePattern(search)}%`, limit, offset],
      ).map(examFromRow);
    }
    return conn.all<ExamRow>(
      `SELECT ${EXAM_COLUMNS}
       FROM exam_sheets
       WHERE deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2`,
      [limit, offset],
    ).map(examFromRow);
  });
}

/** `VfsExamRepo::list_deleted_exams_with_conn` (exam_repo.rs:1291-1310). */
export function listDeletedExamsWithConn(conn: SqlExecutor, limit: number, offset: number): VfsExamSheet[] {
  return database(() => conn.all<ExamRow>(
    `SELECT ${EXAM_COLUMNS}
     FROM exam_sheets
     WHERE deleted_at IS NOT NULL
     ORDER BY deleted_at DESC LIMIT ?1 OFFSET ?2`,
    [limit, offset],
  ).map(examFromRow));
}

interface TranslationRow {
  id: string;
  resource_id: string;
  title: string | null;
  src_lang: string;
  tgt_lang: string;
  engine: string | null;
  model: string | null;
  is_favorite: number;
  quality_rating: number | null;
  created_at: string;
  updated_at: string | null;
  metadata_json: string | null;
  content_json: string | null;
}

const TRANSLATION_SELECT_WITH_CONTENT = `SELECT t.id, t.resource_id, t.title, t.src_lang, t.tgt_lang, t.engine, t.model,
              t.is_favorite, t.quality_rating, t.created_at, t.updated_at, t.metadata_json,
              r.data AS content_json
       FROM translations t
       LEFT JOIN resources r ON t.resource_id = r.id`;

function translationFromRow(row: TranslationRow): VfsTranslation {
  const content = parseJson<Record<string, unknown> | null>(row.content_json, null);
  const sourceText = content !== null && typeof content.source === 'string' ? content.source : undefined;
  const translatedText = content !== null && typeof content.translated === 'string'
    ? content.translated
    : undefined;
  return {
    id: row.id,
    resourceId: row.resource_id,
    title: row.title,
    srcLang: row.src_lang,
    tgtLang: row.tgt_lang,
    engine: row.engine,
    model: row.model,
    isFavorite: row.is_favorite !== 0,
    qualityRating: row.quality_rating,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson<unknown>(row.metadata_json, undefined),
    sourceText,
    translatedText,
  } satisfies VfsTranslation;
}

export function getTranslationWithConn(conn: SqlExecutor, translationId: string): VfsTranslation | undefined {
  return database(() => {
    const row = conn.get<TranslationRow>(
      `${TRANSLATION_SELECT_WITH_CONTENT}
       WHERE t.id = ?1 AND t.deleted_at IS NULL`,
      [translationId],
    );
    return row === undefined ? undefined : translationFromRow(row);
  });
}

/** `VfsTranslationRepo::list_translations_with_conn` (translation_repo.rs:136-183). */
export function listTranslationsWithConn(
  conn: SqlExecutor,
  search: string | null | undefined,
  limit: number,
  offset: number,
): VfsTranslation[] {
  return database(() => {
    if (search !== undefined && search !== null) {
      const pattern = `%${escapeLikePattern(search)}%`;
      return conn.all<TranslationRow>(
        `${TRANSLATION_SELECT_WITH_CONTENT}
         WHERE t.deleted_at IS NULL
           AND (t.title LIKE ?1 ESCAPE '\\' OR r.data LIKE ?2 ESCAPE '\\')
         ORDER BY t.created_at DESC LIMIT ?3 OFFSET ?4`,
        [pattern, pattern, limit, offset],
      ).map(translationFromRow);
    }
    return conn.all<TranslationRow>(
      `${TRANSLATION_SELECT_WITH_CONTENT}
       WHERE t.deleted_at IS NULL
       ORDER BY t.created_at DESC LIMIT ?1 OFFSET ?2`,
      [limit, offset],
    ).map(translationFromRow);
  });
}

/** `VfsTranslationRepo::list_deleted_translations_with_conn` (translation_repo.rs:945-964). */
export function listDeletedTranslationsWithConn(
  conn: SqlExecutor,
  limit: number,
  offset: number,
): VfsTranslation[] {
  return database(() => conn.all<TranslationRow>(
    `${TRANSLATION_SELECT_WITH_CONTENT}
     WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC LIMIT ?1 OFFSET ?2`,
    [limit, offset],
  ).map(translationFromRow));
}

interface EssayRow {
  id: string;
  resource_id: string;
  title: string | null;
  essay_type: string | null;
  grading_result_json: string | null;
  score: number | null;
  session_id: string | null;
  round_number: number | null;
  grade_level: string | null;
  custom_prompt: string | null;
  dimension_scores_json: string | null;
  is_favorite: number;
  created_at: string;
  updated_at: string;
}

const ESSAY_COLUMNS = `id, resource_id, title, essay_type, grading_result_json, score, session_id,
              round_number, grade_level, custom_prompt, dimension_scores_json, is_favorite,
              created_at, updated_at`;

function essayFromRow(row: EssayRow): VfsEssay {
  return {
    id: row.id,
    resourceId: row.resource_id,
    title: row.title,
    essayType: row.essay_type,
    gradingResult: parseJson<unknown>(row.grading_result_json, undefined),
    score: row.score,
    sessionId: row.session_id,
    roundNumber: row.round_number ?? 1,
    gradeLevel: row.grade_level,
    customPrompt: row.custom_prompt,
    isFavorite: row.is_favorite !== 0,
    dimensionScores: parseJson<unknown>(row.dimension_scores_json, undefined),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies VfsEssay;
}

export function getEssayWithConn(conn: SqlExecutor, essayId: string): VfsEssay | undefined {
  return database(() => {
    const row = conn.get<EssayRow>(
      `SELECT ${ESSAY_COLUMNS}
       FROM essays WHERE id = ?1 AND deleted_at IS NULL`,
      [essayId],
    );
    return row === undefined ? undefined : essayFromRow(row);
  });
}

interface SessionRow {
  id: string;
  title: string;
  essay_type: string | null;
  grade_level: string | null;
  custom_prompt: string | null;
  total_rounds: number;
  latest_score: number | null;
  is_favorite: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const SESSION_COLUMNS = `id, title, essay_type, grade_level, custom_prompt, total_rounds, latest_score,
              is_favorite, created_at, updated_at, deleted_at`;

function sessionFromRow(row: SessionRow): VfsEssaySession {
  return {
    id: row.id,
    title: row.title,
    essayType: row.essay_type,
    gradeLevel: row.grade_level,
    totalRounds: row.total_rounds,
    latestScore: row.latest_score,
    isFavorite: row.is_favorite !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export function getEssaySessionWithConn(conn: SqlExecutor, sessionId: string): VfsEssaySession | undefined {
  return database(() => {
    const row = conn.get<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM essay_sessions WHERE id = ?1 AND deleted_at IS NULL`,
      [sessionId],
    );
    return row === undefined ? undefined : sessionFromRow(row);
  });
}

/** `VfsEssayRepo::list_sessions_with_conn` (essay_repo.rs:911-931). */
export function listEssaySessionsWithConn(conn: SqlExecutor, limit: number, offset: number): VfsEssaySession[] {
  return database(() => conn.all<SessionRow>(
    `SELECT ${SESSION_COLUMNS}
     FROM essay_sessions
     WHERE deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT ?1 OFFSET ?2`,
    [limit, offset],
  ).map(sessionFromRow));
}

/** `VfsEssayRepo::list_deleted_sessions_with_conn` (essay_repo.rs:1205-1228). */
export function listDeletedEssaySessionsWithConn(
  conn: SqlExecutor,
  limit: number,
  offset: number,
): VfsEssaySession[] {
  return database(() => conn.all<SessionRow>(
    `SELECT ${SESSION_COLUMNS}
     FROM essay_sessions
     WHERE deleted_at IS NOT NULL
     ORDER BY deleted_at DESC
     LIMIT ?1 OFFSET ?2`,
    [limit, offset],
  ).map(sessionFromRow));
}

interface MindmapRow {
  id: string;
  resource_id: string;
  title: string;
  description: string | null;
  is_favorite: number;
  default_view: string;
  theme: string | null;
  settings: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  content_updated_at: string;
}

const MINDMAP_COLUMNS = `id, resource_id, title, description, is_favorite, default_view, theme, settings,
              created_at, updated_at, deleted_at, COALESCE(content_updated_at, updated_at) AS content_updated_at`;

function mindmapFromRow(row: MindmapRow): VfsMindMap {
  return {
    id: row.id,
    resourceId: row.resource_id,
    title: row.title,
    description: row.description,
    isFavorite: row.is_favorite !== 0,
    defaultView: row.default_view,
    theme: row.theme,
    settings: parseJson<unknown>(row.settings, undefined),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contentUpdatedAt: row.content_updated_at,
    deletedAt: row.deleted_at,
  } satisfies VfsMindMap;
}

export function getMindmapWithConn(conn: SqlExecutor, mindmapId: string): VfsMindMap | undefined {
  return database(() => {
    const row = conn.get<MindmapRow>(
      `SELECT ${MINDMAP_COLUMNS}
       FROM mindmaps WHERE id = ?1 AND deleted_at IS NULL`,
      [mindmapId],
    );
    return row === undefined ? undefined : mindmapFromRow(row);
  });
}

/** `VfsMindMapRepo::list_mindmaps_with_conn` (mindmap_repo.rs:1014-1049); no pagination. */
export function listMindmapsWithConn(conn: SqlExecutor): VfsMindMap[] {
  return database(() => conn.all<MindmapRow>(
    `SELECT ${MINDMAP_COLUMNS}
     FROM mindmaps
     WHERE deleted_at IS NULL
     ORDER BY updated_at DESC`,
  ).map(mindmapFromRow));
}

/** `VfsMindMapRepo::list_deleted_mindmaps_with_conn` (mindmap_repo.rs:1412-1459). */
export function listDeletedMindmapsWithConn(
  conn: SqlExecutor,
  limit: number,
  offset: number,
): VfsMindMap[] {
  return database(() => conn.all<MindmapRow>(
    `SELECT ${MINDMAP_COLUMNS}
     FROM mindmaps
     WHERE deleted_at IS NOT NULL
     ORDER BY deleted_at DESC
     LIMIT ?1 OFFSET ?2`,
    [limit, offset],
  ).map(mindmapFromRow));
}

/** `VfsMindMapRepo::restore_mindmap_with_conn` (mindmap_repo.rs:1154-1203). */
export function restoreMindmapWithConn(conn: SqlExecutor, mindmapId: string): VfsMindMap {
  return database(() => withSavepoint(conn, 'restore_mindmap', () => {
    const now = nowIso();
    const affected = conn.run(
      'UPDATE mindmaps SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NOT NULL',
      [now, mindmapId],
    ).changes;
    if (affected === 0) {
      throw new VfsError('NotFound', { resource_type: 'MindMap (deleted)', id: mindmapId });
    }
    conn.run(
      "UPDATE folder_items SET deleted_at = NULL, updated_at = ?1 WHERE item_id = ?2 AND item_type = 'mindmap'",
      [Date.now(), mindmapId],
    );
    const mindmap = getMindmapWithConn(conn, mindmapId);
    if (mindmap === undefined) {
      throw new VfsError('NotFound', { resource_type: 'MindMap', id: mindmapId });
    }
    return mindmap;
  }));
}

function purgeMindmapResourceIfOrphaned(conn: SqlExecutor, resourceId: string): void {
  const mindmapRefs = Number(conn.pluck<number>(
    'SELECT COUNT(*) FROM mindmaps WHERE resource_id = ?1', [resourceId]) ?? 0);
  const versionRefs = Number(conn.pluck<number>(
    'SELECT COUNT(*) FROM mindmap_versions WHERE resource_id = ?1', [resourceId]) ?? 0);
  if (mindmapRefs !== 0 || versionRefs !== 0) return;
  vfsRepositories().embeddingUnits.purgeIndexArtifactsByResource(conn, resourceId);
  conn.run('DELETE FROM resources WHERE id = ?1', [resourceId]);
}

/** `VfsMindMapRepo::purge_mindmap_inner` (mindmap_repo.rs:1247-1332). */
export function purgeMindmapWithConn(conn: SqlExecutor, mindmapId: string): void {
  database(() => withSavepoint(conn, 'vfs_mindmap_purge_tx', () => {
    const resourceId = conn.pluck<string | null>(
      'SELECT resource_id FROM mindmaps WHERE id = ?1', [mindmapId]);
    const versionResourceIds: string[] = [];
    for (const row of conn.all<{ resource_id: string | null }>(
      'SELECT resource_id FROM mindmap_versions WHERE mindmap_id = ?1', [mindmapId])) {
      if (typeof row.resource_id === 'string') versionResourceIds.push(row.resource_id);
    }

    conn.run('DELETE FROM mindmap_versions WHERE mindmap_id = ?1', [mindmapId]);
    conn.run('DELETE FROM mindmaps WHERE id = ?1', [mindmapId]);
    conn.run("DELETE FROM folder_items WHERE item_id = ?1 AND item_type = 'mindmap'", [mindmapId]);

    if (typeof resourceId === 'string') {
      vfsRepositories().resources.decrementRef(conn, resourceId);
      purgeMindmapResourceIfOrphaned(conn, resourceId);
    }
    for (const versionResourceId of versionResourceIds) {
      const remaining = vfsRepositories().resources.decrementRef(conn, versionResourceId);
      if (remaining <= 0) purgeMindmapResourceIfOrphaned(conn, versionResourceId);
    }
  }));
}

/** `VfsMindMapRepo::purge_deleted_mindmaps_with_conn` (mindmap_repo.rs:1473-1506). */
export function purgeDeletedMindmapsWithConn(conn: SqlExecutor): number {
  return database(() => {
    const ids = conn.all<{ id: string }>(
      'SELECT id FROM mindmaps WHERE deleted_at IS NOT NULL').map(row => row.id);
    if (ids.length === 0) return 0;
    return withSavepoint(conn, 'purge_deleted_mindmaps', () => {
      for (const id of ids) purgeMindmapWithConn(conn, id);
      return ids.length;
    });
  });
}

/** `VfsFileRepo::list_files_by_type_with_conn` (file_repo.rs:866-896). */
export function listFilesByTypeWithConn(
  conn: SqlExecutor,
  fileType: string,
  limit: number,
  offset: number,
): VfsFile[] {
  return database(() => conn.all<FileRow>(
    `SELECT id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
            "type" AS file_type, mime_type, tags_json, is_favorite, last_opened_at, last_page,
            bookmarks_json, cover_key, extracted_text, preview_json, ocr_pages_json, description,
            status, created_at, updated_at, deleted_at,
            processing_status, processing_progress, processing_error,
            processing_started_at, processing_completed_at,
            compressed_blob_hash
     FROM files
     WHERE "type" = ?1 AND status = 'active'
     ORDER BY updated_at DESC
     LIMIT ?2 OFFSET ?3`,
    [fileType, limit, offset],
  ).map(fileFromRow));
}

/** `VfsNoteRepo::get_note_content_with_conn` (note_repo.rs:981-1045). */
export function getNoteContentWithConn(conn: SqlExecutor, noteId: string): string | undefined {
  return database(() => {
    const content = conn.pluck<string | null>(
      `SELECT r.data FROM notes n
       JOIN resources r ON n.resource_id = r.id
       WHERE n.id = ?1 AND n.deleted_at IS NULL`,
      [noteId],
    );
    if (content !== undefined && content !== null) return content;
    const note = conn.get<{ resource_id: string }>(
      'SELECT resource_id FROM notes WHERE id = ?1 AND deleted_at IS NULL',
      [noteId],
    );
    if (note === undefined) return undefined;
    const resourceExists = conn.pluck<number>('SELECT 1 FROM resources WHERE id = ?1', [note.resource_id]);
    if (resourceExists === undefined) {
      throw new VfsError('Database', `Missing resource for note ${noteId}`);
    }
    return undefined;
  });
}

/** `VfsTranslationRepo::get_translation_content_with_conn` (translation_repo.rs:316-340). */
export function getTranslationContentWithConn(conn: SqlExecutor, translationId: string): string | undefined {
  return database(() => {
    const content = conn.get<{ data: string | null }>(
      `SELECT r.data AS data FROM translations t
       LEFT JOIN resources r ON t.resource_id = r.id
       WHERE t.id = ?1 AND t.deleted_at IS NULL`,
      [translationId],
    );
    return content === undefined || content.data === null ? undefined : content.data;
  });
}

/** `VfsEssayRepo::get_essay_content_with_conn` (essay_repo.rs:178-196). */
export function getEssayContentWithConn(conn: SqlExecutor, essayId: string): string | undefined {
  return database(() => {
    const content = conn.pluck<string | null>(
      `SELECT r.data FROM essays e
       JOIN resources r ON e.resource_id = r.id
       WHERE e.id = ?1 AND e.deleted_at IS NULL`,
      [essayId],
    );
    return content === undefined || content === null ? undefined : content;
  });
}

/** `VfsEssayRepo::list_essays_by_session_with_conn` (essay_repo.rs:113-137). */
export function listEssaysBySessionWithConn(conn: SqlExecutor, sessionId: string): VfsEssay[] {
  return database(() => conn.all<EssayRow>(
    `SELECT id, resource_id, title, essay_type, grading_result_json, score, session_id,
            round_number, grade_level, custom_prompt, dimension_scores_json, is_favorite,
            created_at, updated_at
     FROM essays
     WHERE session_id = ?1 AND deleted_at IS NULL
     ORDER BY round_number ASC, created_at ASC`,
    [sessionId],
  ).map(essayFromRow));
}

/** `VfsMindMapRepo::get_mindmap_content_with_conn` (mindmap_repo.rs:934-945). */
export function getMindmapContentWithConn(conn: SqlExecutor, mindmapId: string): string | undefined {
  const mindmap = getMindmapWithConn(conn, mindmapId);
  if (mindmap === undefined) return undefined;
  const data = database(() => conn.pluck<string | null>(
    'SELECT data FROM resources WHERE id = ?1',
    [mindmap.resourceId],
  ));
  return data === undefined || data === null ? undefined : data;
}

/** content_helpers.rs:33-85: direct id, resource id, then legacy resources.source_id. */
export function resolveFileIdForReadWithConn(conn: SqlExecutor, fileId: string): string | undefined {
  const optional = (sql: string, id: string): string | undefined => {
    try { return conn.pluck<string>(sql, [id]); }
    catch { return undefined; }
  };
  const direct = optional('SELECT id FROM files WHERE id = ?1 LIMIT 1', fileId);
  if (direct !== undefined) return direct;
  const byResource = optional('SELECT id FROM files WHERE resource_id = ?1 LIMIT 1', fileId);
  if (byResource !== undefined) return byResource;
  const resource = optional('SELECT id FROM resources WHERE source_id = ?1 LIMIT 1', fileId);
  return resource === undefined ? undefined : optional('SELECT id FROM files WHERE resource_id = ?1 LIMIT 1', resource);
}

/** `get_extracted_text_with_conn` (ref_handlers.rs:1427-1439). */
export function getExtractedTextWithConn(conn: SqlExecutor, sourceId: string): string | undefined {
  return database(() => {
    const text = conn.pluck<string | null>(
      `SELECT extracted_text FROM files WHERE id = ?1 OR resource_id = ?1
       ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END
       LIMIT 1`,
      [sourceId],
    );
    return text === undefined || text === null || rustTrim(text) === '' ? undefined : text;
  });
}

/** `parse_ocr_pages_json` (dstu-vfs/src/vfs/ocr_utils.rs:44-171). */
export function parseOcrPagesJson(json: string): Array<string | null> {
  return parseOcrPages(json, vfsRepositoryLog());
}

/** `join_ocr_pages_text_with_offset` (ocr_utils.rs:204-234). */
export function joinOcrPagesText(
  pages: Array<string | null>,
  startOffset = 0,
  headerPrefix = '第',
  headerSuffix = '页',
): string | undefined {
  const parts: string[] = [];
  pages.forEach((text, index) => {
    if (text === null) return;
    const trimmed = rustTrim(text);
    if (trimmed === '') return;
    parts.push(`--- ${headerPrefix} ${startOffset + index + 1} ${headerSuffix} ---\n${trimmed}`);
  });
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

/** `get_ocr_pages_text_with_conn` (ref_handlers.rs:1446-1468). */
export function getOcrPagesTextWithConn(conn: SqlExecutor, sourceId: string): string | undefined {
  return database(() => {
    const json = conn.pluck<string | null>(
      `SELECT ocr_pages_json FROM files WHERE id = ?1 OR resource_id = ?1
       ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END
       LIMIT 1`,
      [sourceId],
    );
    if (json === undefined || json === null || rustTrim(json) === '') return undefined;
    const pages = parseOcrPagesJson(json);
    return pages.length === 0 ? undefined : joinOcrPagesText(pages, 0, '第', '页');
  });
}

/** `get_image_ocr_text_with_conn` (ref_handlers.rs:1313-1408): resources.ocr_text. */
export function getImageOcrTextWithConn(conn: SqlExecutor, sourceId: string): string | undefined {
  return database(() => {
    const text = conn.pluck<string | null>(
      `SELECT r.ocr_text FROM files a
       JOIN resources r ON a.resource_id = r.id
       WHERE a.id = ?1 OR a.resource_id = ?1
       ORDER BY CASE WHEN a.id = ?1 THEN 0 ELSE 1 END
       LIMIT 1`,
      [sourceId],
    );
    return text === undefined || text === null || rustTrim(text) === '' ? undefined : text;
  });
}

/** `VfsFileRepo::get_content_with_conn` (file_repo.rs:1419-1500); base64 of the blob bytes. */
export function getFileContentWithConn(
  conn: SqlExecutor,
  blobsDir: string,
  fileId: string,
): string | undefined {
  const file = getFileWithConn(conn, fileId);
  if (file === undefined) return undefined;
  const hash = file.fileType === 'image' && file.compressedBlobHash !== null
    && file.compressedBlobHash !== undefined
    ? file.compressedBlobHash
    : file.blobHash;
  const blobHash = hash ?? file.resourceId ?? file.sha256;
  // RUST-FIX(RF-W10-blob-path-containment): file_repo.rs joins the synced relative_path unchecked.
  const blobPath = database(() => vfsRepositories().blobs.getBlobPath(conn, blobsDir, blobHash));
  if (blobPath === null) return undefined;
  try {
    const data = fs.readFileSync(blobPath);
    return toBase64(data);
  } catch (error) {
    throw new VfsError('Io', error instanceof Error ? error.message : String(error));
  }
}

/** `search_textbooks` (search_helpers.rs:279-374); PDFs only. */
export function searchTextbooksWithConn(
  conn: SqlExecutor,
  query: string,
  limit: number,
  offset: number,
): VfsTextbook[] {
  return database(() => conn.all<TextbookRow>(
    `SELECT ${TEXTBOOK_COLUMNS}
     FROM files f
     LEFT JOIN resources r ON r.id = f.resource_id
     WHERE f.status = 'active'
       AND f.file_name LIKE ?1 ESCAPE '\\'
       AND (f.mime_type LIKE '%pdf%' OR f.file_name LIKE '%.pdf')
     ORDER BY f.updated_at DESC
     LIMIT ?2 OFFSET ?3`,
    [`%${escapeLikePattern(query)}%`, limit, offset],
  ).map(textbookFromRow));
}

/** `search_essays` (search_helpers.rs:376-437). */
export function searchEssaySessionsWithConn(
  conn: SqlExecutor,
  query: string,
  limit: number,
  offset: number,
): VfsEssaySession[] {
  return database(() => conn.all<SessionRow>(
    `SELECT ${SESSION_COLUMNS}
     FROM essay_sessions
     WHERE deleted_at IS NULL AND title LIKE ?1 ESCAPE '\\'
     ORDER BY updated_at DESC
     LIMIT ?2 OFFSET ?3`,
    [`%${escapeLikePattern(query)}%`, limit, offset],
  ).map(sessionFromRow));
}

const SEARCH_FILE_COLUMNS = `id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
              "type" AS file_type, mime_type, tags_json, is_favorite, last_opened_at, last_page,
              bookmarks_json, cover_key, extracted_text, preview_json, ocr_pages_json, description,
              status, created_at, updated_at, deleted_at,
              NULL AS processing_status, NULL AS processing_progress, NULL AS processing_error,
              NULL AS processing_started_at, NULL AS processing_completed_at,
              NULL AS compressed_blob_hash`;

/** `search_files` (search_helpers.rs:439-536); excludes image types. */
export function searchFilesWithConn(
  conn: SqlExecutor,
  query: string,
  limit: number,
  offset: number,
): VfsFile[] {
  return database(() => conn.all<FileRow>(
    `SELECT ${SEARCH_FILE_COLUMNS}
     FROM files
     WHERE status = 'active'
       AND file_name LIKE ?1 ESCAPE '\\'
       AND ("type" IS NULL OR "type" != 'image')
     ORDER BY updated_at DESC
     LIMIT ?2 OFFSET ?3`,
    [`%${escapeLikePattern(query)}%`, limit, offset],
  ).map(fileFromRow));
}

/** `search_images` (search_helpers.rs:538-635). */
export function searchImagesWithConn(
  conn: SqlExecutor,
  query: string,
  limit: number,
  offset: number,
): VfsFile[] {
  return database(() => conn.all<FileRow>(
    `SELECT ${SEARCH_FILE_COLUMNS}
     FROM files
     WHERE status = 'active'
       AND file_name LIKE ?1 ESCAPE '\\'
       AND "type" = 'image'
     ORDER BY updated_at DESC
     LIMIT ?2 OFFSET ?3`,
    [`%${escapeLikePattern(query)}%`, limit, offset],
  ).map(fileFromRow));
}

/** `search_mindmaps` (search_helpers.rs:637-700). */
export function searchMindmapsWithConn(
  conn: SqlExecutor,
  query: string,
  limit: number,
  offset: number,
): VfsMindMap[] {
  return database(() => conn.all<MindmapRow>(
    `SELECT ${MINDMAP_COLUMNS}
     FROM mindmaps
     WHERE deleted_at IS NULL AND title LIKE ?1 ESCAPE '\\'
     ORDER BY updated_at DESC
     LIMIT ?2 OFFSET ?3`,
    [`%${escapeLikePattern(query)}%`, limit, offset],
  ).map(mindmapFromRow));
}

export interface IndexSegmentHit {
  resourceId: string;
  contentText: string;
}

/** `search_by_index` first query (search_helpers.rs:707-731). */
export function searchIndexSegmentsWithConn(
  conn: SqlExecutor,
  query: string,
  limit: number,
): IndexSegmentHit[] {
  return database(() => conn.all<{ resource_id: string; content_text: string }>(
    `SELECT DISTINCT u.resource_id AS resource_id, s.content_text AS content_text
     FROM vfs_index_segments s
     JOIN vfs_index_units u ON s.unit_id = u.id
     WHERE s.content_text LIKE ?1 ESCAPE '\\'
     GROUP BY u.resource_id
     LIMIT ?2`,
    [`%${escapeLikePattern(query)}%`, limit],
  ).map(row => ({ resourceId: row.resource_id, contentText: row.content_text })));
}

/** `VfsResourceRepo::get_resource_with_conn` (resource_repo.rs:317-334). */
export function getResourceSourceWithConn(
  conn: SqlExecutor,
  resourceId: string,
): { sourceId: string | null; sourceTable: string | null } | undefined {
  return database(() => {
    const row = conn.get<{ source_id: string | null; source_table: string | null }>(
      'SELECT source_id, source_table FROM resources WHERE id = ?1',
      [resourceId],
    );
    return row === undefined
      ? undefined
      : { sourceId: row.source_id, sourceTable: row.source_table };
  });
}

export { getFolderWithConn };
