/**
 * `dstu-media/src/media/library.rs` SQL: media library list, folder titles,
 * handout counts and related notes. Kept in the lane repository per host rules.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import {
  AUDIO_EXTENSIONS, BILIBILI_LINK_EXTENSION, VIDEO_EXTENSIONS,
} from '../src/media-types.ts';

export interface LibraryRow {
  id: string;
  resource_id: string | null;
  file_name: string;
  mime_type: string;
  size: number;
  created_at: string;
  updated_at: string;
  processing_status: string | null;
  progress_position: number | null;
  progress_duration: number | null;
  progress_watched: number | null;
  progress_finished: number | null;
  progress_updated_at: number | null;
  seg_total: number;
  seg_done: number;
  seg_failed: number;
  seg_source: string | null;
  folder_id: string | null;
}

export interface FolderRow {
  id: string;
  parent_id: string | null;
  title: string;
}

export interface RelatedNoteRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

function mediaCandidateClause(): string {
  const parts = [
    `f."type" IN ('audio', 'video')`,
    "lower(COALESCE(f.mime_type, '')) LIKE 'audio/%'",
    "lower(COALESCE(f.mime_type, '')) LIKE 'video/%'",
  ];
  for (const ext of [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS, BILIBILI_LINK_EXTENSION]) {
    parts.push(`lower(f.file_name) LIKE '%.${ext}'`);
  }
  return `(${parts.join(' OR ')})`;
}

const NOTE_ORIGIN_SUBQUERY = `
    SELECT id, title, created_at, updated_at,
           CASE WHEN json_valid(o) THEN json_extract(o, '$.kind') END AS origin_kind,
           CASE WHEN json_valid(o) THEN json_extract(o, '$.resourceId') END AS origin_rid
    FROM (
        SELECT id, title, created_at, updated_at,
               CASE WHEN json_valid(props) THEN json_extract(props, '$._origin') END AS o
        FROM notes
        WHERE deleted_at IS NULL AND props IS NOT NULL AND instr(props, '_origin') > 0
    )`;

/** `list_media_library_with_conn` 的主查询（不排序、不截断）。 */
export function listLibraryRows(conn: SqlExecutor): LibraryRow[] {
  const sql = `
    SELECT f.id, f.resource_id, f.file_name, COALESCE(f.mime_type, '') AS mime_type,
           COALESCE(f.size, 0) AS size,
           f.created_at, f.updated_at, f.processing_status,
           mp.last_position_ms AS progress_position, mp.duration_ms AS progress_duration,
           mp.watched_ms AS progress_watched,
           mp.finished AS progress_finished, mp.updated_at AS progress_updated_at,
           COALESCE(seg.total, 0) AS seg_total, COALESCE(seg.done, 0) AS seg_done,
           COALESCE(seg.failed, 0) AS seg_failed, seg.source AS seg_source,
           (SELECT fi.folder_id FROM folder_items fi
             WHERE fi.item_type IN ('file', 'image') AND fi.item_id = f.id
               AND fi.deleted_at IS NULL
             ORDER BY COALESCE(fi.updated_at, fi.created_at) DESC LIMIT 1) AS folder_id
    FROM files f
    LEFT JOIN media_progress mp ON mp.resource_id = f.id
    LEFT JOIN (
        SELECT resource_id,
               COUNT(*) AS total,
               SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS done,
               SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS failed,
               MIN(source) AS source
        FROM media_transcript_segments GROUP BY resource_id
    ) seg ON seg.resource_id = f.id
    WHERE f.status = 'active' AND f.deleted_at IS NULL AND ${mediaCandidateClause()}`;
  return conn.all<LibraryRow>(sql);
}

export function listFolders(conn: SqlExecutor): FolderRow[] {
  return conn.all<FolderRow>(
    'SELECT id, parent_id, title FROM folders WHERE deleted_at IS NULL');
}

export function handoutCounts(conn: SqlExecutor): Map<string, number> {
  const rows = conn.all<{ origin_rid: string; count: number }>(`
    SELECT origin_rid, COUNT(*) AS count FROM (${NOTE_ORIGIN_SUBQUERY})
    WHERE origin_kind = 'resource' AND typeof(origin_rid) = 'text'
    GROUP BY origin_rid`);
  return new Map(rows.map(row => [row.origin_rid, row.count]));
}

/** `files.id` / `files.resource_id` 任一匹配；id 精确命中优先。 */
export function findFileIds(
  conn: SqlExecutor,
  resourceId: string,
): { id: string; resource_id: string | null } | null {
  return conn.get<{ id: string; resource_id: string | null }>(
    `SELECT id, resource_id FROM files WHERE id = ?1 OR resource_id = ?1
     ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1`,
    [resourceId],
  ) ?? null;
}

export function listRelatedNoteRows(
  conn: SqlExecutor,
  fileId: string,
  resourceId: string,
): RelatedNoteRow[] {
  return conn.all<RelatedNoteRow>(`
    SELECT id, title, created_at, updated_at FROM (${NOTE_ORIGIN_SUBQUERY})
    WHERE origin_kind = 'resource' AND typeof(origin_rid) = 'text'
      AND (origin_rid = ?1 OR (?2 <> '' AND origin_rid = ?2))`,
  [fileId, resourceId]);
}
