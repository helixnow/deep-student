import { create } from 'zustand';
import { dispatchTypedEvent } from '@/events';
import { groupCache, setGroupsCache } from '@/shared/study-space/groupCache';
import type { SessionGroup } from '@/features/chat/types/group';
import {
  INBOX_FOLDER_ID,
  INBOX_SPACE_FILTER_KEY,
  INBOX_SPACE_ID,
  STUDY_SPACE_CHANGED_EVENT,
  STUDY_SPACE_DEFAULTS,
  inferLegacyRootFolderId,
  type ActiveSpaceSelection,
  type CreateSpaceMountInput,
  type RemoveSpaceMountInput,
  type StudySpace,
  type StudySpaceChangedEventDetail,
  type StudySpaceMount,
  type StudySpaceProfile,
  type UpsertStudySpaceProfileInput,
} from '@/shared/study-space/types';
import {
  addSpaceMount,
  getStudySpaceProfile,
  listSpaceMounts,
  listStudySpaceProfiles,
  removeSpaceMount,
  synthesizeDefaultProfile,
  upsertStudySpaceProfile,
} from '@/shared/study-space/studySpaceApi';

export const ACTIVE_STUDY_SPACE_STORAGE_KEY = 'ds.studySpace.activeId.v1';

export type StudySpaceViewFilter = 'all' | 'inbox' | string;

let hydrationGeneration = 0;
const removedSpaceIds = new Set<string>();
const profileSaveGeneration = new Map<string, number>();
const spaceRefreshGeneration = new Map<string, number>();

export type StagedCreateSpaceProfileDraft = Omit<
  UpsertStudySpaceProfileInput,
  'spaceId' | 'rootFolderId'
>;

function readPersistedActiveSpaceId(): ActiveSpaceSelection {
  if (typeof window === 'undefined') return INBOX_SPACE_ID;
  try {
    const raw = window.localStorage.getItem(ACTIVE_STUDY_SPACE_STORAGE_KEY);
    if (
      raw === null ||
      raw === '' ||
      raw === 'null' ||
      raw === INBOX_SPACE_FILTER_KEY
    ) {
      return INBOX_SPACE_ID;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : INBOX_SPACE_ID;
  } catch {
    return INBOX_SPACE_ID;
  }
}

function writePersistedActiveSpaceId(spaceId: ActiveSpaceSelection): void {
  if (typeof window === 'undefined') return;
  try {
    const serialized =
      spaceId === INBOX_SPACE_ID ? INBOX_SPACE_FILTER_KEY : spaceId;
    window.localStorage.setItem(ACTIVE_STUDY_SPACE_STORAGE_KEY, serialized);
  } catch {
    // Ignore storage quota or sandbox errors.
  }
}

export function projectStudySpace(
  group: SessionGroup,
  profile: StudySpaceProfile | undefined,
  mounts: StudySpaceMount[] | undefined,
): StudySpace {
  const effectiveProfile = profile ?? synthesizeDefaultProfile(group);
  const effectiveMounts = mounts ?? [];
  const rootFolderId =
    effectiveProfile.rootFolderId.trim() ||
    inferLegacyRootFolderId(group) ||
    '';
  const mountedResourceIds = Array.from(
    new Set(effectiveMounts.map((mount) => mount.itemId)),
  );

  return {
    spaceId: group.id,
    name: group.name,
    description: group.description,
    icon: group.icon,
    color: group.color,
    systemPrompt: group.systemPrompt,
    defaultSkillIds: group.defaultSkillIds ?? [],
    pinnedResourceIds: group.pinnedResourceIds ?? [],
    defaultRuntimeRootId: group.defaultRuntimeRootId,
    preferredProjectRootPath: group.preferredProjectRootPath,
    sortOrder: group.sortOrder,
    persistStatus: group.persistStatus,
    rootFolderId,
    examDate: effectiveProfile.examDate,
    dailyBudgetMinutes: effectiveProfile.dailyBudgetMinutes,
    targetRetention: effectiveProfile.targetRetention,
    workbenchLayoutPreset: effectiveProfile.workbenchLayoutPreset,
    mountedResourceIds,
    mounts: effectiveMounts,
    defaultDeckId: effectiveProfile.defaultDeckId,
    memoryScope: effectiveProfile.memoryScope,
    createdAt: group.createdAt,
    updatedAt:
      effectiveProfile.updatedAt > group.updatedAt
        ? effectiveProfile.updatedAt
        : group.updatedAt,
  };
}

export interface StudySpaceStoreState {
  activeSpaceId: ActiveSpaceSelection;
  viewFilter: StudySpaceViewFilter;
  groupsById: Record<string, SessionGroup>;
  profilesBySpaceId: Record<string, StudySpaceProfile>;
  mountsBySpaceId: Record<string, StudySpaceMount[]>;
  loading: boolean;
  stagedCreateProfileDraft: StagedCreateSpaceProfileDraft | null;

  hydrateFromGroups: (groups: SessionGroup[]) => Promise<void>;
  getStudySpace: (spaceId: string, group?: SessionGroup) => StudySpace | null;
  refreshStudySpace: (spaceId: string, group?: SessionGroup) => Promise<StudySpace | null>;
  setActiveSpace: (
    spaceId: ActiveSpaceSelection,
    options?: { applyWorkbenchPreset?: boolean },
  ) => void;
  setViewFilter: (filter: StudySpaceViewFilter) => void;
  stageCreateProfileDraft: (draft: StagedCreateSpaceProfileDraft | null) => void;
  consumeStagedCreateProfileDraft: () => StagedCreateSpaceProfileDraft | null;
  upsertGroupInState: (group: SessionGroup) => void;
  removeGroupFromState: (spaceId: string) => void;
  saveSpaceProfile: (input: UpsertStudySpaceProfileInput) => Promise<StudySpaceProfile>;
  mountItemToSpace: (input: CreateSpaceMountInput) => Promise<StudySpaceMount>;
  unmountItemFromSpace: (
    spaceId: string,
    input: RemoveSpaceMountInput,
  ) => Promise<void>;
  resetForTests: () => void;
}

export const useStudySpaceStore = create<StudySpaceStoreState>((set, get) => ({
  activeSpaceId: readPersistedActiveSpaceId(),
  viewFilter: 'all',
  groupsById: {},
  profilesBySpaceId: {},
  mountsBySpaceId: {},
  loading: false,
  stagedCreateProfileDraft: null,

  hydrateFromGroups: async (groups) => {
    const generation = ++hydrationGeneration;
    const activeGroups = groups.filter((group) => group.persistStatus === 'active');
    setGroupsCache(activeGroups);
    const nextGroupsById: Record<string, SessionGroup> = {};
    for (const group of activeGroups) {
      nextGroupsById[group.id] = group;
      removedSpaceIds.delete(group.id);
    }
    const before = get();
    for (const id of Object.keys(before.groupsById)) {
      if (!nextGroupsById[id]) removedSpaceIds.add(id);
    }
    const profilesAtStart = before.profilesBySpaceId;
    const mountsAtStart = before.mountsBySpaceId;
    // Publish the authoritative group list before awaiting IPC. Local removals or edits
    // made while the reads are in flight must not be replaced by this snapshot.
    set({ loading: true, groupsById: nextGroupsById });
    if (before.activeSpaceId !== INBOX_SPACE_ID && !nextGroupsById[before.activeSpaceId]) {
      get().setActiveSpace(INBOX_SPACE_ID);
    }

    const [fetchedProfiles, fetchedMounts] = await Promise.all([
      listStudySpaceProfiles(),
      listSpaceMounts({}),
    ]);
    if (generation !== hydrationGeneration) return;
    const current = get();
    const currentGroups = Object.values(current.groupsById);
    const fetchedBySpaceId = new Map<string, StudySpaceProfile>();
    for (const profile of fetchedProfiles) {
      fetchedBySpaceId.set(profile.spaceId, profile);
    }

    const nextProfilesBySpaceId: Record<string, StudySpaceProfile> = {};
    for (const group of currentGroups) {
      const existing = current.profilesBySpaceId[group.id] !== profilesAtStart[group.id]
        ? current.profilesBySpaceId[group.id]
        : fetchedBySpaceId.get(group.id) ?? current.profilesBySpaceId[group.id];
      const inferredRoot = inferLegacyRootFolderId(group) ?? '';
      if (!existing) {
        nextProfilesBySpaceId[group.id] = synthesizeDefaultProfile(group);
      } else if (!existing.rootFolderId && inferredRoot) {
        nextProfilesBySpaceId[group.id] = {
          ...existing,
          rootFolderId: inferredRoot,
        };
      } else {
        nextProfilesBySpaceId[group.id] = existing;
      }
    }

    const nextMountsBySpaceId: Record<string, StudySpaceMount[]> = {};
    for (const group of currentGroups) {
      nextMountsBySpaceId[group.id] = [];
    }
    for (const mount of fetchedMounts) {
      if (!current.groupsById[mount.spaceId]) continue;
      const bucket = nextMountsBySpaceId[mount.spaceId] ?? [];
      bucket.push(mount);
      nextMountsBySpaceId[mount.spaceId] = bucket;
    }
    for (const group of currentGroups) {
      if (current.mountsBySpaceId[group.id] !== mountsAtStart[group.id]) {
        nextMountsBySpaceId[group.id] = current.mountsBySpaceId[group.id] ?? [];
      }
    }

    set({
      profilesBySpaceId: nextProfilesBySpaceId,
      mountsBySpaceId: nextMountsBySpaceId,
      loading: false,
    });
  },

  getStudySpace: (spaceId, group) => {
    if (!spaceId) return null;
    const state = get();
    const resolvedGroup =
      group ?? state.groupsById[spaceId] ?? groupCache.get(spaceId);
    if (!resolvedGroup || resolvedGroup.persistStatus !== 'active' || removedSpaceIds.has(spaceId)) return null;
    return projectStudySpace(
      resolvedGroup,
      state.profilesBySpaceId[spaceId],
      state.mountsBySpaceId[spaceId],
    );
  },

  refreshStudySpace: async (spaceId, group) => {
    if (removedSpaceIds.has(spaceId)) return null;
    const generation = (spaceRefreshGeneration.get(spaceId) ?? 0) + 1;
    spaceRefreshGeneration.set(spaceId, generation);
    if (!get().groupsById[spaceId] && group) get().upsertGroupInState(group);
    const before = get();
    const [profile, mounts] = await Promise.all([
      getStudySpaceProfile(spaceId),
      listSpaceMounts({ spaceId }),
    ]);
    const current = get();
    if (removedSpaceIds.has(spaceId) || !current.groupsById[spaceId]) return null;
    if (spaceRefreshGeneration.get(spaceId) !== generation) return current.getStudySpace(spaceId);
    set({
      profilesBySpaceId: profile && current.profilesBySpaceId[spaceId] === before.profilesBySpaceId[spaceId]
        ? { ...current.profilesBySpaceId, [spaceId]: profile } : current.profilesBySpaceId,
      mountsBySpaceId: current.mountsBySpaceId[spaceId] === before.mountsBySpaceId[spaceId]
        ? { ...current.mountsBySpaceId, [spaceId]: mounts } : current.mountsBySpaceId,
    });
    return get().getStudySpace(spaceId);
  },

  setActiveSpace: (spaceId, _options) => {
    const normalizedId: ActiveSpaceSelection =
      typeof spaceId === 'string' && spaceId.trim().length > 0 &&
      spaceId !== INBOX_FOLDER_ID && spaceId !== INBOX_SPACE_FILTER_KEY && spaceId !== 'ungrouped'
        ? spaceId.trim()
        : INBOX_SPACE_ID;

    if (get().activeSpaceId !== normalizedId) set({ activeSpaceId: normalizedId });
    writePersistedActiveSpaceId(normalizedId);

    const state = get();
    if (normalizedId !== null) {
      const knownGroup = state.groupsById[normalizedId];
      if (knownGroup && !groupCache.get(normalizedId)) {
        const allGroups = Object.values(state.groupsById);
        if (allGroups.length > 0) {
          setGroupsCache(allGroups);
        }
      }
    }

    const detail: StudySpaceChangedEventDetail = (() => {
      if (normalizedId === null) {
        return {
          spaceId: INBOX_SPACE_ID,
          rootFolderId: INBOX_FOLDER_ID,
          defaultDeckId: null,
          targetRetention: STUDY_SPACE_DEFAULTS.targetRetention,
          memoryScope: STUDY_SPACE_DEFAULTS.memoryScope,
          workbenchLayoutPreset: STUDY_SPACE_DEFAULTS.workbenchLayoutPreset,
        };
      }
      const group = state.groupsById[normalizedId] ?? groupCache.get(normalizedId);
      const profile = state.profilesBySpaceId[normalizedId];
      const rootFolderId =
        profile?.rootFolderId ||
        (group ? inferLegacyRootFolderId(group) : null) ||
        '';
      return {
        spaceId: normalizedId,
        rootFolderId,
        defaultDeckId: profile?.defaultDeckId ?? null,
        targetRetention:
          profile?.targetRetention ?? STUDY_SPACE_DEFAULTS.targetRetention,
        memoryScope: profile?.memoryScope ?? STUDY_SPACE_DEFAULTS.memoryScope,
        workbenchLayoutPreset:
          profile?.workbenchLayoutPreset ??
          STUDY_SPACE_DEFAULTS.workbenchLayoutPreset,
      };
    })();

    // WorkbenchDesktop is the sole layout owner; do not race its snapshot restore
    // with a second preset applier after dispatching this event.
    dispatchTypedEvent(STUDY_SPACE_CHANGED_EVENT, detail);
  },

  setViewFilter: (viewFilter) => {
    set({ viewFilter });
  },

  stageCreateProfileDraft: (draft) => {
    set({ stagedCreateProfileDraft: draft });
  },

  consumeStagedCreateProfileDraft: () => {
    const current = get().stagedCreateProfileDraft;
    if (current) {
      set({ stagedCreateProfileDraft: null });
    }
    return current;
  },

  upsertGroupInState: (group) => {
    if (group.persistStatus !== 'active') {
      get().removeGroupFromState(group.id);
      return;
    }
    removedSpaceIds.delete(group.id);
    groupCache.set(group.id, group);
    set((state) => {
      const nextGroupsById = { ...state.groupsById, [group.id]: group };
      const existingProfile = state.profilesBySpaceId[group.id];
      const inferredRoot = inferLegacyRootFolderId(group) ?? '';
      const nextProfile = existingProfile
        ? inferredRoot && existingProfile.rootFolderId !== inferredRoot
          ? { ...existingProfile, rootFolderId: inferredRoot }
          : existingProfile
        : synthesizeDefaultProfile(group);
      return {
        groupsById: nextGroupsById,
        profilesBySpaceId: {
          ...state.profilesBySpaceId,
          [group.id]: nextProfile,
        },
        mountsBySpaceId: {
          ...state.mountsBySpaceId,
          [group.id]: state.mountsBySpaceId[group.id] ?? [],
        },
      };
    });
  },

  removeGroupFromState: (spaceId) => {
    removedSpaceIds.add(spaceId);
    groupCache.delete(spaceId);
    const wasActive = get().activeSpaceId === spaceId;
    set((state) => {
      const { [spaceId]: _g, ...nextGroupsById } = state.groupsById;
      const { [spaceId]: _p, ...nextProfilesBySpaceId } = state.profilesBySpaceId;
      const { [spaceId]: _m, ...nextMountsBySpaceId } = state.mountsBySpaceId;
      const nextActiveSpaceId =
        state.activeSpaceId === spaceId ? INBOX_SPACE_ID : state.activeSpaceId;
      if (state.activeSpaceId === spaceId) {
        writePersistedActiveSpaceId(INBOX_SPACE_ID);
      }
      return {
        groupsById: nextGroupsById,
        profilesBySpaceId: nextProfilesBySpaceId,
        mountsBySpaceId: nextMountsBySpaceId,
        activeSpaceId: nextActiveSpaceId,
      };
    });
    if (wasActive) get().setActiveSpace(INBOX_SPACE_ID);
  },

  saveSpaceProfile: async (input) => {
    const generation = (profileSaveGeneration.get(input.spaceId) ?? 0) + 1;
    profileSaveGeneration.set(input.spaceId, generation);
    const existing = get().profilesBySpaceId[input.spaceId];
    const effectiveRootFolderId =
      input.rootFolderId.trim() ||
      existing?.rootFolderId ||
      (() => {
        const group =
          get().groupsById[input.spaceId] ?? groupCache.get(input.spaceId);
        return group ? inferLegacyRootFolderId(group) ?? '' : '';
      })();

    const saved = await upsertStudySpaceProfile({
      ...input,
      rootFolderId: effectiveRootFolderId,
    });
    if (removedSpaceIds.has(input.spaceId) || profileSaveGeneration.get(input.spaceId) !== generation) return saved;
    set((state) => ({
      profilesBySpaceId: {
        ...state.profilesBySpaceId,
        [saved.spaceId]: saved,
      },
    }));
    return saved;
  },

  mountItemToSpace: async (input) => {
    const created = await addSpaceMount(input);
    if (removedSpaceIds.has(input.spaceId)) return created;
    set((state) => {
      const current = state.mountsBySpaceId[created.spaceId] ?? [];
      const deduplicated = current.filter(
        (m) =>
          m.id !== created.id &&
          !(
            m.targetFolderId === created.targetFolderId &&
            m.itemType === created.itemType &&
            m.itemId === created.itemId
          ),
      );
      return {
        mountsBySpaceId: {
          ...state.mountsBySpaceId,
          [created.spaceId]: [...deduplicated, created],
        },
      };
    });
    return created;
  },

  unmountItemFromSpace: async (spaceId, input) => {
    await removeSpaceMount(input);
    if (removedSpaceIds.has(spaceId)) return;
    set((state) => {
      const nextMountsBySpaceId = { ...state.mountsBySpaceId };
      // Learning Hub may know only the mount ID before the spaces are hydrated.
      // Remove it from every known bucket rather than writing an empty-space bucket.
      for (const id of spaceId ? [spaceId] : Object.keys(nextMountsBySpaceId)) {
        nextMountsBySpaceId[id] = (nextMountsBySpaceId[id] ?? []).filter((mount) => {
          if (input.mountId && mount.id === input.mountId) return false;
          if (
            input.targetFolderId && input.itemType && input.itemId &&
            mount.targetFolderId === input.targetFolderId &&
            mount.itemType === input.itemType && mount.itemId === input.itemId
          ) return false;
          return true;
        });
      }
      return {
        mountsBySpaceId: nextMountsBySpaceId,
      };
    });
  },

  resetForTests: () => {
    hydrationGeneration += 1;
    removedSpaceIds.clear();
    profileSaveGeneration.clear();
    spaceRefreshGeneration.clear();
    groupCache.clear();
    writePersistedActiveSpaceId(INBOX_SPACE_ID);
    set({
      activeSpaceId: INBOX_SPACE_ID,
      viewFilter: 'all',
      groupsById: {},
      profilesBySpaceId: {},
      mountsBySpaceId: {},
      loading: false,
      stagedCreateProfileDraft: null,
    });
  },
}));

export function resetStudySpaceStoreForTests(): void {
  useStudySpaceStore.getState().resetForTests();
}
