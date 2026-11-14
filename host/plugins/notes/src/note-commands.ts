// cmd/notes.rs note CRUD / list / link commands. Everything here is invoked by
// index.ts as one-line wiring; SQL stays in repository/.
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L10-notes.ts';
import type { NoteItem } from '../repository/notes-manager.ts';
import { noteItem } from '../repository/notes-manager.ts';
import {
  commandDatabase, mapVfsError, noteManagerStorage, vfsErrorDisplay,
} from '../repository/errors.ts';
import {
  configureNotesRepository, noteRepository,
} from '../repository/notes.ts';
import { notesDbStats } from '../repository/stats.ts';
import { notesLog } from '../repository/log.ts';
import { errorMessage, u32 } from './command-utils.ts';
import { rustTrim } from '../../../platform/util/index.ts';

export function createNote(
  conn: SqlExecutor,
  payload: { title: string; content_md: string; tags?: readonly string[] | null },
): NoteItem {
  return noteManagerStorage(() => {
    const note = noteRepository.createNote({
      title: payload.title,
      content: payload.content_md,
      tags: [...(payload.tags ?? [])],
    }, conn);
    return noteItem(note, payload.content_md);
  }, 'VFS 创建笔记失败');
}

export function getNote(conn: SqlExecutor, id: string): NoteItem {
  return noteManagerStorage(() => {
    const found = noteRepository.getNoteWithContent(id, conn);
    if (found === null) throw new CommandError(AppError.not_found('笔记不存在或已被删除'));
    return noteItem(found[0], found[1]);
  }, 'VFS 读取笔记失败');
}

export function updateNote(
  conn: SqlExecutor,
  payload: Commands['notes_update']['args']['note'],
): NoteItem {
  const updated = noteRepository.updateNote(payload.id, {
    title: payload.title ?? null,
    content: payload.content_md ?? null,
    tags: payload.tags ?? null,
    expectedUpdatedAt: payload.expected_updated_at ?? null,
  }, conn);
  let content: string;
  if (payload.content_md !== undefined && payload.content_md !== null) {
    content = payload.content_md;
  } else {
    try {
      content = noteRepository.getNoteContent(updated.id, conn) ?? '';
    } catch (error) {
      // notes_manager.rs::update_note_vfs: content read has its own prefix.
      throw new CommandError(AppError.database(`VFS 读取笔记内容失败: ${vfsErrorDisplay(error)}`));
    }
  }
  return noteItem(updated, content);
}

export function updateNoteWithCapabilities(
  conn: SqlExecutor,
  payload: Commands['notes_update']['args']['note'],
): NoteItem {
  const updated = noteRepository.updateNoteWithCapabilities(conn, payload.id, {
    title: payload.title ?? null,
    content: payload.content_md ?? null,
    tags: payload.tags ?? null,
    expectedUpdatedAt: payload.expected_updated_at ?? null,
  }, [...(payload.capabilities ?? [])]);
  const content = payload.content_md ?? noteRepository.getNoteContent(updated.id, conn) ?? '';
  return noteItem(updated, content);
}

export function setFavorite(conn: SqlExecutor, id: string, favorite: boolean): NoteItem {
  noteManagerStorage(() => noteRepository.setFavorite(id, favorite, conn), 'VFS 设置收藏状态失败');
  // notes_manager.rs::set_favorite_vfs returns via get_note_vfs, which has its
  // own read prefix (not the set-favorite one).
  try {
    const found = noteRepository.getNoteWithContent(id, conn);
    if (found === null) throw new CommandError(AppError.not_found('笔记不存在或已被删除'));
    return noteItem(found[0], found[1]);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(AppError.database(`VFS 读取笔记失败: ${vfsErrorDisplay(error)}`));
  }
}

export function deleteNote(conn: SqlExecutor, id: string): boolean {
  return noteManagerStorage(() => {
    noteRepository.deleteNoteWithFolderItem(id, conn);
    return true;
  }, 'VFS 删除笔记失败');
}

export function restoreNote(conn: SqlExecutor, id: string): boolean {
  return noteManagerStorage(() => {
    noteRepository.restoreNote(id, conn);
    return true;
  }, 'VFS 恢复笔记失败');
}

export function listNotes(conn: SqlExecutor, limit: number | null | undefined, offset: number | null | undefined): NoteItem[] {
  return noteManagerStorage(() => noteRepository.listNotes(null, limit ?? 200, offset ?? 0, conn)
    .map((note) => noteItem(note)), 'VFS 列出笔记失败');
}

export function listDeletedNotes(
  conn: SqlExecutor,
  page: number | null | undefined,
  pageSize: number | null | undefined,
): Commands['notes_list_deleted']['result'] {
  const pageValue = page ?? 0;
  const pageSizeValue = pageSize ?? 20;
  const limit = u32(pageSizeValue);
  const offset = u32(pageValue * pageSizeValue);
  try {
    const deleted = noteRepository.listDeletedNotes(limit, offset, conn);
    const items = deleted.map((note) => noteItem(note));
    let total: number;
    try {
      total = noteRepository.countDeletedNotes(conn);
    } catch (countError) {
      // Rust: count_deleted_notes(...).unwrap_or(items.len() as i64)
      notesLog.warn(`[notes] count deleted notes failed: ${String(countError)}`);
      total = items.length;
    }
    return { items, total, page: pageValue, page_size: pageSizeValue };
  } catch (error) {
    return commandDatabase('VFS 查询回收站失败', error);
  }
}

export function listTags(conn: SqlExecutor): string[] {
  try {
    return noteRepository.listTags(50, conn);
  } catch (error) {
    return commandDatabase('VFS 获取标签失败', error);
  }
}

export function searchNotes(
  conn: SqlExecutor,
  keyword: string,
  limit: number | null | undefined,
): Commands['notes_search']['result'] {
  const effectiveLimit = Math.min(200, Math.max(1, limit ?? 50));
  if (rustTrim(keyword).length === 0) return [];
  const tagFilters: string[] = [];
  const textTokens: string[] = [];
  for (const part of keyword.split(/[\p{White_Space}]+/u)) {
    if (part.length === 0) continue;
    if (part.startsWith('tag:')) {
      const tag = rustTrim(part.slice(4));
      if (tag.length > 0) tagFilters.push(tag);
    } else {
      textTokens.push(part);
    }
  }
  const textKeyword = textTokens.join(' ');
  try {
    const hits = tagFilters.length === 0
      ? noteRepository.searchNotesWithSnippets(textKeyword, effectiveLimit, conn)
      : noteRepository.searchNotesByTags(
        rustTrim(textKeyword).length === 0 ? null : textKeyword, tagFilters, effectiveLimit, conn);
    return hits.map(([note, snippet]) => ({ id: note.id, title: note.title, snippet }));
  } catch (error) {
    return commandDatabase(tagFilters.length === 0 ? 'VFS 搜索笔记失败' : 'VFS 标签搜索笔记失败', error);
  }
}

export function backlinks(conn: SqlExecutor, noteId: string): Commands['notes_get_backlinks']['result'] {
  try {
    return noteRepository.backlinksFor(noteId, conn);
  } catch (error) {
    return mapVfsError('查询反链失败', error);
  }
}

export function outgoingLinks(conn: SqlExecutor, noteId: string): Commands['notes_get_outgoing_links']['result'] {
  try {
    return noteRepository.outgoingLinksFor(noteId, conn);
  } catch (error) {
    return mapVfsError('查询出链失败', error);
  }
}

export function rebuildLinks(conn: SqlExecutor, batchSize: number | null | undefined): Commands['notes_rebuild_links']['result'] {
  configureNotesRepository(conn);
  try {
    const { noteCount, linkCount } = noteRepository.rebuildNoteLinks(
      Math.min(2000, Math.max(1, batchSize ?? 200)));
    return { noteCount, linkCount };
  } catch (error) {
    return commandDatabase('重建链接图失败', error);
  }
}

export function unlinkedMentions(
  conn: SqlExecutor,
  noteId: string,
  limit: number | null | undefined,
): Commands['notes_unlinked_mentions']['result'] {
  try {
    const hits = noteRepository.unlinkedMentionCandidates(
      noteId, Math.min(100, Math.max(1, limit ?? 20)), conn);
    return hits.map(([note, snippet]) => ({ id: note.id, title: note.title, snippet }));
  } catch (error) {
    return mapVfsError('查询未链接提及失败', error);
  }
}

export function dbStats(conn: DatabaseHandle, baseDir: string): Commands['notes_db_stats']['result'] {
  try {
    return notesDbStats(conn, baseDir);
  } catch (error) {
    // Rust: AppError::database(e.to_string()) — no extra prefix.
    throw new CommandError(AppError.database(errorMessage(error)));
  }
}

export function vacuum(conn: SqlExecutor): boolean {
  try {
    conn.exec('VACUUM');
    return true;
  } catch (error) {
    // Rust: AppError::database(e.to_string()); "VACUUM 任务失败" is only the
    // join error for spawn_blocking, which cannot happen here.
    throw new CommandError(AppError.database(errorMessage(error)));
  }
}
