/** Study Space profiles, Inbox folder, zero-copy cross-space mounts, and semantic anchor edge IPC commands. */
import { CommandError } from '../../../kernel/api.ts';
import type { VfsDatabase } from '../api.ts';
import type {
  AnchorEdgeRecord,
  AnchorEdgeWireInput,
  AnchorEdgesDeleteResult,
  AnchorEdgesUpsertResult,
  CreateSpaceMountInput,
  InboxFolderInfo,
  RemoveSpaceMountInput,
  StudySpaceMount,
  StudySpaceProfile,
  UpsertStudySpaceProfileInput,
} from '../../vfs-repos/api.ts';
import {
  addSpaceMountWithConn,
  deleteAnchorEdgesBySourceWithConn,
  deleteStudySpaceProfileWithConn,
  ensureInboxFolderWithConn,
  getStudySpaceProfileWithConn,
  listSpaceMountsWithConn,
  listStudySpaceProfilesWithConn,
  queryAnchorEdgesByTargetWithConn,
  removeSpaceMountWithConn,
  upsertAnchorEdgesWithConn,
  upsertStudySpaceProfileWithConn,
} from '../repository/study-spaces.ts';

export const VFS_STUDY_SPACE_GET_PROFILE_COMMAND = 'vfs_study_space_get_profile';
export const VFS_STUDY_SPACE_LIST_PROFILES_COMMAND = 'vfs_study_space_list_profiles';
export const VFS_STUDY_SPACE_UPSERT_PROFILE_COMMAND = 'vfs_study_space_upsert_profile';
export const VFS_STUDY_SPACE_DELETE_PROFILE_COMMAND = 'vfs_study_space_delete_profile';
export const VFS_SPACE_MOUNT_LIST_COMMAND = 'vfs_space_mount_list';
export const VFS_SPACE_MOUNT_ADD_COMMAND = 'vfs_space_mount_add';
export const VFS_SPACE_MOUNT_REMOVE_COMMAND = 'vfs_space_mount_remove';
export const VFS_ENSURE_INBOX_FOLDER_COMMAND = 'vfs_ensure_inbox_folder';
export const VFS_ANCHOR_EDGES_UPSERT_COMMAND = 'vfs_anchor_edges_upsert';
export const VFS_ANCHOR_EDGES_DELETE_BY_SOURCE_COMMAND = 'vfs_anchor_edges_delete_by_source';
export const VFS_ANCHOR_EDGES_QUERY_BY_TARGET_COMMAND = 'vfs_anchor_edges_query_by_target';

export const studySpaceCommands = [
  VFS_STUDY_SPACE_GET_PROFILE_COMMAND,
  VFS_STUDY_SPACE_LIST_PROFILES_COMMAND,
  VFS_STUDY_SPACE_UPSERT_PROFILE_COMMAND,
  VFS_STUDY_SPACE_DELETE_PROFILE_COMMAND,
  VFS_SPACE_MOUNT_LIST_COMMAND,
  VFS_SPACE_MOUNT_ADD_COMMAND,
  VFS_SPACE_MOUNT_REMOVE_COMMAND,
  VFS_ENSURE_INBOX_FOLDER_COMMAND,
  VFS_ANCHOR_EDGES_UPSERT_COMMAND,
  VFS_ANCHOR_EDGES_DELETE_BY_SOURCE_COMMAND,
  VFS_ANCHOR_EDGES_QUERY_BY_TARGET_COMMAND,
] as const;

export interface StudySpaceCommandDeps {
  readonly database: VfsDatabase;
}

function command<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(error instanceof Error ? error.message : String(error));
  }
}

export function getStudySpaceProfileCommand(
  deps: StudySpaceCommandDeps,
  spaceId: string,
): StudySpaceProfile | null {
  return command(() => getStudySpaceProfileWithConn(deps.database.getConnSafe(), spaceId));
}

export function listStudySpaceProfilesCommand(
  deps: StudySpaceCommandDeps,
): StudySpaceProfile[] {
  return command(() => listStudySpaceProfilesWithConn(deps.database.getConnSafe()));
}

export function upsertStudySpaceProfileCommand(
  deps: StudySpaceCommandDeps,
  input: UpsertStudySpaceProfileInput,
): StudySpaceProfile {
  return command(() => upsertStudySpaceProfileWithConn(deps.database.getConnSafe(), input));
}

export function deleteStudySpaceProfileCommand(
  deps: StudySpaceCommandDeps,
  spaceId: string,
): boolean {
  return command(() => deleteStudySpaceProfileWithConn(deps.database.getConnSafe(), spaceId));
}

export function listSpaceMountsCommand(
  deps: StudySpaceCommandDeps,
  filter: {
    spaceId?: string | null;
    targetFolderId?: string | null;
    itemType?: string | null;
    itemId?: string | null;
  },
): StudySpaceMount[] {
  return command(() => listSpaceMountsWithConn(deps.database.getConnSafe(), filter));
}

export function addSpaceMountCommand(
  deps: StudySpaceCommandDeps,
  input: CreateSpaceMountInput,
): StudySpaceMount {
  return command(() => addSpaceMountWithConn(deps.database.getConnSafe(), input));
}

export function removeSpaceMountCommand(
  deps: StudySpaceCommandDeps,
  args: {
    mountId?: string | null;
    targetFolderId?: string | null;
    itemType?: string | null;
    itemId?: string | null;
    input?: RemoveSpaceMountInput | null;
  },
): boolean {
  return command(() =>
    removeSpaceMountWithConn(deps.database.getConnSafe(), {
      mountId: args.mountId ?? args.input?.mountId ?? null,
      targetFolderId: args.targetFolderId ?? args.input?.targetFolderId ?? null,
      itemType: args.itemType ?? args.input?.itemType ?? null,
      itemId: args.itemId ?? args.input?.itemId ?? null,
    }),
  );
}

export function ensureInboxFolderCommand(
  deps: StudySpaceCommandDeps,
): InboxFolderInfo {
  return command(() => {
    const folder = ensureInboxFolderWithConn(deps.database.getConnSafe());
    return {
      id: folder.id,
      title: folder.title,
    };
  });
}

export function upsertAnchorEdgesCommand(
  deps: StudySpaceCommandDeps,
  edges: readonly AnchorEdgeWireInput[],
): AnchorEdgesUpsertResult {
  return command(() => upsertAnchorEdgesWithConn(deps.database.getConnSafe(), edges));
}

export function deleteAnchorEdgesBySourceCommand(
  deps: StudySpaceCommandDeps,
  sourceKind: string,
  sourceResourceId: string,
  keepEdgeIds?: readonly string[] | null,
): AnchorEdgesDeleteResult {
  return command(() =>
    deleteAnchorEdgesBySourceWithConn(
      deps.database.getConnSafe(),
      sourceKind,
      sourceResourceId,
      keepEdgeIds,
    ),
  );
}

export function queryAnchorEdgesByTargetCommand(
  deps: StudySpaceCommandDeps,
  targetResourceIds: readonly string[],
  targetKind?: string | null,
): AnchorEdgeRecord[] {
  return command(() =>
    queryAnchorEdgesByTargetWithConn(
      deps.database.getConnSafe(),
      targetResourceIds,
      targetKind,
    ),
  );
}
