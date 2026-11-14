/** vfs/handlers.rs 笔记命令（handlers.rs:460-668）；表由 L10 notes 拥有。 */
import type { Context } from '@deepseek-ai/cordis';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import { CommandError } from '../../../kernel/api.ts';
import { VfsError } from '../../vfs/portable.ts';
import { VfsRepositoryError } from '../../vfs-repos/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { NoteRepository } from '../../notes/api.ts';
import type { VfsNote } from '../../../../contracts/ipc/generated/_shared.ts';
import { validateIdFormat } from './resources.ts';
import { NoteDeleteHookSet } from './hooks.ts';

const MAX_NOTE_SIZE = 5 * 1024 * 1024;

export interface CreateNoteInput {
  title: string;
  content: string;
  tags?: string[];
}

export interface UpdateNoteInput {
  content: string;
  title?: string | null;
  tags?: string[] | null;
  expectedUpdatedAt?: string | null;
}

export interface NoteDeps {
  readonly conn: () => DatabaseHandle;
  readonly notes: NoteRepository;
  readonly hooks: NoteDeleteHookSet;
  readonly log: Context['logger'];
}

function fail(error: unknown): never {
  if (error instanceof CommandError) throw error;
  if (error instanceof VfsError) throw new CommandError(error.toString());
  if (error instanceof VfsRepositoryError) throw new CommandError(error.message);
  // L10 repository errors (NoteDocumentError / NoteDatabaseError) mirror VfsError Display.
  if (error instanceof Error) throw new CommandError(error.message);
  throw error;
}

function validateContentSize(content: string): void {
  if (utf8ByteLength(content) > MAX_NOTE_SIZE) {
    throw new VfsError('InvalidArgument', {
      param: 'content',
      reason: `笔记内容大小超出限制（最大 ${MAX_NOTE_SIZE / 1024 / 1024}MB）`,
    });
  }
}

export function createNote(deps: NoteDeps, params: CreateNoteInput): VfsNote {
  deps.log.info('[VFS::handlers] vfs_create_note: title=%s', params.title);
  try {
    validateContentSize(params.content);
    if (rustTrim(params.title) === '') {
      throw new VfsError('InvalidArgument', { param: 'title', reason: 'Title cannot be empty' });
    }
    const note = deps.notes.createNote({
      title: params.title,
      content: params.content,
      tags: params.tags ?? [],
    }, deps.conn());
    deps.log.info('[VFS::handlers] Note created: id=%s', note.id);
    return note;
  } catch (error) {
    return fail(error);
  }
}

export function updateNote(deps: NoteDeps, id: string, params: UpdateNoteInput): VfsNote {
  deps.log.info('[VFS::handlers] vfs_update_note: id=%s, content_len=%d', id, utf8ByteLength(params.content));
  try {
    validateContentSize(params.content);
    validateIdFormat(id, 'note_', 'id');
    const note = deps.notes.updateNote(id, {
      content: params.content,
      title: params.title ?? null,
      tags: params.tags ?? null,
      expectedUpdatedAt: params.expectedUpdatedAt ?? null,
    }, deps.conn());
    deps.log.info('[VFS::handlers] Note updated: id=%s', note.id);
    return note;
  } catch (error) {
    return fail(error);
  }
}

export function getNote(deps: NoteDeps, id: string): VfsNote | null {
  try {
    validateIdFormat(id, 'note_', 'id');
    return deps.notes.getNote(id, deps.conn());
  } catch (error) {
    return fail(error);
  }
}

export function getNoteContent(deps: NoteDeps, id: string): string | null {
  try {
    validateIdFormat(id, 'note_', 'id');
    return deps.notes.getNoteContent(id, deps.conn());
  } catch (error) {
    return fail(error);
  }
}

export interface ListNotesInput {
  search?: string | null;
  limit?: number;
  offset?: number;
}

export function listNotes(deps: NoteDeps, params: ListNotesInput | null): VfsNote[] {
  try {
    return deps.notes.listNotes(
      params?.search ?? null,
      params?.limit ?? 50,
      params?.offset ?? 0,
      deps.conn(),
    );
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:646-668：先捕获 memory 上下文，删除后执行收尾。 */
export function deleteNote(deps: NoteDeps, id: string): null {
  deps.log.info('[VFS::handlers] vfs_delete_note: id=%s', id);
  try {
    validateIdFormat(id, 'note_', 'id');
  } catch (error) {
    return fail(error);
  }
  const continuations = deps.hooks.capture(id);
  try {
    deps.notes.deleteNoteWithFolderItem(id, deps.conn());
  } catch (error) {
    return fail(error);
  }
  for (const run of continuations) {
    try {
      run();
    } catch (error) {
      deps.log.warn('[VFS::handlers] Note delete continuation failed for %s: %s', id, error);
    }
  }
  return null;
}
