/**
 * SQLite reads for the unified retriever (`vfs/unified_retriever.rs`).
 *
 * SQL lives only here; callers receive plain rows and remain responsible for
 * Rust-visible mapping (resource aliases, BM25 rerank, identity dedupe).
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import type { Row, SqlExecutor } from '../../../platform/storage/api.ts';
import type { LaneLogger } from '../src/logger.ts';
import { vfsTableOwners } from './owners.ts';

const MAX_FTS_SCAN = 1000;

export type SqlValue = string | number | bigint | null | Uint8Array;

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function integer(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && rustTrim(value) !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export interface VfsResourceRow {
  readonly id: string;
  readonly resourceType: string;
  readonly sourceId: string | null;
  readonly metadataJson: string | null;
}

export function getResource(db: SqlExecutor, resourceId: string): VfsResourceRow | undefined {
  const row = db.get(
    `SELECT id, type, source_id, metadata_json FROM resources WHERE id = ?1`,
    [resourceId],
  );
  if (row === undefined) return undefined;
  return {
    id: text(row['id']),
    resourceType: text(row['type']),
    sourceId: nullableText(row['source_id']),
    metadataJson: nullableText(row['metadata_json']),
  };
}

export function resourceFolderId(
  db: SqlExecutor,
  resourceId: string,
  sourceId: string | null,
): string | null {
  const source = sourceId ?? resourceId;
  const row = db.get(
    `SELECT folder_id FROM folder_items
     WHERE deleted_at IS NULL AND (item_id = ?1 OR item_id = ?2)
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [resourceId, source],
  );
  return row === undefined ? null : nullableText(row['folder_id']);
}

export function blobRelativePath(db: SqlExecutor, hash: string): string | null {
  const row = db.get('SELECT relative_path FROM blobs WHERE hash = ?1', [hash]);
  return row === undefined ? null : nullableText(row['relative_path']);
}

/** `VfsFullSearchService::source_display_title`. */
export function sourceDisplayTitle(db: SqlExecutor, sourceId: string): string | null {
  let sql: string;
  if (sourceId.startsWith('note_')) {
    sql = 'SELECT title AS title FROM notes WHERE id = ?1';
  } else if (
    sourceId.startsWith('tb_')
    || sourceId.startsWith('file_')
    || sourceId.startsWith('att_')
    || sourceId.startsWith('img_')
  ) {
    sql = "SELECT COALESCE(NULLIF(file_name, ''), name) AS title FROM files WHERE id = ?1";
  } else if (sourceId.startsWith('exam_')) {
    sql = 'SELECT exam_name AS title FROM exam_sheets WHERE id = ?1';
  } else if (sourceId.startsWith('tr_')) {
    sql = 'SELECT title AS title FROM translations WHERE id = ?1';
  } else if (sourceId.startsWith('mm_')) {
    sql = 'SELECT title AS title FROM mindmaps WHERE id = ?1';
  } else if (sourceId.startsWith('essay_') && !sourceId.startsWith('essay_session_')) {
    sql = 'SELECT title AS title FROM essays WHERE id = ?1';
  } else {
    return null;
  }
  try {
    const row = db.get(sql, [sourceId]);
    if (row === undefined) return null;
    const title = rustTrim(String(row['title'] ?? ''));
    return title === '' ? null : title;
  } catch {
    // Rust ignores source-table lookup failures (`query_row(...).ok()`).
    return null;
  }
}

/** `VfsFullSearchService::is_source_soft_deleted` (hard-coded table by prefix). */
export function isSourceSoftDeleted(
  db: SqlExecutor,
  sourceId: string,
  logger?: LaneLogger,
): boolean {
  let table: string;
  if (sourceId.startsWith('note_')) {
    table = 'notes';
  } else if (
    sourceId.startsWith('tb_')
    || sourceId.startsWith('file_')
    || sourceId.startsWith('att_')
    || sourceId.startsWith('img_')
  ) {
    table = 'files';
  } else if (sourceId.startsWith('exam_')) {
    table = 'exam_sheets';
  } else if (sourceId.startsWith('essay_session_') || sourceId.startsWith('es_')) {
    table = 'essay_sessions';
  } else if (sourceId.startsWith('essay_')) {
    table = 'essays';
  } else if (sourceId.startsWith('tr_')) {
    table = 'translations';
  } else if (sourceId.startsWith('mm_')) {
    table = 'mindmaps';
  } else {
    return false;
  }
  try {
    return db.pluck<unknown>(
      `SELECT 1 FROM ${table} WHERE id = ?1 AND deleted_at IS NOT NULL LIMIT 1`,
      [sourceId],
    ) !== undefined;
  } catch (error) {
    // Rust warns and conservatively skips the filter on lookup failure.
    logger?.warn(`[VFS::Search] is_source_soft_deleted failed, skipping filter: ${String(error)}`);
    return false;
  }
}

/** `page_text_for_unit`: trimmed to 600 chars, empty becomes `None`. */
export function pageTextForUnit(
  db: SqlExecutor,
  resourceId: string,
  pageIndex: number,
): string | null {
  try {
    const row = db.get(
      'SELECT text_content FROM vfs_index_units WHERE resource_id = ?1 AND unit_index = ?2',
      [resourceId, pageIndex],
    );
    if (row === undefined) return null;
    const raw = nullableText(row['text_content']);
    if (raw === null) return null;
    const limited = [...rustTrim(raw)].slice(0, 600).join('');
    return limited === '' ? null : limited;
  } catch {
    // Rust `query_row(...).ok().flatten()`: a missing table/row reads as absent.
    return null;
  }
}

/**
 * `active_segment_row_ids`: validate Lance candidates against the committed
 * SQLite ledger in bounded batches (400 ids leaves room under SQLite's limit).
 */
export function activeSegmentRowIds(
  db: SqlExecutor,
  embeddingIds: readonly string[],
  profileId: string,
  dimension: number,
): Set<string> {
  const unique = [...new Set(embeddingIds)];
  const active = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += 400) {
    const chunk = unique.slice(offset, offset + 400);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(',');
    const sql = `SELECT s.lance_row_id
       FROM vfs_index_segments s
       JOIN vfs_index_units u ON u.id = s.unit_id
       JOIN vfs_index_profiles p ON p.id = s.index_profile_id
       LEFT JOIN resources r ON r.id = u.resource_id
       WHERE s.lance_row_id IN (${placeholders})
         AND s.index_profile_id = ?${chunk.length + 1}
         AND s.embedding_dim = ?${chunk.length + 2}
         AND p.state IN ('active', 'building', 'queryable')
         AND (
              (s.modality = 'text'
               AND u.text_profile_id = s.index_profile_id
               AND u.text_generation = s.generation
               AND (r.id IS NULL OR (r.deleted_at IS NULL
                    AND COALESCE(r.index_state, 'pending') <> 'disabled')))
              OR
              (s.modality IN ('image', 'multimodal')
               AND u.mm_profile_id = s.index_profile_id
               AND u.mm_generation = s.generation
               AND (r.id IS NULL OR (r.deleted_at IS NULL
                    AND COALESCE(r.mm_index_state, 'pending') <> 'disabled')))
         )`;
    const values: SqlValue[] = [...chunk, profileId, dimension];
    for (const row of db.all<Row>(sql, values)) active.add(text(row['lance_row_id']));
  }
  return active;
}

export interface LexicalCandidateRow {
  readonly embeddingId: string;
  readonly resourceId: string;
  readonly chunkIndex: number;
  readonly unitIndex: number;
  readonly contentText: string;
  readonly metadataJson: string | null;
  readonly imageBlobHash: string | null;
  readonly resourceTypeRaw: string;
  readonly sourceId: string | null;
  readonly resourceMetadataJson: string | null;
  readonly folderId: string | null;
  readonly blobRelativePath: string | null;
  readonly exactRank: number;
}

export interface LexicalCandidateQuery {
  readonly query: string;
  readonly patterns: readonly string[];
  readonly resourceIds: readonly string[] | null;
  readonly resourceTypes: readonly string[] | null;
  readonly folderIds: readonly string[] | null;
  readonly mountedResourceIds?: readonly string[] | null;
  readonly fetchLimit: number;
}

export interface RetrievalMountScope {
  readonly effectiveFolderIds: string[];
  readonly mountedResourceIds: string[];
}

/** Scope candidates before ANN top-K, using live canonical membership instead of stale Lance folder metadata. */
export function scopedVectorResourceIds(
  db: SqlExecutor, scope: RetrievalMountScope | null, requestedIds: readonly string[] | null,
): readonly string[] | null {
  if (scope === null) return requestedIds;
  const rows = db.all<Row>(`SELECT r.id FROM resources r
    WHERE r.deleted_at IS NULL AND (
      r.id IN (SELECT value FROM json_each(?2)) OR EXISTS (
        SELECT 1 FROM folder_items fi WHERE fi.deleted_at IS NULL
          AND fi.folder_id IN (SELECT value FROM json_each(?1))
          AND (fi.item_id = r.id OR fi.item_id = r.source_id)))`,
  [JSON.stringify(scope.effectiveFolderIds), JSON.stringify(scope.mountedResourceIds)]);
  const requested = requestedIds === null ? null : new Set(requestedIds);
  return rows.map(row => text(row['id'])).filter(id => requested === null || requested.has(id));
}

function isMissingTableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /\bno such table\b/i.test(msg);
}

function expandFoldersReadOnly(db: SqlExecutor, seedFolderIds: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const raw of seedFolderIds) {
    const id = rustTrim(raw);
    if (id !== '') expanded.add(id);
  }
  if (expanded.size === 0) return [];
  try {
    const seeds = [...expanded];
    const placeholders = seeds.map((_, idx) => `?${idx + 1}`).join(', ');
    const rows = db.all<Row>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM folders WHERE id IN (${placeholders}) AND deleted_at IS NULL
         UNION
         SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id WHERE f.deleted_at IS NULL
       ) SELECT id FROM tree`,
      seeds,
    );
    expanded.clear();
    for (const row of rows) {
      const id = rustTrim(text(row['id']));
      if (id !== '') expanded.add(id);
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }
  return [...expanded];
}

function resolveMountedResourceIdsReadOnly(db: SqlExecutor, itemType: string, itemId: string): string[] {
  const out = new Set<string>();
  const table = ({ note: 'notes', file: 'files', image: 'files', exam: 'exam_sheets',
    translation: 'translations', essay: 'essays', mindmap: 'mindmaps' } as Record<string, string>)[itemType];
  if (table) {
    try {
      if (db.get(`SELECT id FROM ${table} WHERE (id = ?1 OR resource_id = ?1) AND deleted_at IS NOT NULL`, [itemId])) return [];
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
    }
  }
  try {
    for (const row of db.all<Row>(
      'SELECT id FROM resources WHERE deleted_at IS NULL AND (id = ?1 OR source_id = ?1)',
      [itemId],
    )) {
      const id = rustTrim(text(row['id']));
      if (id !== '') out.add(id);
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }
  const tableByType: Record<string, string> = {
    note: 'notes',
    file: 'files',
    image: 'files',
    exam: 'exam_sheets',
    translation: 'translations',
    essay: 'essays',
    mindmap: 'mindmaps',
  };
  const entityTable = tableByType[itemType];
  if (entityTable !== undefined) {
    try {
      const row = db.get<Row>(
        `SELECT e.resource_id AS id FROM ${entityTable} e
         LEFT JOIN resources r ON r.id = e.resource_id
         WHERE e.id = ?1 AND e.deleted_at IS NULL AND (r.id IS NULL OR r.deleted_at IS NULL)`,
        [itemId],
      );
      const id = row === undefined ? null : nullableText(row['id']);
      if (id !== null && rustTrim(id) !== '') out.add(rustTrim(id));
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
    }
  }
  return [...out];
}

export function resolveRetrievalMountScope(
  db: SqlExecutor,
  folderIds: readonly string[] | null,
): RetrievalMountScope | null {
  if (folderIds === null) return null;
  if (folderIds.length === 0) {
    return { effectiveFolderIds: [], mountedResourceIds: [] };
  }
  const ownerStudySpaces = vfsTableOwners(db)?.studySpaces;
  if (ownerStudySpaces !== undefined) {
    const resolved = ownerStudySpaces.resolveMountScopeForFolders(db, folderIds);
    return {
      effectiveFolderIds: resolved.effectiveFolderIds,
      mountedResourceIds: resolved.mountedResourceIds,
    };
  }
  const canonical = expandFoldersReadOnly(db, folderIds);
  if (canonical.length === 0) {
    return { effectiveFolderIds: [], mountedResourceIds: [] };
  }
  const effectiveSet = new Set<string>(canonical);
  const mountedResources = new Set<string>();
  let pendingFolders = canonical;
  while (pendingFolders.length > 0) {
    try {
      const placeholders = pendingFolders.map((_, idx) => `?${idx + 1}`).join(', ');
      const mounts = db.all<Row>(
        `SELECT item_type, item_id FROM vfs_space_mounts
         WHERE target_folder_id IN (${placeholders}) AND deleted_at IS NULL
         ORDER BY created_at ASC`,
        pendingFolders,
      );
      pendingFolders = [];
      for (const mount of mounts) {
        const itemType = rustTrim(text(mount['item_type']));
        const itemId = rustTrim(text(mount['item_id']));
        if (itemType === '' || itemId === '') continue;
        if (itemType === 'folder') {
          for (const fid of expandFoldersReadOnly(db, [itemId])) {
            if (!effectiveSet.has(fid)) pendingFolders.push(fid);
            effectiveSet.add(fid);
          }
        } else {
          for (const rid of resolveMountedResourceIdsReadOnly(db, itemType, itemId)) {
            mountedResources.add(rid);
          }
        }
      }
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      break;
    }
  }
  return {
    effectiveFolderIds: [...effectiveSet],
    mountedResourceIds: [...mountedResources],
  };
}

function lexicalMatchAnySql(column: string, termCount: number): string {
  return Array.from({ length: termCount }, (_, offset) => `${column} LIKE ?${offset + 2} ESCAPE '\\'`).join(' OR ');
}

function lexicalMatchCountSql(column: string, termCount: number): string {
  return Array.from(
    { length: termCount },
    (_, offset) => `CASE WHEN ${column} LIKE ?${offset + 2} ESCAPE '\\' THEN 1 ELSE 0 END`,
  ).join(' + ');
}

/**
 * `VfsUnifiedRetriever::execute_fts_route` candidate query.
 *
 * The LIKE prefilter only counts distinct matched terms; BM25 reranks the
 * bounded window afterwards. Scope values travel as one JSON array per column so
 * large scopes never hit SQLite's variable limit.
 */
export function lexicalCandidateRows(
  db: SqlExecutor,
  options: LexicalCandidateQuery,
): LexicalCandidateRow[] {
  const { query, patterns, resourceIds, resourceTypes, folderIds, mountedResourceIds, fetchLimit } = options;
  const scanLimit = Math.min(Math.max(fetchLimit * 10, fetchLimit), MAX_FTS_SCAN);
  const segmentMatchCount = lexicalMatchCountSql('s.content_text', patterns.length);
  const segmentMatchAny = lexicalMatchAnySql('s.content_text', patterns.length);
  const unitMatchCount = lexicalMatchCountSql('u.text_content', patterns.length);
  const unitMatchAny = lexicalMatchAnySql('u.text_content', patterns.length);

  const parameters: SqlValue[] = [query, ...patterns];
  const resourceTypeSql = `CASE
      WHEN lower(r.type) = 'insightcard' THEN 'insight_card'
      WHEN lower(r.type) IN ('note', 'textbook', 'exam', 'translation', 'essay',
           'image', 'file', 'retrieval', 'mindmap', 'insight_card') THEN lower(r.type)
      ELSE 'file' END`;
  const folderSql = `(SELECT fi.folder_id FROM folder_items fi
      WHERE fi.deleted_at IS NULL
        AND (fi.item_id = r.id OR fi.item_id = COALESCE(r.source_id, r.id))
      ORDER BY fi.created_at DESC, fi.id DESC LIMIT 1)`;
  let scopeSql = '';
  for (const [values, expression] of [
    [resourceIds, 'r.id'],
    [resourceTypes, resourceTypeSql],
  ] as const) {
    if (values !== null) {
      parameters.push(JSON.stringify(values));
      scopeSql += ` AND (${expression}) IN (SELECT value FROM json_each(?${parameters.length}))`;
    }
  }
  if (folderIds !== null) {
    parameters.push(JSON.stringify(folderIds));
    const folderIdx = parameters.length;
    if (mountedResourceIds !== null && mountedResourceIds !== undefined && mountedResourceIds.length > 0) {
      parameters.push(JSON.stringify(mountedResourceIds));
      const mountIdx = parameters.length;
      scopeSql += ` AND ((${folderSql}) IN (SELECT value FROM json_each(?${folderIdx})) OR r.id IN (SELECT value FROM json_each(?${mountIdx})))`;
    } else {
      scopeSql += ` AND (${folderSql}) IN (SELECT value FROM json_each(?${folderIdx}))`;
    }
  }
  parameters.push(scanLimit);

  const sql = `SELECT lexical.embedding_id AS embedding_id,
                      lexical.resource_id AS resource_id,
                      lexical.chunk_index AS chunk_index,
                      lexical.unit_index AS unit_index,
                      lexical.content_text AS content_text,
                      lexical.metadata_json AS metadata_json,
                      lexical.image_blob_hash AS image_blob_hash,
                      r.type AS resource_type,
                      r.source_id AS source_id,
                      r.metadata_json AS resource_metadata_json,
                      ${folderSql} AS folder_id,
                      b.relative_path AS blob_relative_path,
                      lexical.exact_rank AS exact_rank
               FROM (
                 SELECT * FROM (
                   SELECT s.lance_row_id AS embedding_id, u.resource_id AS resource_id,
                          s.segment_index AS chunk_index, u.unit_index AS unit_index,
                          COALESCE(s.content_text, '') AS content_text,
                          s.metadata_json AS metadata_json,
                          u.image_blob_hash AS image_blob_hash,
                          CASE WHEN s.content_text = ?1 THEN 0 ELSE 1 END AS exact_rank,
                          ${segmentMatchCount} AS match_count,
                          0 AS source_rank, s.updated_at AS rank_updated
                   FROM vfs_index_segments s
                   JOIN vfs_index_units u ON u.id = s.unit_id
                   JOIN resources r ON r.id = u.resource_id
                   WHERE s.modality = 'text'
                     AND (${segmentMatchAny})
                     AND r.deleted_at IS NULL
                     AND COALESCE(r.index_state, 'pending') <> 'disabled'
                     ${scopeSql}
                     AND (
                          s.index_profile_id IS NULL OR (
                              u.text_profile_id = s.index_profile_id
                              AND u.text_generation = s.generation
                              AND EXISTS (
                                  SELECT 1 FROM vfs_index_profiles p
                                  WHERE p.id = s.index_profile_id
                                    AND p.state IN ('active', 'building', 'queryable')
                              )
                          )
                     )
                   UNION ALL
                   SELECT 'unit:' || u.id AS embedding_id, u.resource_id AS resource_id,
                          0 AS chunk_index, u.unit_index AS unit_index,
                          COALESCE(u.text_content, '') AS content_text,
                          NULL AS metadata_json, u.image_blob_hash AS image_blob_hash,
                          CASE WHEN u.text_content = ?1 THEN 0 ELSE 1 END AS exact_rank,
                          ${unitMatchCount} AS match_count,
                          1 AS source_rank, u.updated_at AS rank_updated
                   FROM vfs_index_units u
                   JOIN resources r ON r.id = u.resource_id
                   WHERE (${unitMatchAny})
                     AND r.deleted_at IS NULL
                     AND COALESCE(r.index_state, 'pending') <> 'disabled'
                     ${scopeSql}
                 )
                 ORDER BY exact_rank, match_count DESC, source_rank, rank_updated DESC, embedding_id
                 LIMIT ?${parameters.length}
               ) lexical
               JOIN resources r ON r.id = lexical.resource_id
               LEFT JOIN blobs b ON b.hash = lexical.image_blob_hash
               ORDER BY exact_rank, match_count DESC, source_rank, rank_updated DESC, embedding_id`;

  return db.all<Row>(sql, parameters).map((row) => ({
    embeddingId: text(row['embedding_id']),
    resourceId: text(row['resource_id']),
    chunkIndex: integer(row['chunk_index']),
    unitIndex: integer(row['unit_index']),
    contentText: text(row['content_text']),
    metadataJson: nullableText(row['metadata_json']),
    imageBlobHash: nullableText(row['image_blob_hash']),
    resourceTypeRaw: text(row['resource_type']),
    sourceId: nullableText(row['source_id']),
    resourceMetadataJson: nullableText(row['resource_metadata_json']),
    folderId: nullableText(row['folder_id']),
    blobRelativePath: nullableText(row['blob_relative_path']),
    exactRank: integer(row['exact_rank']),
  }));
}
