/**
 * L11 `vfsRepo` (ARCHITECTURE.md 附录 A) is the single writer for `resources`, index state and
 * index units. The notes repository used to carry local copies of
 * `create_or_reuse`, `mark_pending` and `purge_index_artifacts_by_resource`;
 * per the migration quality rules it now delegates to the published repository
 * service instead. Errors keep the VfsError Display text (`Database error: ...`,
 * `Resource not found: ...`) so the command boundary maps them unchanged.
 */
import type {
  FolderRepository, IndexStateRepository, IndexUnitRepository, ResourceRepository, NoteOwnerWrites,
} from '../../vfs-repos/api.ts';
import { NoteDatabaseError } from './errors.ts';

export interface NoteResourceRepos {
  readonly noteOwnerWrites?: NoteOwnerWrites;
  readonly resources: Pick<
    ResourceRepository, 'createOrReuseWithHash' | 'computeHash' | 'computeHashWithSalt'
  >;
  readonly indexStates: Pick<IndexStateRepository, 'markPending'>;
  readonly embeddingUnits: Pick<IndexUnitRepository, 'purgeIndexArtifactsByResource'>;
  readonly folders: Pick<
    FolderRepository, 'folderExists' | 'addItemToFolder' | 'getResourceLocation' | 'removeItemByItemId'
  >;
}

let configured: (NoteResourceRepos & { readonly noteOwnerWrites: NoteOwnerWrites }) | null = null;

export function configureNoteResourceRepos(next: NoteResourceRepos | null): void {
  if (next === null) { configured = null; return; }
  if (next.noteOwnerWrites === undefined) {
    throw new NoteDatabaseError('VFS repository capability vfsRepo.noteOwnerWrites is not available');
  }
  configured = { ...next, noteOwnerWrites: next.noteOwnerWrites };
}

export function noteResourceRepos(): NoteResourceRepos & { readonly noteOwnerWrites: NoteOwnerWrites } {
  if (configured === null) {
    throw new NoteDatabaseError('VFS repository service vfsRepo is not available');
  }
  return configured;
}

/** Preserve the VfsError Display emitted by L11. */
export function vfsRepoCall<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw new NoteDatabaseError(error instanceof Error ? error.message : String(error));
  }
}
