// extensions.rs registers the note asset reference guard into the file deletion
// journal (dstu-storage::file_deletion_queue::register_note_asset_retention).
// The journal hands the callback the caller's SqlExecutor, so the history query
// runs on the same connection/transaction as the prepared intent.
import type { Disposer } from '../../../kernel/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { notesLocalRuntime } from '../src/local-runtime.ts';
import { noteRevisionRepository } from './revisions.ts';

/** NoteRevisionRepo::asset_is_referenced across current documents, trash and history. */
export function notesAssetIsReferenced(conn: SqlExecutor, relativePath: string): boolean {
  return noteRevisionRepository.assetIsReferenced(conn, relativePath);
}

/** Register the lane callback used by prepare/finish asset deletion intent. */
export function registerNotesAssetRetention(): Disposer {
  return notesLocalRuntime().registerNoteAssetRetention({ assetIsReferenced: notesAssetIsReferenced });
}
