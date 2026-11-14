// notes_manager.rs VFS adapters: NoteItem projection and the advanced list query.
import type { SqlExecutor, SqlParam } from '../../../platform/storage/api.ts';
import type { VfsNote } from '../api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L10-notes.ts';
import { escapeLikePattern } from '../repository/notes.ts';
import { notesLog } from './log.ts';
import { NoteDatabaseError } from './errors.ts';
import { decodeJson } from './json.ts';
import { charCount, rustTrim } from '../../../platform/util/index.ts';

export interface NoteItem {
  id: string;
  title: string;
  content_md: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  is_favorite: boolean;
}

export interface ListOptions {
  tags?: string[] | null;
  date_start?: string | null;
  date_end?: string | null;
  has_assets?: boolean | null;
  sort_by?: string | null;
  sort_dir?: string | null;
  page: number;
  page_size: number;
  keyword?: string | null;
  include_deleted: boolean;
  only_deleted: boolean;
}

export function noteItem(note: VfsNote, content = ''): NoteItem {
  return {
    id: note.id, title: note.title, content_md: content, tags: note.tags,
    created_at: note.createdAt, updated_at: note.updatedAt, is_favorite: note.isFavorite,
  };
}

function parseTags(raw: string): string[] {
  try {
    const parsed = decodeJson(raw);
    // serde_json::from_str::<Vec<String>> is all-or-nothing: one non-string
    // element makes the whole cell fall back to an empty array.
    return Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

/** notes_manager::build_notes_fts_match_query. */
export function buildNotesFtsMatchQuery(keyword: string): string | null {
  const trimmed = rustTrim(keyword);
  if (charCount(trimmed) < 3) return null;
  return `"${trimmed.replace(/"/g, '""')}"`;
}

export function listNotesMeta(conn: SqlExecutor, limit = 5000): NoteItem[] {
  let rows: Array<{
    id: string; title: string; tags: string; created_at: string; updated_at: string; is_favorite: number;
  }>;
  try {
    rows = conn.all(`SELECT n.id, n.title, n.tags, n.created_at, n.updated_at, COALESCE(n.is_favorite, 0) AS is_favorite
       FROM notes n WHERE n.deleted_at IS NULL ORDER BY n.updated_at DESC LIMIT ?1`, [Math.max(1, limit)]);
  } catch (error) {
    throw new NoteDatabaseError(`执行 VFS 笔记查询失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  return rows.map((row) => ({
    id: row.id, title: row.title, content_md: '', tags: parseTags(row.tags),
    created_at: row.created_at, updated_at: row.updated_at, is_favorite: Number(row.is_favorite) !== 0,
  }));
}

export function listNotesAdvanced(conn: SqlExecutor, opt: ListOptions): { items: NoteItem[]; total: number } {
  const ftsUsable = !opt.include_deleted && !opt.only_deleted;
  const ftsQuery = ftsUsable && opt.keyword != null ? buildNotesFtsMatchQuery(opt.keyword) : null;
  if (ftsQuery !== null) {
    try {
      const fts = listNotesAdvancedVfs(conn, opt, ftsQuery);
      if (fts.total > 0) return fts;
      notesLog.debug(`[NotesManager] list_notes_advanced FTS 无命中，回退 LIKE：${String(opt.keyword)}`);
    } catch (error) {
      // Rust: warn! then fall back to LIKE; an FTS failure must not fail the list.
      notesLog.warn(`[NotesManager] list_notes_advanced FTS 查询失败（${String(error)}），回退 LIKE`);
    }
  }
  return listNotesAdvancedVfs(conn, opt, null);
}

function listNotesAdvancedVfs(conn: SqlExecutor, opt: ListOptions, ftsMatch: string | null): { items: NoteItem[]; total: number } {
  let joinSql = ' LEFT JOIN resources r ON r.id = n.resource_id';
  const where: string[] = [];
  const values: SqlParam[] = [];
  let index = 1;

  if (opt.only_deleted) where.push('n.deleted_at IS NOT NULL');
  else if (!opt.include_deleted) where.push('n.deleted_at IS NULL');

  let orderByRelevance = false;
  if (ftsMatch !== null) {
    joinSql += ' JOIN notes_fts ON notes_fts.rowid = n.rowid';
    where.push(`notes_fts MATCH ?${index}`);
    values.push(ftsMatch);
    index += 1;
    orderByRelevance = opt.sort_by == null;
  } else if (opt.keyword != null) {
    const pattern = `%${escapeLikePattern(opt.keyword)}%`;
    where.push(`(n.title LIKE ?${index} ESCAPE '\\' OR r.data LIKE ?${index + 1} ESCAPE '\\')`);
    values.push(pattern, pattern);
    index += 2;
  }

  const tagsViaNormalized = !opt.include_deleted && !opt.only_deleted;
  for (const tag of opt.tags ?? []) {
    if (rustTrim(tag).length === 0) continue;
    if (tagsViaNormalized) {
      where.push(`EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag = ?${index})`);
    } else {
      where.push(`EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(COALESCE(n.tags, '[]')) THEN COALESCE(n.tags, '[]') ELSE '[]' END) je WHERE TRIM(je.value) = ?${index})`);
    }
    values.push(rustTrim(tag));
    index += 1;
  }

  if (opt.has_assets !== undefined && opt.has_assets !== null) {
    const cond = "COALESCE(r.data, '') LIKE '%notes_assets/%'";
    where.push(opt.has_assets ? cond : `NOT (${cond})`);
  }
  if (opt.date_start != null) {
    where.push(`datetime(n.updated_at) >= datetime(?${index})`);
    values.push(opt.date_start);
    index += 1;
  }
  if (opt.date_end != null) {
    where.push(`datetime(n.updated_at) <= datetime(?${index})`);
    values.push(opt.date_end);
    index += 1;
  }

  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const sortColumn = opt.sort_by === 'created_at' ? 'n.created_at' : opt.sort_by === 'title' ? 'n.title' : 'n.updated_at';
  const sortDirection = opt.sort_dir === 'asc' ? 'ASC' : 'DESC';
  const orderSql = orderByRelevance ? 'bm25(notes_fts, 5.0, 1.0), n.updated_at DESC, n.id ASC' : `${sortColumn} ${sortDirection}`;

  const page = Math.max(0, opt.page);
  const pageSize = Math.max(1, opt.page_size);
  const limit = pageSize;
  const offset = page * pageSize;

  let total: number;
  try {
    total = Number(conn.get<{ total: number }>(`SELECT COUNT(*) AS total FROM notes n${joinSql}${whereSql}`, values)?.total ?? 0);
  } catch (error) {
    throw new NoteDatabaseError(`执行 VFS 笔记计数查询失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  let rows: Array<{
    id: string; title: string; content: string; tags: string; created_at: string; updated_at: string; is_favorite: number;
  }>;
  try {
    rows = conn.all(`SELECT n.id, n.title, COALESCE(r.data, '') AS content, n.tags, n.created_at, n.updated_at, COALESCE(n.is_favorite, 0) AS is_favorite
        FROM notes n${joinSql}${whereSql} ORDER BY ${orderSql} LIMIT ?${index} OFFSET ?${index + 1}`,
    [...values, limit, offset]);
  } catch (error) {
    throw new NoteDatabaseError(`执行 VFS 笔记列表查询失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  const items = rows.map((row) => ({
    id: row.id, title: row.title, content_md: row.content, tags: parseTags(row.tags),
    created_at: row.created_at, updated_at: row.updated_at, is_favorite: Number(row.is_favorite) !== 0,
  }));
  return { items, total };
}

export type AdvancedResponse = Commands['notes_list_advanced']['result'];
