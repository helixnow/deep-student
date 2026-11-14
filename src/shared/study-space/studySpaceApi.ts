import { invoke } from '@tauri-apps/api/core';
import type { SessionGroup } from '@/features/chat/types/group';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  INBOX_FOLDER_ID,
  STUDY_SPACE_DEFAULTS,
  inferLegacyRootFolderId,
  type CreateSpaceMountInput,
  type RemoveSpaceMountInput,
  type SpaceMountItemType,
  type StudySpaceMount,
  type StudySpaceProfile,
  type UpsertStudySpaceProfileInput,
} from './types';

const VALID_MOUNT_ITEM_TYPES = new Set<SpaceMountItemType>([
  'note',
  'exam',
  'file',
  'image',
  'translation',
  'essay',
  'mindmap',
  'folder',
]);

function isDomainValidationFailure(message: string): boolean {
  return /VALIDATION_ERROR|FOLDER_NOT_FOUND|VFS_INVALID_ARGUMENT|VFS_NOT_FOUND|FOREIGN KEY|CHECK constraint/i.test(
    message,
  );
}

export function clampDailyBudgetMinutes(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return STUDY_SPACE_DEFAULTS.dailyBudgetMinutes;
  }
  const rounded = Math.round(value);
  return Math.min(
    STUDY_SPACE_DEFAULTS.maxDailyBudgetMinutes,
    Math.max(STUDY_SPACE_DEFAULTS.minDailyBudgetMinutes, rounded),
  );
}

export function clampTargetRetention(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return STUDY_SPACE_DEFAULTS.targetRetention;
  }
  const clamped = Math.min(
    STUDY_SPACE_DEFAULTS.maxTargetRetention,
    Math.max(STUDY_SPACE_DEFAULTS.minTargetRetention, value),
  );
  return Math.round(clamped * 100) / 100;
}

export function toSpaceMountItemType(rawType: string): SpaceMountItemType {
  const normalized = rawType.trim().toLowerCase();
  if (normalized === 'textbook' || normalized === 'pdf' || normalized === 'document') {
    return 'file';
  }
  if (VALID_MOUNT_ITEM_TYPES.has(normalized as SpaceMountItemType)) {
    return normalized as SpaceMountItemType;
  }
  return 'file';
}

export function synthesizeDefaultProfile(
  group: Pick<SessionGroup, 'id' | 'rootFolderId' | 'pinnedResourceIds'> & {
    createdAt?: string;
    updatedAt?: string;
  },
): StudySpaceProfile {
  const nowIso = new Date().toISOString();
  return {
    spaceId: group.id,
    rootFolderId: inferLegacyRootFolderId(group) ?? '',
    examDate: null,
    dailyBudgetMinutes: STUDY_SPACE_DEFAULTS.dailyBudgetMinutes,
    targetRetention: STUDY_SPACE_DEFAULTS.targetRetention,
    workbenchLayoutPreset: STUDY_SPACE_DEFAULTS.workbenchLayoutPreset,
    defaultDeckId: null,
    memoryScope: STUDY_SPACE_DEFAULTS.memoryScope,
    createdAt: group.createdAt ?? nowIso,
    updatedAt: group.updatedAt ?? nowIso,
  };
}

export function synthesizeProfileFromInput(
  input: UpsertStudySpaceProfileInput,
  existing?: StudySpaceProfile | null,
): StudySpaceProfile {
  const nowIso = new Date().toISOString();
  return {
    spaceId: input.spaceId,
    rootFolderId: input.rootFolderId,
    examDate:
      input.examDate !== undefined ? input.examDate : (existing?.examDate ?? null),
    dailyBudgetMinutes:
      input.dailyBudgetMinutes !== undefined
        ? clampDailyBudgetMinutes(input.dailyBudgetMinutes)
        : (existing?.dailyBudgetMinutes ?? STUDY_SPACE_DEFAULTS.dailyBudgetMinutes),
    targetRetention:
      input.targetRetention !== undefined
        ? clampTargetRetention(input.targetRetention)
        : (existing?.targetRetention ?? STUDY_SPACE_DEFAULTS.targetRetention),
    workbenchLayoutPreset:
      input.workbenchLayoutPreset ??
      existing?.workbenchLayoutPreset ??
      STUDY_SPACE_DEFAULTS.workbenchLayoutPreset,
    defaultDeckId:
      input.defaultDeckId !== undefined
        ? input.defaultDeckId
        : (existing?.defaultDeckId ?? null),
    memoryScope:
      input.memoryScope ??
      existing?.memoryScope ??
      STUDY_SPACE_DEFAULTS.memoryScope,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

export async function getStudySpaceProfile(
  spaceId: string,
  fallbackGroup?: SessionGroup | null,
): Promise<StudySpaceProfile | null> {
  if (!spaceId.trim()) return null;
  try {
    const profile = await invoke<StudySpaceProfile | null>(
      'vfs_study_space_get_profile',
      { spaceId },
    );
    if (profile && typeof profile.spaceId === 'string') {
      return profile;
    }
    return fallbackGroup ? synthesizeDefaultProfile(fallbackGroup) : null;
  } catch {
    return fallbackGroup ? synthesizeDefaultProfile(fallbackGroup) : null;
  }
}

export async function listStudySpaceProfiles(): Promise<StudySpaceProfile[]> {
  try {
    const rows = await invoke<StudySpaceProfile[]>('vfs_study_space_list_profiles');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export async function upsertStudySpaceProfile(
  input: UpsertStudySpaceProfileInput,
): Promise<StudySpaceProfile> {
  const normalized: UpsertStudySpaceProfileInput = {
    ...input,
    spaceId: input.spaceId.trim(),
    rootFolderId: input.rootFolderId.trim(),
    examDate: input.examDate === undefined ? undefined : input.examDate?.trim() || null,
    dailyBudgetMinutes:
      input.dailyBudgetMinutes !== undefined
        ? clampDailyBudgetMinutes(input.dailyBudgetMinutes)
        : undefined,
    targetRetention:
      input.targetRetention !== undefined
        ? clampTargetRetention(input.targetRetention)
        : undefined,
    defaultDeckId:
      input.defaultDeckId === undefined ? undefined : input.defaultDeckId?.trim() || null,
  };

  try {
    const saved = await invoke<StudySpaceProfile | undefined>(
      'vfs_study_space_upsert_profile',
      { input: normalized },
    );
    if (saved && typeof saved.spaceId === 'string') {
      return saved;
    }
    throw new Error('Study Space profile was not returned by the host');
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
  }
}

export async function deleteStudySpaceProfile(spaceId: string): Promise<boolean> {
  if (!spaceId.trim()) return false;
  try {
    const deleted = await invoke<boolean | undefined>(
      'vfs_study_space_delete_profile',
      { spaceId: spaceId.trim() },
    );
    return deleted ?? true;
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    if (isDomainValidationFailure(message)) {
      throw new Error(message);
    }
    return false;
  }
}

export interface ListSpaceMountsFilter {
  spaceId?: string;
  targetFolderId?: string;
  itemType?: SpaceMountItemType;
  itemId?: string;
}

export async function listSpaceMounts(
  filter: ListSpaceMountsFilter = {},
): Promise<StudySpaceMount[]> {
  try {
    const rows = await invoke<StudySpaceMount[]>('vfs_space_mount_list', {
      spaceId: filter.spaceId,
      targetFolderId: filter.targetFolderId,
      itemType: filter.itemType,
      itemId: filter.itemId,
    });
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export async function addSpaceMount(
  input: CreateSpaceMountInput,
): Promise<StudySpaceMount> {
  const normalized: CreateSpaceMountInput = {
    spaceId: input.spaceId.trim(),
    targetFolderId: input.targetFolderId.trim(),
    itemType: toSpaceMountItemType(input.itemType),
    itemId: input.itemId.trim(),
  };

  try {
    const created = await invoke<StudySpaceMount | undefined>(
      'vfs_space_mount_add',
      { input: normalized },
    );
    if (created && typeof created.id === 'string') {
      return created;
    }
    throw new Error('Space mount was not returned by the host');
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
  }
}

export async function removeSpaceMount(input: RemoveSpaceMountInput): Promise<boolean> {
  try {
    const removed = await invoke<boolean | undefined>(
      'vfs_space_mount_remove',
      {
        mountId: input.mountId,
        targetFolderId: input.targetFolderId,
        itemType: input.itemType,
        itemId: input.itemId,
        input,
      },
    );
    return removed ?? true;
  } catch (error: unknown) {
    throw new Error(getErrorMessage(error));
  }
}

export async function ensureInboxFolder(): Promise<{ id: string; title: string }> {
  try {
    const folder = await invoke<{ id: string; title: string } | undefined>(
      'vfs_ensure_inbox_folder',
    );
    if (folder && typeof folder.id === 'string') {
      return folder;
    }
    return { id: INBOX_FOLDER_ID, title: 'Inbox' };
  } catch {
    return { id: INBOX_FOLDER_ID, title: 'Inbox' };
  }
}
