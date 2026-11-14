/**
 * Tool executors receive the chat-pipeline context as `services`. It only injects chat-pipeline's own
 * dependencies, so property access to vfs-side services throws "without inject" there; read them with `get`.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { VfsDatabase } from '../../api.ts';
import type { NotesService } from '../../../notes/api.ts';
import type { VfsReposService } from '../../../vfs-repos/api.ts';

/** builtin_resource_executor.rs:592 `ctx.vfs_db.as_ref().ok_or("VFS database not available")`. */
export function toolVfsDatabase(ctx: Context): VfsDatabase {
  const database = ctx.get('vfsDatabase');
  if (database === undefined) throw new Error('VFS database not available');
  return database;
}

export function toolVfsRepos(ctx: Context): VfsReposService {
  const repos = ctx.get('vfsRepo');
  if (repos === undefined) throw new Error('VFS repositories not available');
  return repos;
}

export function toolNotes(ctx: Context): NotesService {
  const notes = ctx.get('notes');
  if (notes === undefined) throw new Error('Notes service not available');
  return notes;
}
