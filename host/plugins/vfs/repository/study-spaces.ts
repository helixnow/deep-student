/** Connection-bound Study Space & Anchor Edge repository helpers for L13 VFS commands. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import {
  StudySpaceRepo,
  type AnchorEdgeRecord,
  type AnchorEdgeWireInput,
  type AnchorEdgesDeleteResult,
  type AnchorEdgesUpsertResult,
  type CreateSpaceMountInput,
  type ListSpaceMountsFilter,
  type RemoveSpaceMountInput,
  type ResolvedMountScope,
  type StudySpaceMount,
  type StudySpaceProfile,
  type StudySpaceRepository,
  type UpsertStudySpaceProfileInput,
  type VfsFolder,
} from '../../vfs-repos/api.ts';
import { VfsError } from '../src/error.ts';
import { hasVfsSharedRepositories, vfsRepositories } from './services.ts';

const fallbackRepo = new StudySpaceRepo();

function repo(): StudySpaceRepository {
  if (hasVfsSharedRepositories()) {
    const studySpaces = vfsRepositories().studySpaces;
    if (studySpaces !== undefined) return studySpaces;
  }
  return fallbackRepo;
}

function wrapDb<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof VfsError) throw error;
    throw new VfsError('Database', error instanceof Error ? error.message : String(error));
  }
}

export function ensureInboxFolderWithConn(conn: SqlExecutor): VfsFolder {
  return wrapDb(() => repo().ensureInboxFolder(conn));
}

export function getStudySpaceProfileWithConn(conn: SqlExecutor, spaceId: string): StudySpaceProfile | null {
  return wrapDb(() => repo().getProfile(conn, spaceId));
}

export function listStudySpaceProfilesWithConn(conn: SqlExecutor): StudySpaceProfile[] {
  return wrapDb(() => repo().listProfiles(conn));
}

export function upsertStudySpaceProfileWithConn(
  conn: SqlExecutor,
  input: UpsertStudySpaceProfileInput,
): StudySpaceProfile {
  return wrapDb(() => repo().upsertProfile(conn, input));
}

export function deleteStudySpaceProfileWithConn(conn: SqlExecutor, spaceId: string): boolean {
  return wrapDb(() => repo().deleteProfile(conn, spaceId));
}

export function listSpaceMountsWithConn(
  conn: SqlExecutor,
  filter?: ListSpaceMountsFilter,
): StudySpaceMount[] {
  return wrapDb(() => repo().listMounts(conn, filter));
}

export function safeListFolderMountsWithConn(
  conn: SqlExecutor,
  targetFolderId: string,
): StudySpaceMount[] {
  try {
    return repo().listMounts(conn, { targetFolderId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('no such table: vfs_space_mounts')) {
      return [];
    }
    throw error instanceof VfsError ? error : new VfsError('Database', msg);
  }
}

export function getCanonicalFolderIdForItemWithConn(
  conn: SqlExecutor,
  itemType: string,
  itemId: string,
): string | null {
  try {
    const row = conn.get<{ folder_id: unknown }>(
      `SELECT folder_id FROM folder_items
       WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL
       LIMIT 1`,
      [itemType, itemId],
    );
    if (row === undefined) return null;
    return typeof row.folder_id === 'string' ? row.folder_id : null;
  } catch {
    return null;
  }
}

export function addSpaceMountWithConn(
  conn: SqlExecutor,
  input: CreateSpaceMountInput,
): StudySpaceMount {
  return wrapDb(() => repo().addMount(conn, input));
}

export function removeSpaceMountWithConn(
  conn: SqlExecutor,
  input: RemoveSpaceMountInput,
): boolean {
  return wrapDb(() => repo().removeMount(conn, input));
}

export function resolveMountScopeForFoldersWithConn(
  conn: SqlExecutor,
  folderIds: readonly string[],
): ResolvedMountScope {
  return wrapDb(() => repo().resolveMountScopeForFolders(conn, folderIds));
}

export function upsertAnchorEdgesWithConn(
  conn: SqlExecutor,
  edges: readonly AnchorEdgeWireInput[],
): AnchorEdgesUpsertResult {
  return wrapDb(() => repo().upsertAnchorEdges(conn, edges));
}

export function deleteAnchorEdgesBySourceWithConn(
  conn: SqlExecutor,
  sourceKind: string,
  sourceResourceId: string,
  keepEdgeIds?: readonly string[] | null,
): AnchorEdgesDeleteResult {
  return wrapDb(() => repo().deleteAnchorEdgesBySource(conn, sourceKind, sourceResourceId, keepEdgeIds));
}

export function queryAnchorEdgesByTargetWithConn(
  conn: SqlExecutor,
  targetResourceIds: readonly string[],
  targetKind?: string | null,
): AnchorEdgeRecord[] {
  return wrapDb(() => repo().queryAnchorEdgesByTarget(conn, targetResourceIds, targetKind));
}
