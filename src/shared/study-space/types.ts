/**
 * Ungrouped conversations live in Inbox.
 * In Chat V2, Inbox is represented by `groupId === null` (`INBOX_SPACE_ID`).
 * In VFS, Inbox owns deterministic canonical folder `fld_inbox` (`INBOX_FOLDER_ID`).
 */
export const INBOX_SPACE_ID = null;
export type InboxSpaceId = typeof INBOX_SPACE_ID;
export const INBOX_SPACE_FILTER_KEY = '__inbox__' as const;
export const ALL_SPACES_FILTER_KEY = '__all__' as const;
export const INBOX_FOLDER_ID = 'fld_inbox' as const;

export type ActiveSpaceSelection = string | InboxSpaceId;

export type StudySpaceMemoryScope =
  | 'space_isolated'
  | 'space_and_global'
  | 'global_only';

export type WorkbenchLayoutPreset =
  | 'chat_focus'
  | 'split_reader_chat'
  | 'split_notes_chat'
  | 'practice_review'
  | 'freeform_desktop';

export type SpaceMountItemType =
  | 'note'
  | 'exam'
  | 'file'
  | 'image'
  | 'translation'
  | 'essay'
  | 'mindmap'
  | 'folder';

export const STUDY_SPACE_DEFAULTS = {
  dailyBudgetMinutes: 45,
  minDailyBudgetMinutes: 5,
  maxDailyBudgetMinutes: 480,
  targetRetention: 0.9,
  minTargetRetention: 0.7,
  maxTargetRetention: 0.97,
  workbenchLayoutPreset: 'split_reader_chat' as WorkbenchLayoutPreset,
  memoryScope: 'space_and_global' as StudySpaceMemoryScope,
} as const;

export interface StudySpaceProfile {
  /** Strictly equal to `SessionGroup.id` */
  spaceId: string;
  /** Canonical VFS folder ID (`fld_*`) owned by this Study Space */
  rootFolderId: string;
  /** Target exam date in ISO `YYYY-MM-DD`, or `null` when unset */
  examDate: string | null;
  /** Planned daily study budget in minutes (`5..480`) */
  dailyBudgetMinutes: number;
  /** Target FSRS retention ratio (`0.70..0.97`, default `0.90`) */
  targetRetention: number;
  /** Preferred Workbench window arrangement when entering this Space */
  workbenchLayoutPreset: WorkbenchLayoutPreset;
  /** Bound Anki/FSRS deck identifier or deck path (`anki_decks` / `DeckTreeNode.path`), or `null` */
  defaultDeckId: string | null;
  /** Memory read/write isolation policy */
  memoryScope: StudySpaceMemoryScope;
  createdAt: string;
  updatedAt: string;
}

export interface StudySpaceMount {
  /** Primary key `mnt_<uuid>` */
  id: string;
  /** Owning Study Space ID (`=== SessionGroup.id`) */
  spaceId: string;
  /** Target VFS folder inside the Study Space where the mount appears (`rootFolderId` or subfolder) */
  targetFolderId: string;
  /** Mounted VFS entity kind */
  itemType: SpaceMountItemType;
  /** Canonical VFS entity ID (`note`, `file`, `exam_sheet`, `folder`, etc.) */
  itemId: string;
  createdAt: string;
}

/**
 * Unified runtime projection of `SessionGroup` + `StudySpaceProfile` + `StudySpaceMount[]`.
 */
export interface StudySpace {
  /** Strictly `group.id` */
  spaceId: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  systemPrompt?: string;
  defaultSkillIds: string[];
  pinnedResourceIds: string[];
  defaultRuntimeRootId?: string | null;
  preferredProjectRootPath?: string | null;
  sortOrder: number;
  persistStatus: 'active' | 'archived' | 'deleted';
  /** Explicit canonical VFS root folder (`fld_*`) */
  rootFolderId: string;
  examDate: string | null;
  dailyBudgetMinutes: number;
  targetRetention: number;
  workbenchLayoutPreset: WorkbenchLayoutPreset;
  /** Deduplicated `itemId` list from active `mounts` for fast UI & badge lookup */
  mountedResourceIds: string[];
  mounts: StudySpaceMount[];
  defaultDeckId: string | null;
  memoryScope: StudySpaceMemoryScope;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertStudySpaceProfileInput {
  spaceId: string;
  rootFolderId: string;
  examDate?: string | null;
  dailyBudgetMinutes?: number;
  targetRetention?: number;
  workbenchLayoutPreset?: WorkbenchLayoutPreset;
  defaultDeckId?: string | null;
  memoryScope?: StudySpaceMemoryScope;
}

export interface CreateSpaceMountInput {
  spaceId: string;
  targetFolderId: string;
  itemType: SpaceMountItemType;
  itemId: string;
}

export interface RemoveSpaceMountInput {
  mountId?: string;
  targetFolderId?: string;
  itemType?: SpaceMountItemType;
  itemId?: string;
}

export interface StudySpaceChangedEventDetail {
  spaceId: ActiveSpaceSelection;
  rootFolderId: string;
  defaultDeckId: string | null;
  targetRetention: number;
  memoryScope: StudySpaceMemoryScope;
  workbenchLayoutPreset: WorkbenchLayoutPreset;
}

export const STUDY_SPACE_CHANGED_EVENT = 'study-space:changed' as const;

export const STUDY_SPACE_IPC_COMMANDS = {
  getProfile: 'vfs_study_space_get_profile',
  listProfiles: 'vfs_study_space_list_profiles',
  upsertProfile: 'vfs_study_space_upsert_profile',
  deleteProfile: 'vfs_study_space_delete_profile',
  listMounts: 'vfs_space_mount_list',
  addMount: 'vfs_space_mount_add',
  removeMount: 'vfs_space_mount_remove',
  ensureInboxFolder: 'vfs_ensure_inbox_folder',
} as const;

export function inferLegacyRootFolderId(group: { rootFolderId?: string | null; pinnedResourceIds: string[] }): string | null {
  if (typeof group.rootFolderId === 'string' && group.rootFolderId.trim().length > 0) {
    return group.rootFolderId.trim();
  }
  const found = group.pinnedResourceIds.find((id) => id.startsWith('fld_'));
  return found ?? null;
}
