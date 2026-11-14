/**
 * Other lanes' published repository services used by DSTU command implementations.
 * Rust: DSTU handlers call `VfsNoteRepo` (L10 notes) and `vfs::repos` (L11).
 * Keeping the owner lanes as the only writers avoids duplicating their transactions,
 * revision snapshots and folder-item hooks.
 */
import type { NoteLeaseRepository, NoteRepository } from '../../notes/api.ts';
import type { StudySpaceRepository, VfsReposService } from '../../vfs-repos/api.ts';
import { VfsError } from '../src/error.ts';

export interface VfsSharedRepositories {
  readonly notes: NoteRepository;
  readonly leases?: NoteLeaseRepository;
  readonly repos: VfsReposService;
  readonly log?: { warn(message: string, ...args: unknown[]): void };
}

let shared: VfsSharedRepositories | undefined;

export function configureVfsSharedRepositories(value: VfsSharedRepositories | undefined): void {
  shared = value;
}

export function hasVfsSharedRepositories(): boolean {
  return shared !== undefined;
}

export function vfsRepositoryLog(): VfsSharedRepositories['log'] { return shared?.log; }

function required(): VfsSharedRepositories {
  if (shared === undefined) {
    throw new VfsError('Database', 'VFS shared repositories are not configured');
  }
  return shared;
}

export function notesRepository(): NoteRepository {
  return required().notes;
}

export function notesLeaseRepository(): NoteLeaseRepository {
  const leases = required().leases;
  if (leases === undefined) throw new VfsError('Database', 'Notes lease repository is not configured');
  return leases;
}

interface NoteDocumentFailure extends Error {
  readonly kind: 'invalid' | 'conflict';
  readonly key: string;
}

function isNoteDocumentFailure(error: unknown): error is NoteDocumentFailure {
  if (!(error instanceof Error)) return false;
  const kind = (error as { kind?: unknown }).kind;
  return kind === 'invalid' || kind === 'conflict';
}

/**
 * L10 repositories raise note-document failures; Rust DSTU callers surface the same
 * VfsError Display ("Invalid argument 'note_document': ..." / "CONFLICT(key): ...").
 */
export function callNoteRepository<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (isNoteDocumentFailure(error)) {
      if (error.kind === 'conflict') {
        throw new VfsError('Conflict', { key: error.key || 'notes.conflict', message: error.message });
      }
      throw new VfsError('InvalidArgument', { param: 'note_document', reason: error.message });
    }
    throw error;
  }
}

export function vfsRepositories(): VfsReposService {
  return required().repos;
}

export function studySpacesRepository(): StudySpaceRepository {
  return required().repos.studySpaces;
}
