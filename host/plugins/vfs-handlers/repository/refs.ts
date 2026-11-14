/**
 * SQL / pure helpers for `ref_handlers.rs` (resource references and context injection).
 * OCR-page, XML-escape and inject-mode helpers live in `src/ref-injection.ts`.
 *
 * Dynamic table names mirror `get_source_id_type`; every identifier comes from the
 * closed mapping below, never from user input.
 */
import type { Context } from '@deepseek-ai/cordis';
import { rustTrim, utf8ByteLength, charCount, takeChars } from '../../../platform/util/portable.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import { defineQuery } from '../../../platform/storage/query.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  BlobRepository,
  FileRepository,
  FolderRepository,
} from '../../vfs-repos/api.ts';
import type {
  MultimodalContentBlock,
  VfsResourceRef,
  VfsResourceType,
} from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import type { ResourceInjectModes } from '../../../../contracts/ipc/generated/_shared.ts';
import { escapeXmlAttr, escapeXmlContent, joinOcrPagesText, parseOcrPagesJson } from '../src/ref-injection.ts';

export {
  escapeXmlAttr,
  escapeXmlContent,
  joinOcrPagesText,
  parseOcrPagesJson,
  resolveImageInjectModes,
  resolvePdfInjectModes,
} from '../src/ref-injection.ts';

export type RefResourceType = VfsResourceType;

export interface SourceTypeInfo {
  type: RefResourceType;
  table: string;
  titleColumn: string;
}

/** ref_handlers.rs:1502-1538 `get_source_id_type`. */
export function getSourceIdType(sourceId: string): SourceTypeInfo | null {
  if (sourceId.startsWith('note_')) return { type: 'note', table: 'notes', titleColumn: 'title' };
  if (sourceId.startsWith('mm_')) return { type: 'mindmap', table: 'mindmaps', titleColumn: 'title' };
  // Rust `tb_` 教材；L11 使用 `file_` 前缀，两者都在 files 表。
  if (sourceId.startsWith('tb_')) return { type: 'textbook', table: 'files', titleColumn: 'file_name' };
  if (sourceId.startsWith('file_') || sourceId.startsWith('att_')) {
    return { type: 'file', table: 'files', titleColumn: 'file_name' };
  }
  if (sourceId.startsWith('exam_')) {
    return { type: 'exam', table: 'exam_sheets', titleColumn: 'COALESCE(exam_name, id)' };
  }
  if (sourceId.startsWith('tr_')) {
    return { type: 'translation', table: 'translations', titleColumn: 'COALESCE(title, id)' };
  }
  if (sourceId.startsWith('essay_session_')) {
    return { type: 'essay', table: 'essay_sessions', titleColumn: 'COALESCE(title, id)' };
  }
  if (sourceId.startsWith('essay_')) {
    return { type: 'essay', table: 'essays', titleColumn: 'COALESCE(title, id)' };
  }
  return null;
}

/** ref_handlers.rs:372-379 `qualify_title_expr_with_alias`. */
export function qualifyTitleExpr(titleColumn: string, alias: string): string {
  if (titleColumn === 'COALESCE(exam_name, id)') return `COALESCE(${alias}.exam_name, ${alias}.id)`;
  if (titleColumn === 'COALESCE(title, id)') return `COALESCE(${alias}.title, ${alias}.id)`;
  if (titleColumn.includes('(')) return titleColumn;
  return `${alias}.${titleColumn}`;
}

const RESOURCE_REF_TABLES = new Set(['notes', 'mindmaps', 'files', 'exam_sheets', 'translations', 'essays', 'essay_sessions']);

function knownTable(table: string): string {
  if (!RESOURCE_REF_TABLES.has(table)) throw new Error(`unexpected ref table: ${table}`);
  return table;
}

function canonicalFolderItemType(itemType: string): string {
  return itemType === 'textbook' ? 'file' : itemType;
}

const resourceRefQuery = defineQuery<[string], { title: string; hash: string | null }>(
  `SELECT %TITLE% AS title, r.hash AS hash
   FROM %TABLE% t LEFT JOIN resources r ON t.resource_id = r.id
   WHERE t.id = ?1 AND t.deleted_at IS NULL AND (r.deleted_at IS NULL OR r.id IS NULL)`,
  { name: 'vfs.refs.resourceRef' },
);

const attachmentTypeQuery = defineQuery<[string], { type: string | null }>(
  'SELECT type FROM files WHERE id = ?1 AND deleted_at IS NULL',
  { name: 'vfs.refs.attachmentType' },
);

const essaySessionTitleQuery = defineQuery<[string], { title: string }>(
  'SELECT COALESCE(title, id) AS title FROM essay_sessions WHERE id = ?1 AND deleted_at IS NULL',
  { name: 'vfs.refs.essaySessionTitle' },
);
const essaySessionHashQuery = defineQuery<[string], { hash: string }>(
  `SELECT COALESCE(r.hash, '') AS hash
   FROM essays e LEFT JOIN resources r ON e.resource_id = r.id
   WHERE e.session_id = ?1 AND e.deleted_at IS NULL
   ORDER BY e.round_number DESC, e.updated_at DESC LIMIT 1`,
  { name: 'vfs.refs.essaySessionHash' },
);
const essaySessionUpdatedAtQuery = defineQuery<[string], { value: string }>(
  "SELECT COALESCE(updated_at, '') AS value FROM essay_sessions WHERE id = ?1 AND deleted_at IS NULL",
  { name: 'vfs.refs.essaySessionUpdatedAt' },
);

const sourceIdByResourceIdQuery = defineQuery<[string], { source_id: string | null }>(
  'SELECT source_id FROM resources WHERE id = ?1 AND deleted_at IS NULL',
  { name: 'vfs.refs.sourceIdByResourceId' },
);

const folderItemForResourceQuery = defineQuery<[string, string], { folder_id: string | null }>(
  `SELECT folder_id FROM folder_items
   WHERE item_id = ?1 AND item_type = ?2 AND deleted_at IS NULL
   LIMIT 1`,
  { name: 'vfs.refs.folderItemForResource' },
);
const folderPathQuery = defineQuery<[string], { title: string }>(
  `WITH RECURSIVE folder_path AS (
     SELECT id, parent_id, title, 1 AS depth FROM folders WHERE id = ?1
     UNION ALL
     SELECT f.id, f.parent_id, f.title, fp.depth + 1
     FROM folders f JOIN folder_path fp ON f.id = fp.parent_id
     WHERE fp.depth < 11
   )
   SELECT title FROM folder_path ORDER BY depth DESC`,
  { name: 'vfs.refs.folderPath' },
);

const resourceDataQuery = defineQuery<[string], { data: string | null }>(
  'SELECT data FROM resources WHERE id = ?1',
  { name: 'vfs.refs.resourceData' },
);
const resourceIdBySourceQuery = defineQuery<[string], { resource_id: string | null }>(
  'SELECT resource_id FROM %TABLE% WHERE id = ?1',
  { name: 'vfs.refs.resourceIdBySource' },
);

const fileOcrPagesJsonQuery = defineQuery<[string], { ocr_pages_json: string | null }>(
  `SELECT ocr_pages_json FROM files
   WHERE id = ?1 OR resource_id = ?1
   ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1`,
  { name: 'vfs.refs.fileOcrPagesJson' },
);
const fileExtractedTextQuery = defineQuery<[string], { extracted_text: string | null }>(
  `SELECT extracted_text FROM files
   WHERE id = ?1 OR resource_id = ?1
   ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1`,
  { name: 'vfs.refs.fileExtractedText' },
);
const filePreviewRowQuery = defineQuery<[string], {
  preview_json: string | null; ocr_pages_json: string | null; file_name: string | null;
}>(
  `SELECT preview_json, ocr_pages_json, file_name FROM files
   WHERE id = ?1 OR resource_id = ?1
   ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1`,
  { name: 'vfs.refs.filePreviewRow' },
);
const imageOcrTextQuery = defineQuery<[string], { ocr_text: string | null }>(
  `SELECT r.ocr_text
   FROM files a JOIN resources r ON a.resource_id = r.id
   WHERE a.id = ?1 OR a.resource_id = ?1
   ORDER BY CASE WHEN a.id = ?1 THEN 0 ELSE 1 END LIMIT 1`,
  { name: 'vfs.refs.imageOcrText' },
);
const examPreviewQuery = defineQuery<[string], { preview_json: string | null }>(
  'SELECT preview_json FROM exam_sheets WHERE id = ?1',
  { name: 'vfs.refs.examPreview' },
);

const essaySessionInfoQuery = defineQuery<[string], {
  title: string; essay_type: string | null; total_rounds: number;
}>(
  `SELECT COALESCE(title, '') AS title, essay_type, total_rounds
   FROM essay_sessions WHERE id = ?1 AND deleted_at IS NULL`,
  { name: 'vfs.refs.essaySessionInfo' },
);
const essaySessionRowsQuery = defineQuery<[string], { round_number: number; data: string | null }>(
  `SELECT e.round_number, r.data
   FROM essays e LEFT JOIN resources r ON e.resource_id = r.id
   WHERE e.session_id = ?1 AND e.deleted_at IS NULL
   ORDER BY e.round_number ASC, e.created_at ASC`,
  { name: 'vfs.refs.essaySessionRows' },
);

function tableSql(query: { sql: string }, table: string, title = 'id'): string {
  return query.sql.replaceAll('%TABLE%', knownTable(table)).replaceAll('%TITLE%', title);
}

/** ref_handlers.rs:1553-1570 `get_attachment_type_with_conn`. */
export function getAttachmentType(conn: SqlExecutor, sourceId: string): RefResourceType {
  const row = conn.get(attachmentTypeQuery, [sourceId]);
  if (row?.type === 'image') return 'image';
  return 'file';
}

/** ref_handlers.rs:310-370 `get_resource_ref_with_conn`. */
export function getResourceRef(conn: SqlExecutor, sourceId: string): VfsResourceRef | null {
  const info = getSourceIdType(sourceId);
  if (info === null) return null;
  if (sourceId.startsWith('essay_session_')) return getEssaySessionRef(conn, sourceId);
  const type = sourceId.startsWith('att_') ? getAttachmentType(conn, sourceId) : info.type;
  const sql = tableSql(resourceRefQuery, info.table, qualifyTitleExpr(info.titleColumn, 't'));
  const row = conn.get<{ title: string; hash: string | null }>(sql, [sourceId]);
  if (row === undefined) return null;
  return {
    sourceId,
    resourceHash: row.hash ?? '',
    type,
    name: row.title,
  };
}

/** ref_handlers.rs:385-442 `get_essay_session_ref_with_conn`. */
function getEssaySessionRef(conn: SqlExecutor, sessionId: string): VfsResourceRef | null {
  const title = conn.get(essaySessionTitleQuery, [sessionId])?.title;
  if (title === undefined) return null;
  let hash = conn.get(essaySessionHashQuery, [sessionId])?.hash ?? '';
  if (hash === '') hash = conn.get(essaySessionUpdatedAtQuery, [sessionId])?.value ?? '';
  return { sourceId: sessionId, resourceHash: hash, type: 'essay', name: title };
}

/** ref_handlers.rs:445-490 `get_folder_refs_with_conn`. */
export function getFolderRefs(
  conn: SqlExecutor,
  folders: FolderRepository,
  folderId: string,
  maxItems: number,
): VfsResourceRef[] {
  const folderIds = folders.getFolderIdsRecursive(conn, folderId);
  const items = folders.getItemsByFolders(conn, folderIds);
  const refs: VfsResourceRef[] = [];
  for (const item of items) {
    if (refs.length >= maxItems) break;
    try {
      const ref = getResourceRef(conn, item.itemId);
      if (ref !== null) refs.push(ref);
    } catch {
      // Rust `if let Ok(Some(r))` skips an individual unreadable folder member.
      continue;
    }
  }
  return refs;
}

/** ref_handlers.rs:492-504 `get_folder_ref_count_with_conn`. */
export function getFolderRefCount(
  conn: SqlExecutor,
  folders: FolderRepository,
  folderId: string,
): number {
  const folderIds = folders.getFolderIdsRecursive(conn, folderId);
  const items = folders.getItemsByFolders(conn, folderIds);
  let count = 0;
  for (const item of items) if (getResourceRef(conn, item.itemId) !== null) count += 1;
  return count;
}

/** ref_handlers.rs:244-303 `vfs_get_resource_ref_count` body. */
export function getResourceRefCount(conn: SqlExecutor, sourceId: string): number {
  if (sourceId.startsWith('essay_session_')) {
    return Number(conn.pluck<number>(
      `SELECT COALESCE(SUM(COALESCE(r.ref_count, 0)), 0)
       FROM essays e LEFT JOIN resources r ON e.resource_id = r.id
       WHERE e.session_id = ?1 AND e.deleted_at IS NULL`, [sourceId]) ?? 0);
  }
  const info = getSourceIdType(sourceId);
  if (info !== null) {
    const sql = `SELECT COALESCE(r.ref_count, 0)
      FROM ${knownTable(info.table)} t LEFT JOIN resources r ON t.resource_id = r.id
      WHERE t.id = ?1 AND t.deleted_at IS NULL`;
    return Number(conn.pluck<number>(sql, [sourceId]) ?? 0);
  }
  try {
    return Number(conn.pluck<number>(
      'SELECT COALESCE(ref_count, 0) FROM resources WHERE source_id = ?1', [sourceId]) ?? 0);
  } catch (error) {
    throw new Error(`Query failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** ref_handlers.rs:1540-1551 `resolve_source_id_by_resource_id`. */
export function resolveSourceIdByResourceId(conn: SqlExecutor, resourceId: string): string | null {
  const value = conn.get(sourceIdByResourceIdQuery, [resourceId])?.source_id ?? null;
  return value !== null && rustTrim(value) !== '' ? value : null;
}

/** ref_handlers.rs:520-527 existence probe. */
export function resourceExists(conn: SqlExecutor, table: string, id: string): boolean {
  return conn.pluck<number>(
    `SELECT 1 FROM ${knownTable(table)} WHERE id = ?1 AND deleted_at IS NULL`, [id]) !== undefined;
}

/** ref_handlers.rs:981-1016 `get_resource_path_with_conn`. */
export function getResourcePath(
  conn: SqlExecutor,
  sourceId: string,
  type: RefResourceType,
): string {
  const item = conn.get(folderItemForResourceQuery, [sourceId, canonicalFolderItemType(type)]);
  if (item === undefined || item.folder_id === null) return sourceId;
  const titles = conn.all(folderPathQuery, [item.folder_id]).map(row => row.title);
  return `${titles.join('/')}/${sourceId}`;
}

/** ref_handlers.rs:1473-1494 `get_resource_title_with_conn`. */
export function getResourceTitle(conn: SqlExecutor, sourceId: string): string | null {
  const info = getSourceIdType(sourceId);
  if (info === null) return null;
  const row = conn.pluck<string | null>(
    `SELECT ${info.titleColumn} FROM ${knownTable(info.table)} WHERE id = ?1 AND deleted_at IS NULL`,
    [sourceId]);
  return row ?? null;
}

/** ref_handlers.rs:1042-1170 `get_resource_content_with_conn`. */
export function getRawResourceContent(
  conn: SqlExecutor,
  blobsDir: string,
  files: FileRepository,
  sourceId: string,
  type: RefResourceType,
  log: Context['logger'],
): string | null {
  log.info('[PDF_DEBUG] get_resource_content_with_conn: source_id=%s, resource_type=%s', sourceId, type);
  if (sourceId.startsWith('essay_session_')) return getEssaySessionContent(conn, sourceId, log);

  const info = getSourceIdType(sourceId);
  if (info === null) {
    log.info('[PDF_DEBUG] get_source_id_type returned None for source_id=%s', sourceId);
    return null;
  }
  log.info('[PDF_DEBUG] get_source_id_type: source_id=%s, inferred_type=%s, table_name=%s', sourceId, info.type, info.table);

  const resourceId = conn.get<{ resource_id: string | null }>(
    tableSql(resourceIdBySourceQuery, info.table), [sourceId])?.resource_id ?? null;
  log.info('[PDF_DEBUG] resource_id query: source_id=%s, resource_id=%s', sourceId, resourceId);
  if (resourceId !== null) {
    const data = conn.get(resourceDataQuery, [resourceId])?.data ?? null;
    log.info('[PDF_DEBUG] resources table query: res_id=%s, has_content=%s, content_len=%d', resourceId, data !== null, utf8ByteLength(data ?? ''));
    if (data !== null && data !== '') return data;
    if (data === '') log.info('[PDF_DEBUG] resources.data is empty string, falling back to blob/special handling');
    else log.info('[PDF_DEBUG] resources.data is NULL, falling back to blob/special handling');
  }
  log.info('[PDF_DEBUG] No resource_id found, falling back to special type handling: resource_type=%s', type);

  if (type === 'exam') {
    log.info('[PDF_DEBUG] Exam branch: returning preview_json');
    const preview = conn.get(examPreviewQuery, [sourceId])?.preview_json ?? null;
    log.info('[PDF_DEBUG] Exam preview_json len=%d', utf8ByteLength(preview ?? ''));
    return preview;
  }
  if (type === 'image' || type === 'file' || type === 'textbook') {
    log.info('[PDF_DEBUG] Image/File/Textbook branch: calling VfsFileRepo::get_content_with_conn');
    try {
      const content = files.getContent(conn, blobsDir, sourceId);
      if (content === null) log.info('[PDF_DEBUG] VfsFileRepo returned None');
      else log.info('[PDF_DEBUG] VfsFileRepo returned content, len=%d', utf8ByteLength(content));
      return content;
    } catch (error) { log.info('[PDF_DEBUG] VfsFileRepo returned error: %s', error); throw error; }
  }
  log.info('[PDF_DEBUG] %s branch: returning None (content should be in resources.data)', type === 'mindmap' ? 'MindMap' : type);
  return null;
}

/** ref_handlers.rs:1427-1439 `get_extracted_text_with_conn`. */
export function getExtractedText(conn: SqlExecutor, sourceId: string): string | null {
  try {
    const value = conn.get(fileExtractedTextQuery, [sourceId])?.extracted_text ?? null;
    return value !== null && rustTrim(value) !== '' ? value : null;
  } catch { return null; } // Rust query_row(...).ok().flatten().
}

/** ref_handlers.rs:1446-1471 `get_ocr_pages_text_with_conn`. */
export function getOcrPagesText(conn: SqlExecutor, sourceId: string, log: Pick<Context['logger'], 'warn'>): string | null {
  let json: string | null;
  try { json = conn.get(fileOcrPagesJsonQuery, [sourceId])?.ocr_pages_json ?? null; }
  catch { return null; }
  if (json === null || rustTrim(json) === '') return null;
  const pages = parseOcrPagesJson(json, log);
  return pages.length === 0 ? null : joinOcrPagesText(pages);
}

/** ref_handlers.rs:1313-1408 `get_image_ocr_text_with_conn`. */
export function getImageOcrText(conn: SqlExecutor, sourceId: string, log: Context['logger']): string | null {
  log.info('[OCR_DIAG] get_image_ocr_text_with_conn: querying OCR text for source_id=%s', sourceId);
  try {
    const file = conn.one<{ id: string; resource_id: string | null; file_name: string | null }>(`SELECT a.id,a.resource_id,a.file_name FROM files a
      WHERE a.id=?1 OR a.resource_id=?1 ORDER BY CASE WHEN a.id=?1 THEN 0 ELSE 1 END LIMIT 1`, [sourceId]);
    log.info('[OCR_DIAG] files table match: source_id=%s -> file_id=%s, resource_id=%s, file_name=%s', sourceId, file.id, file.resource_id, file.file_name);
  } catch (error) {
    log.warn('[OCR_DIAG] files table NO MATCH for source_id=%s: %s. This means the SQL JOIN will fail and no OCR text can be retrieved.', sourceId, error);
  }
  try {
    const resource = conn.one<{ id: string; has_ocr: number; ocr_len: number | null }>(`SELECT r.id,r.ocr_text IS NOT NULL AS has_ocr,LENGTH(r.ocr_text) AS ocr_len
      FROM files a JOIN resources r ON a.resource_id=r.id WHERE a.id=?1 OR a.resource_id=?1
      ORDER BY CASE WHEN a.id=?1 THEN 0 ELSE 1 END LIMIT 1`, [sourceId]);
    log.info('[OCR_DIAG] resource OCR status: source_id=%s -> resource_id=%s, has_ocr=%s, ocr_len=%s', sourceId, resource.id, resource.has_ocr !== 0, resource.ocr_len);
  } catch (error) {
    log.warn('[OCR_DIAG] resource OCR check failed for source_id=%s: %s', sourceId, error);
  }
  try {
    const value = conn.one(imageOcrTextQuery, [sourceId]).ocr_text;
    if (value !== null && rustTrim(value) !== '') {
      log.info('[OCR_DIAG] OCR text FOUND for source_id=%s, len=%d, preview="%s"', sourceId, utf8ByteLength(value), takeChars(value, 100));
      return value;
    }
    if (value === null) log.warn('[OCR_DIAG] OCR text is NULL in database for source_id=%s. Possible causes: (1) OCR pipeline not yet completed, (2) OCR failed silently, (3) image was not processed', sourceId);
    else log.warn('[OCR_DIAG] OCR text exists but is EMPTY/WHITESPACE for source_id=%s', sourceId);
    return null;
  } catch (error) {
    log.warn('[OCR_DIAG] OCR text query FAILED for source_id=%s: %s. Possible cause: source_id not found in files table (JOIN returned no rows)', sourceId, error);
    return null;
  }
}

/** ref_handlers.rs:1184-1300 `get_essay_session_content_with_conn`. */
export function getEssaySessionContent(conn: SqlExecutor, sessionId: string, log: Context['logger']): string | null {
  const MAX_CHARS = 20_000;
  const MAX_ROUNDS = 10;
  const info = conn.get(essaySessionInfoQuery, [sessionId]);
  if (info === undefined) return null;
  const displayTitle = info.title === '' ? '未命名' : info.title;
  const header = `# 作文会话: ${displayTitle}\n类型: ${info.essay_type ?? '未知'}, 总轮次: ${info.total_rounds}`;
  const rows = conn.all(essaySessionRowsQuery, [sessionId]);
  if (rows.length === 0) return header;

  const parts: string[] = [header];
  let totalChars = charCount(header);
  let truncated = rows.length > MAX_ROUNDS;
  for (const row of rows.slice(0, MAX_ROUNDS)) {
    const roundHeader = `\n## 第 ${row.round_number} 轮`;
    totalChars += charCount(roundHeader);
    if (totalChars >= MAX_CHARS) {
      truncated = true;
      break;
    }
    parts.push(roundHeader);
    if (row.data !== null) {
      const remaining = MAX_CHARS - totalChars;
      const length = charCount(row.data);
      if (length > remaining) {
        parts.push(takeChars(row.data, remaining));
        totalChars = MAX_CHARS;
        truncated = true;
        break;
      }
      totalChars += length;
      parts.push(row.data);
    }
  }
  if (truncated) parts.push('\n\n[内容过长，已截断]');
  log.info('[VFS::RefHandlers] essay_session content: session_id=%s, rounds=%d, chars=%d', sessionId, Math.min(MAX_ROUNDS, rows.length), totalChars);
  return parts.join('\n');
}

/** ref_handlers.rs:340-412 `extract_file_text_with_strategy` without live parser. */
export function extractFileTextWithStrategy(
  conn: SqlExecutor,
  sourceId: string,
  parsedTextFromDocument: string | null,
  log: Pick<Context['logger'], 'warn'>,
): string | null {
  const ocrText = getOcrPagesText(conn, sourceId, log);
  let parsedText = getExtractedText(conn, sourceId);
  if (parsedText === null || utf8ByteLength(parsedText) < 1000) {
    if (parsedTextFromDocument !== null && utf8ByteLength(parsedTextFromDocument) > utf8ByteLength(parsedText ?? '')) {
      parsedText = parsedTextFromDocument;
    }
  }
  return selectExtractedText(ocrText, parsedText, null, sourceId);
}

/** ref_handlers.rs:340-412 step 4: OCR vs parsed text, UTF-8 byte lengths, ties go to parsed text. */
export function selectExtractedText(
  ocrText: string | null,
  parsedText: string | null,
  log: Pick<Context['logger'], 'debug'> | null,
  sourceId: string,
): string | null {
  const ocrLength = utf8ByteLength(ocrText ?? '');
  const parsedLength = utf8ByteLength(parsedText ?? '');
  log?.debug('[TextExtract] Parsed text for source_id=%s: len=%d', sourceId, parsedLength);
  if (ocrLength > parsedLength) {
    log?.debug('[TextExtract] Using OCR text (larger): %d > %d', ocrLength, parsedLength);
    return ocrText;
  }
  if (parsedLength > 0) {
    log?.debug('[TextExtract] Using parsed text: %d >= %d', parsedLength, ocrLength);
    return parsedText;
  }
  if (ocrLength > 0) {
    log?.debug('[TextExtract] Using OCR text (only available): %d', ocrLength);
    return ocrText;
  }
  log?.debug('[TextExtract] No text available for source_id=%s', sourceId);
  return null;
}

export interface FilePreviewRow {
  previewJson: string | null;
  ocrPagesJson: string | null;
  fileName: string | null;
}

/** ref_handlers.rs:1700-1720 file preview lookup. */
export function getFilePreviewRow(conn: SqlExecutor, fileId: string): FilePreviewRow | null {
  const row = conn.get(filePreviewRowQuery, [fileId]);
  if (row === undefined) return null;
  return {
    previewJson: row.preview_json,
    ocrPagesJson: row.ocr_pages_json,
    fileName: row.file_name,
  };
}

function parseJsonObject(raw: string | null, log: Context['logger'], kind: string, id: string): Record<string, unknown> | null {
  if (raw === null || rustTrim(raw) === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (error) {
    log.warn('[VFS::RefHandlers] Failed to parse preview_json for %s=%s: %s', kind, id, error);
    return null;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) return typeof value === 'string' ? value : null;
  }
  return null;
}

function readBlobBase64(
  conn: SqlExecutor,
  blobs: BlobRepository,
  blobsDir: string,
  hash: string,
  readBytes: (path: string) => Promise<Uint8Array>,
): Promise<string | null> {
  return (async () => {
    try {
      const path = blobs.getBlobPath(conn, blobsDir, hash);
      if (path === null) return null;
      return toBase64(await readBytes(path));
    } catch {
      return null;
    }
  })();
}

/** ref_handlers.rs:1638-1690 exam multimodal blocks (canonical, then preview). */
export async function getExamMultimodalBlocks(
  conn: SqlExecutor,
  blobsDir: string,
  blobs: BlobRepository,
  examId: string,
  document: { materials: Record<string, unknown>[]; questions: Record<string, unknown>[] } | null,
  log: Context['logger'],
  readBytes: (path: string) => Promise<Uint8Array>,
): Promise<MultimodalContentBlock[] | null> {
  if (document !== null) {
    const blocks: MultimodalContentBlock[] = [{
      type: 'text', text: JSON.stringify(document),
    }];
    const seen = new Set<string>();
    const images: Array<Record<string, unknown>> = [];
    for (const item of [...document.materials, ...document.questions]) {
      for (const raw of asArray(item['images'])) {
        const image = asRecord(raw);
        if (image !== null) images.push(image);
      }
    }
    for (const image of images) {
      const hash = stringField(image, 'hash');
      if (hash === null || seen.has(hash)) continue;
      seen.add(hash);
      const encoded = await readBlobBase64(conn, blobs, blobsDir, hash, readBytes);
      if (encoded === null) {
        blocks.push({
          type: 'text',
          text: `[REQUIRED_QUESTION_IMAGE_UNAVAILABLE: ${JSON.stringify(image['id'] ?? null)}]`,
        });
      } else {
        blocks.push({
          type: 'image',
          mediaType: stringField(image, 'mime') ?? 'image/png',
          base64: encoded,
        });
      }
    }
    return blocks;
  }

  const preview = parseJsonObject(conn.get(examPreviewQuery, [examId])?.preview_json ?? null, log, 'exam_id', examId);
  if (preview === null) return null;
  const blocks: MultimodalContentBlock[] = [];
  for (const rawPage of asArray(preview['pages'])) {
    const page = asRecord(rawPage);
    if (page === null) continue;
    const hash = stringField(page, 'blob_hash', 'blobHash');
    if (hash !== null) {
      const encoded = await readBlobBase64(conn, blobs, blobsDir, hash, readBytes);
      if (encoded !== null) {
        blocks.push({
          type: 'image',
          mediaType: stringField(page, 'mimeType') ?? 'image/png',
          base64: encoded,
        });
      }
    }
    let pageText = '';
    for (const rawCard of asArray(page['cards'])) {
      const card = asRecord(rawCard);
      if (card === null) continue;
      const label = stringField(card, 'question_label', 'questionLabel');
      const ocr = stringField(card, 'ocr_text', 'ocrText');
      if (label !== null && ocr !== null) {
        pageText += `<question label="${escapeXmlAttr(label)}">${escapeXmlContent(ocr)}</question>\n`;
      }
    }
    if (pageText !== '') blocks.push({ type: 'text', text: pageText });
  }
  return blocks.length === 0 ? null : blocks;
}

/** ref_handlers.rs:1724-1833 PDF page image + OCR blocks. */
export async function getFileMultimodalBlocks(
  conn: SqlExecutor,
  blobsDir: string,
  blobs: BlobRepository,
  fileId: string,
  log: Context['logger'],
  readBytes: (path: string) => Promise<Uint8Array>,
): Promise<MultimodalContentBlock[] | null> {
  const row = getFilePreviewRow(conn, fileId);
  if (row === null || row.previewJson === null || rustTrim(row.previewJson) === '') return null;
  const preview = parseJsonObject(row.previewJson, log, 'file_id', fileId);
  if (preview === null) return null;
  const ocrPages = row.ocrPagesJson === null ? [] : parseOcrPagesJson(row.ocrPagesJson, log);
  const displayName = row.fileName ?? fileId;
  const blocks: MultimodalContentBlock[] = [];

  const pages = asArray(preview['pages']);
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = asRecord(pages[pageIndex]);
    if (page === null) continue;
    const compressedHash = stringField(page, 'compressedBlobHash', 'compressed_blob_hash');
    const originalHash = stringField(page, 'blobHash', 'blob_hash');
    let selected: { base64: string; compressed: boolean } | null = null;
    if (compressedHash !== null && originalHash !== null && compressedHash !== originalHash) {
      const encoded = await readBlobBase64(conn, blobs, blobsDir, compressedHash, readBytes);
      if (encoded !== null) selected = { base64: encoded, compressed: true };
    }
    if (selected === null && originalHash !== null) {
      const encoded = await readBlobBase64(conn, blobs, blobsDir, originalHash, readBytes);
      if (encoded !== null) selected = { base64: encoded, compressed: false };
    }
    if (selected !== null) {
      const pageNumber = pageIndex + 1;
      const label = `[PDF@${fileId}:${pageNumber}] ${displayName} 第${pageNumber}页`;
      blocks.push({
        type: 'text',
        text: `<pdf_page name="${escapeXmlAttr(displayName)}" source_id="${escapeXmlAttr(fileId)}" page="${pageNumber}">${escapeXmlContent(label)}</pdf_page>`,
      });
      blocks.push({
        type: 'image',
        mediaType: selected.compressed
          ? 'image/jpeg'
          : stringField(page, 'mimeType', 'mime_type') ?? 'image/png',
        base64: selected.base64,
      });
    }
    const ocrText = ocrPages[pageIndex] ?? null;
    if (ocrText !== null && rustTrim(ocrText) !== '') {
      blocks.push({
        type: 'text',
        text: `<page number="${pageIndex + 1}">${escapeXmlContent(ocrText)}</page>`,
      });
    }
  }

  return blocks.length === 0 ? null : blocks;
}

export type { ResourceInjectModes };
