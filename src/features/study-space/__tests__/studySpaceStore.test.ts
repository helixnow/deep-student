import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionGroup } from '@/features/chat/types/group';
import { groupCache } from '@/features/chat/core/store/groupCache';
import {
  INBOX_FOLDER_ID,
  INBOX_SPACE_FILTER_KEY,
  INBOX_SPACE_ID,
  STUDY_SPACE_CHANGED_EVENT,
  STUDY_SPACE_DEFAULTS,
  STUDY_SPACE_IPC_COMMANDS,
  inferLegacyRootFolderId,
  type StudySpaceChangedEventDetail,
  type StudySpaceMount,
  type StudySpaceProfile,
} from '../types';
import {
  ACTIVE_STUDY_SPACE_STORAGE_KEY,
  useStudySpaceStore,
} from '../store/studySpaceStore';
import { computeSpaceCountdown } from '../utils/spaceCountdown';
import { synthesizeDefaultProfile, upsertStudySpaceProfile, addSpaceMount } from '../api/studySpaceApi';
import { useActiveStudySpace } from '../hooks/useActiveStudySpace';
import { renderHook } from '@testing-library/react';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

function makeGroup(overrides: Partial<SessionGroup> & { id: string; name: string }): SessionGroup {
  return {
    id: overrides.id,
    name: overrides.name,
    description: overrides.description,
    icon: overrides.icon,
    color: overrides.color,
    systemPrompt: overrides.systemPrompt,
    defaultSkillIds: overrides.defaultSkillIds ?? [],
    pinnedResourceIds: overrides.pinnedResourceIds ?? [],
    rootFolderId: overrides.rootFolderId,
    defaultRuntimeRootId: overrides.defaultRuntimeRootId ?? null,
    preferredProjectRootPath: overrides.preferredProjectRootPath ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    persistStatus: overrides.persistStatus ?? 'active',
    createdAt: overrides.createdAt ?? '2026-11-01T08:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-11-01T08:00:00Z',
  };
}

describe('studySpaceStore', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
    useStudySpaceStore.getState().resetForTests();
  });

  it('keeps local profile saves and mounts when an older hydration finishes later', async () => {
    const group = makeGroup({ id: 'grp_race', name: 'Race', rootFolderId: 'fld_race' });
    const profileRead = deferred<StudySpaceProfile[]>();
    const mountRead = deferred<StudySpaceMount[]>();
    const saved = { ...synthesizeDefaultProfile(group), dailyBudgetMinutes: 95 };
    const mount: StudySpaceMount = { id: 'mnt_new', spaceId: group.id, targetFolderId: 'fld_race', itemType: 'note', itemId: 'note_new', createdAt: '2026-11-11' };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listProfiles) return profileRead.promise;
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listMounts) return mountRead.promise;
      if (cmd === STUDY_SPACE_IPC_COMMANDS.upsertProfile) return Promise.resolve(saved);
      if (cmd === STUDY_SPACE_IPC_COMMANDS.addMount) return Promise.resolve(mount);
    });
    const hydration = useStudySpaceStore.getState().hydrateFromGroups([group]);
    await useStudySpaceStore.getState().saveSpaceProfile({ spaceId: group.id, rootFolderId: 'fld_race', dailyBudgetMinutes: 95 });
    await useStudySpaceStore.getState().mountItemToSpace(mount);
    profileRead.resolve([synthesizeDefaultProfile(group)]);
    mountRead.resolve([]);
    await hydration;
    expect(useStudySpaceStore.getState().getStudySpace(group.id)).toMatchObject({ dailyBudgetMinutes: 95, mountedResourceIds: ['note_new'] });
  });

  it('does not resurrect deleted groups from hydration, stale cache, or late writes and broadcasts Inbox fallback', async () => {
    const group = makeGroup({ id: 'grp_deleted', name: 'Deleted', rootFolderId: 'fld_deleted' });
    const read = deferred<StudySpaceProfile[]>();
    const save = deferred<StudySpaceProfile>();
    const mountWrite = deferred<StudySpaceMount>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listProfiles) return read.promise;
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listMounts) return Promise.resolve([]);
      if (cmd === STUDY_SPACE_IPC_COMMANDS.upsertProfile) return save.promise;
      if (cmd === STUDY_SPACE_IPC_COMMANDS.addMount) return mountWrite.promise;
    });
    const hydration = useStudySpaceStore.getState().hydrateFromGroups([group]);
    useStudySpaceStore.getState().setActiveSpace(group.id);
    const saving = useStudySpaceStore.getState().saveSpaceProfile({ spaceId: group.id, rootFolderId: 'fld_deleted' });
    const mounting = useStudySpaceStore.getState().mountItemToSpace({ spaceId: group.id, targetFolderId: 'fld_deleted', itemType: 'note', itemId: 'note_old' });
    const listener = vi.fn();
    window.addEventListener(STUDY_SPACE_CHANGED_EVENT, listener);
    useStudySpaceStore.getState().removeGroupFromState(group.id);
    read.resolve([synthesizeDefaultProfile(group)]);
    save.resolve(synthesizeDefaultProfile(group));
    mountWrite.resolve({ id: 'mnt_late', spaceId: group.id, targetFolderId: 'fld_deleted', itemType: 'note', itemId: 'note_old', createdAt: '2026-11-11' });
    await Promise.all([hydration, saving, mounting]);
    window.removeEventListener(STUDY_SPACE_CHANGED_EVENT, listener);
    expect(useStudySpaceStore.getState().activeSpaceId).toBe(INBOX_SPACE_ID);
    expect(useStudySpaceStore.getState().getStudySpace(group.id, group)).toBeNull();
    expect(groupCache.has(group.id)).toBe(false);
    expect(useStudySpaceStore.getState().profilesBySpaceId[group.id]).toBeUndefined();
    expect(useStudySpaceStore.getState().mountsBySpaceId[group.id]).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail.rootFolderId).toBe(INBOX_FOLDER_ID);
  });

  it('keeps the latest hydration and falls back when the active group is archived', async () => {
    const old = makeGroup({ id: 'grp_old', name: 'Old' });
    const next = makeGroup({ id: 'grp_next', name: 'Next' });
    const read = deferred<StudySpaceProfile[]>();
    invokeMock.mockImplementation((cmd: string) => cmd === STUDY_SPACE_IPC_COMMANDS.listProfiles ? read.promise : Promise.resolve([]));
    const pending = useStudySpaceStore.getState().hydrateFromGroups([old]);
    useStudySpaceStore.getState().setActiveSpace(old.id);
    invokeMock.mockImplementation(async () => []);
    await useStudySpaceStore.getState().hydrateFromGroups([next, { ...old, persistStatus: 'archived' }]);
    read.resolve([synthesizeDefaultProfile(old)]);
    await pending;
    expect(Object.keys(useStudySpaceStore.getState().groupsById)).toEqual([next.id]);
    expect(useStudySpaceStore.getState().activeSpaceId).toBe(INBOX_SPACE_ID);
    expect(useStudySpaceStore.getState().loading).toBe(false);
  });

  it('keeps a newer profile save when responses complete out of order', async () => {
    const group = makeGroup({ id: 'grp_save', name: 'Save', rootFolderId: 'fld_save' });
    useStudySpaceStore.getState().upsertGroupInState(group);
    const first = deferred<StudySpaceProfile>();
    const second = deferred<StudySpaceProfile>();
    invokeMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const saveA = useStudySpaceStore.getState().saveSpaceProfile({ spaceId: group.id, rootFolderId: 'fld_save', dailyBudgetMinutes: 60 });
    const saveB = useStudySpaceStore.getState().saveSpaceProfile({ spaceId: group.id, rootFolderId: 'fld_save', dailyBudgetMinutes: 90 });
    second.resolve({ ...synthesizeDefaultProfile(group), dailyBudgetMinutes: 90 });
    await saveB;
    first.resolve({ ...synthesizeDefaultProfile(group), dailyBudgetMinutes: 60 });
    await saveA;
    expect(useStudySpaceStore.getState().getStudySpace(group.id)?.dailyBudgetMinutes).toBe(90);
  });

  it('protects edits and unmounts from the group editor stale profile read', async () => {
    const group = makeGroup({ id: 'grp_editor', name: 'Editor', rootFolderId: 'fld_editor' });
    useStudySpaceStore.getState().upsertGroupInState(group);
    const mount: StudySpaceMount = { id: 'mnt_editor', spaceId: group.id, targetFolderId: 'fld_editor', itemType: 'note', itemId: 'note_editor', createdAt: '2026-11-11' };
    useStudySpaceStore.setState({ mountsBySpaceId: { [group.id]: [mount] } });
    const profileRead = deferred<StudySpaceProfile>();
    const mountRead = deferred<StudySpaceMount[]>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === STUDY_SPACE_IPC_COMMANDS.getProfile) return profileRead.promise;
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listMounts) return mountRead.promise;
      if (cmd === STUDY_SPACE_IPC_COMMANDS.upsertProfile) return Promise.resolve({ ...synthesizeDefaultProfile(group), dailyBudgetMinutes: 100 });
      return Promise.resolve(true);
    });
    const refreshing = useStudySpaceStore.getState().refreshStudySpace(group.id, group);
    await useStudySpaceStore.getState().saveSpaceProfile({ spaceId: group.id, rootFolderId: 'fld_editor', dailyBudgetMinutes: 100 });
    await useStudySpaceStore.getState().unmountItemFromSpace('', { mountId: mount.id });
    profileRead.resolve(synthesizeDefaultProfile(group));
    mountRead.resolve([mount]);
    expect(await refreshing).toMatchObject({ dailyBudgetMinutes: 100, mountedResourceIds: [] });
    expect(useStudySpaceStore.getState().mountsBySpaceId['']).toBeUndefined();
  });

  it('respects an explicitly empty external group list', () => {
    useStudySpaceStore.getState().upsertGroupInState(makeGroup({ id: 'grp_stale', name: 'Stale' }));
    const { result } = renderHook(() => useActiveStudySpace([]));
    expect(result.current.spaces).toEqual([]);
  });

  it('preserves omitted profile fields, uses camelCase IPC keys, and reports failed writes instead of fake saves', async () => {
    const group = makeGroup({ id: 'grp_api', name: 'API', rootFolderId: 'fld_api' });
    invokeMock.mockResolvedValueOnce(synthesizeDefaultProfile(group));
    await upsertStudySpaceProfile({ spaceId: group.id, rootFolderId: 'fld_api', dailyBudgetMinutes: 60 });
    expect(invokeMock).toHaveBeenCalledWith(STUDY_SPACE_IPC_COMMANDS.upsertProfile, { input: expect.objectContaining({ spaceId: group.id, rootFolderId: 'fld_api', examDate: undefined, defaultDeckId: undefined }) });
    invokeMock.mockRejectedValueOnce({ code: 'IPC_UNAVAILABLE', message: 'Host disconnected' });
    await expect(upsertStudySpaceProfile({ spaceId: group.id, rootFolderId: 'fld_api' })).rejects.toThrow('Host disconnected');
    invokeMock.mockRejectedValueOnce({ message: 'Mount would create an ancestor cycle' });
    await expect(addSpaceMount({ spaceId: group.id, targetFolderId: 'fld_api', itemType: 'folder', itemId: 'fld_parent' })).rejects.toThrow('Mount would create an ancestor cycle');
    expect(invokeMock).toHaveBeenLastCalledWith(STUDY_SPACE_IPC_COMMANDS.addMount, { input: { spaceId: group.id, targetFolderId: 'fld_api', itemType: 'folder', itemId: 'fld_parent' } });
    invokeMock.mockResolvedValueOnce(undefined);
    await expect(addSpaceMount({ spaceId: group.id, targetFolderId: 'fld_api', itemType: 'note', itemId: 'note_missing' })).rejects.toThrow('Space mount was not returned');
  });

  it('hydrates StudySpace list from SessionGroup[], profiles, and mounts while synthesizing defaults for legacy groups', async () => {
    const physicsGroup = makeGroup({
      id: 'grp_physics',
      name: 'College Physics',
      color: '#3b82f6',
      rootFolderId: 'fld_physics_root',
      pinnedResourceIds: ['fld_physics_root'],
      sortOrder: 0,
    });
    const legacyMathGroup = makeGroup({
      id: 'grp_math',
      name: 'Calculus II',
      pinnedResourceIds: ['res_syllabus', 'fld_math_legacy', 'fld_secondary'],
      sortOrder: 1,
    });

    const persistedPhysicsProfile: StudySpaceProfile = {
      spaceId: 'grp_physics',
      rootFolderId: 'fld_physics_root',
      examDate: '2026-12-20',
      dailyBudgetMinutes: 90,
      targetRetention: 0.93,
      workbenchLayoutPreset: 'practice_review',
      defaultDeckId: 'Physics::Electromagnetism',
      memoryScope: 'space_isolated',
      createdAt: '2026-11-01T08:00:00Z',
      updatedAt: '2026-11-05T10:00:00Z',
    };

    const mounts: StudySpaceMount[] = [
      {
        id: 'mnt_calc_ref_1',
        spaceId: 'grp_physics',
        targetFolderId: 'fld_physics_root',
        itemType: 'file',
        itemId: 'file_calculus_book',
        createdAt: '2026-11-06T09:00:00Z',
      },
      {
        id: 'mnt_formula_note',
        spaceId: 'grp_physics',
        targetFolderId: 'fld_physics_root',
        itemType: 'note',
        itemId: 'note_vector_identities',
        createdAt: '2026-11-06T09:05:00Z',
      },
    ];

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listProfiles) {
        return [persistedPhysicsProfile];
      }
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listMounts) {
        return mounts;
      }
      return null;
    });

    await useStudySpaceStore.getState().hydrateFromGroups([physicsGroup, legacyMathGroup]);

    const physicsSpace = useStudySpaceStore.getState().getStudySpace('grp_physics');
    expect(physicsSpace).not.toBeNull();
    expect(physicsSpace?.spaceId).toBe('grp_physics');
    expect(physicsSpace?.rootFolderId).toBe('fld_physics_root');
    expect(physicsSpace?.examDate).toBe('2026-12-20');
    expect(physicsSpace?.dailyBudgetMinutes).toBe(90);
    expect(physicsSpace?.targetRetention).toBe(0.93);
    expect(physicsSpace?.workbenchLayoutPreset).toBe('practice_review');
    expect(physicsSpace?.defaultDeckId).toBe('Physics::Electromagnetism');
    expect(physicsSpace?.memoryScope).toBe('space_isolated');
    expect(physicsSpace?.mountedResourceIds).toEqual([
      'file_calculus_book',
      'note_vector_identities',
    ]);
    expect(physicsSpace?.mounts).toHaveLength(2);

    // Legacy group without persisted profile synthesizes STUDY_SPACE_DEFAULTS + inferLegacyRootFolderId
    expect(inferLegacyRootFolderId(legacyMathGroup)).toBe('fld_math_legacy');
    const mathSpace = useStudySpaceStore.getState().getStudySpace('grp_math');
    expect(mathSpace).not.toBeNull();
    expect(mathSpace?.spaceId).toBe('grp_math');
    expect(mathSpace?.rootFolderId).toBe('fld_math_legacy');
    expect(mathSpace?.examDate).toBeNull();
    expect(mathSpace?.dailyBudgetMinutes).toBe(STUDY_SPACE_DEFAULTS.dailyBudgetMinutes);
    expect(mathSpace?.targetRetention).toBe(STUDY_SPACE_DEFAULTS.targetRetention);
    expect(mathSpace?.workbenchLayoutPreset).toBe(STUDY_SPACE_DEFAULTS.workbenchLayoutPreset);
    expect(mathSpace?.memoryScope).toBe(STUDY_SPACE_DEFAULTS.memoryScope);
    expect(mathSpace?.mountedResourceIds).toEqual([]);

    expect(groupCache.get('grp_physics')?.name).toBe('College Physics');
    expect(groupCache.get('grp_math')?.name).toBe('Calculus II');
  });

  it('persists activeSpaceId transitions between INBOX_SPACE_ID and grp_physics and emits STUDY_SPACE_CHANGED_EVENT', async () => {
    const physicsGroup = makeGroup({
      id: 'grp_physics',
      name: 'College Physics',
      rootFolderId: 'fld_physics_root',
    });

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listProfiles) {
        return [
          {
            spaceId: 'grp_physics',
            rootFolderId: 'fld_physics_root',
            examDate: '2026-11-26',
            dailyBudgetMinutes: 60,
            targetRetention: 0.92,
            workbenchLayoutPreset: 'split_reader_chat',
            defaultDeckId: 'Physics::Core',
            memoryScope: 'space_isolated',
            createdAt: '2026-11-01T08:00:00Z',
            updatedAt: '2026-11-01T08:00:00Z',
          } satisfies StudySpaceProfile,
        ];
      }
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listMounts) {
        return [];
      }
      return null;
    });

    await useStudySpaceStore.getState().hydrateFromGroups([physicsGroup]);

    const events: StudySpaceChangedEventDetail[] = [];
    const listener = (event: Event) => {
      events.push((event as CustomEvent<StudySpaceChangedEventDetail>).detail);
    };
    window.addEventListener(STUDY_SPACE_CHANGED_EVENT, listener);

    try {
      expect(useStudySpaceStore.getState().activeSpaceId).toBe(INBOX_SPACE_ID);

      useStudySpaceStore.getState().setActiveSpace('grp_physics');
      expect(useStudySpaceStore.getState().activeSpaceId).toBe('grp_physics');
      expect(localStorage.getItem(ACTIVE_STUDY_SPACE_STORAGE_KEY)).toBe('grp_physics');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        spaceId: 'grp_physics',
        rootFolderId: 'fld_physics_root',
        defaultDeckId: 'Physics::Core',
        targetRetention: 0.92,
        memoryScope: 'space_isolated',
        workbenchLayoutPreset: 'split_reader_chat',
      });

      useStudySpaceStore.getState().setActiveSpace(INBOX_SPACE_ID);
      expect(useStudySpaceStore.getState().activeSpaceId).toBe(INBOX_SPACE_ID);
      expect(localStorage.getItem(ACTIVE_STUDY_SPACE_STORAGE_KEY)).toBe(INBOX_SPACE_FILTER_KEY);
      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({
        spaceId: INBOX_SPACE_ID,
        rootFolderId: INBOX_FOLDER_ID,
        defaultDeckId: null,
        targetRetention: STUDY_SPACE_DEFAULTS.targetRetention,
        memoryScope: STUDY_SPACE_DEFAULTS.memoryScope,
        workbenchLayoutPreset: STUDY_SPACE_DEFAULTS.workbenchLayoutPreset,
      });
    } finally {
      window.removeEventListener(STUDY_SPACE_CHANGED_EVENT, listener);
    }
  });

  it('supports mounting and unmounting cross-space items and computes exam countdown labels accurately', async () => {
    const physicsGroup = makeGroup({
      id: 'grp_physics',
      name: 'College Physics',
      rootFolderId: 'fld_physics_root',
    });

    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listProfiles) return [];
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listMounts) return [];
      if (cmd === STUDY_SPACE_IPC_COMMANDS.addMount) {
        const input = args?.input as {
          spaceId: string;
          targetFolderId: string;
          itemType: 'note';
          itemId: string;
        };
        return {
          id: 'mnt_added_1',
          spaceId: input.spaceId,
          targetFolderId: input.targetFolderId,
          itemType: input.itemType,
          itemId: input.itemId,
          createdAt: '2026-11-11T10:00:00Z',
        } satisfies StudySpaceMount;
      }
      if (cmd === STUDY_SPACE_IPC_COMMANDS.removeMount) {
        return true;
      }
      return null;
    });

    await useStudySpaceStore.getState().hydrateFromGroups([physicsGroup]);

    const mount = await useStudySpaceStore.getState().mountItemToSpace({
      spaceId: 'grp_physics',
      targetFolderId: 'fld_physics_root',
      itemType: 'note',
      itemId: 'note_calc_theorem',
    });
    expect(mount.id).toBe('mnt_added_1');
    expect(useStudySpaceStore.getState().getStudySpace('grp_physics')?.mountedResourceIds).toEqual([
      'note_calc_theorem',
    ]);

    await useStudySpaceStore.getState().unmountItemFromSpace('grp_physics', {
      mountId: 'mnt_added_1',
    });
    expect(useStudySpaceStore.getState().getStudySpace('grp_physics')?.mountedResourceIds).toEqual([]);

    const refNow = new Date(2026, 10, 11, 14, 30, 0);
    expect(computeSpaceCountdown('2026-11-26', refNow)).toMatchObject({
      daysDiff: 15,
      kind: 'future',
      urgency: 'soon',
      label: 'D-15',
      dotColorClass: 'bg-amber-500',
    });
    expect(computeSpaceCountdown('2026-11-11', refNow)).toMatchObject({
      daysDiff: 0,
      kind: 'today',
      urgency: 'urgent',
      label: 'D-Day',
      dotColorClass: 'bg-rose-500',
    });
    expect(computeSpaceCountdown('2026-11-08', refNow)).toMatchObject({
      daysDiff: -3,
      kind: 'passed',
      label: 'D+3',
    });
  });
});
