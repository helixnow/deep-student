import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setGroupsCache } from '@/features/chat/core/store/groupCache';
import type { SessionGroup } from '@/features/chat/types/group';
import { buildSendOptions } from '@/features/chat/adapters/tauri/sendOptions';
import type { TauriAdapterHost } from '@/features/chat/adapters/tauri/adapterHost';
import {
  INBOX_SPACE_ID,
  STUDY_SPACE_IPC_COMMANDS,
  type StudySpaceProfile,
} from '../types';
import { useStudySpaceStore } from '../store/studySpaceStore';
import {
  autoScopeSessionOnSwitch,
  getSessionKbScope,
  buildStudySpaceMemoryPromptBlock,
  resetAutoScopedSessionsForTests,
  setSessionKbScope,
  useSpaceAutoScope,
} from '../hooks/useSpaceAutoScope';
import { setKbScope } from '@/features/chat/kbScope/kbScope';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/dstu', () => ({
  folderApi: {
    getFolder: vi.fn(async (id: string) => ({
      ok: true,
      value: { id, title: `Folder ${id}` },
    })),
  },
}));

function makeSpaceGroup(id: string, name: string, rootFolderId: string): SessionGroup {
  return {
    id,
    name,
    systemPrompt: 'Base group prompt.',
    defaultSkillIds: [],
    pinnedResourceIds: [rootFolderId],
    rootFolderId,
    sortOrder: 0,
    persistStatus: 'active',
    createdAt: '2026-11-01T08:00:00Z',
    updatedAt: '2026-11-01T08:00:00Z',
  };
}

function makeMockAdapterHost(params: {
  sessionId: string;
  groupId: string | null;
  memoryEnabled: boolean;
}): TauriAdapterHost {
  const features = new Map<string, boolean>([
    ['userMemory', params.memoryEnabled],
    ['rag', false],
    ['webSearch', false],
    ['anki', false],
  ]);

  const state: any = {
    sessionId: params.sessionId,
    groupId: params.groupId,
    mode: 'chat',
    modeState: {},
    sessionMetadata: {},
    features,
    activeSkillIds: [],
    pendingContextRefs: [],
    pendingParallelModelIds: [],
    chatParams: {
      modelId: 'cfg_test_chat',
      model2OverrideId: '',
      temperature: 0.7,
      topP: 1,
      maxTokens: 2048,
      enableThinking: false,
      thinkingBudget: 0,
      contextLimit: 32000,
    },
  };

  return {
    sessionId: params.sessionId,
    getCurrentState: () => state,
    resolveInputContextLimit: () => 32000,
    getContextTruncateLimit: () => 32000,
    notifyContextTruncated: () => undefined,
    getStructuredSkillStateFromStore: () => null,
    collectMcpToolSchemas: async () => [],
    buildSystemPromptWithSkills: async (basePrompt?: string) => basePrompt,
  } as unknown as TauriAdapterHost;
}

describe('useSpaceAutoScope & sendOptions memory scoping', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
    resetAutoScopedSessionsForTests();
    useStudySpaceStore.getState().resetForTests();
  });

  it('preserves explicit empty/all/none/folders scopes without relying on local auto-scope history', async () => {
    const group = makeSpaceGroup('grp_scopes', 'Scopes', 'fld_scopes');
    useStudySpaceStore.getState().upsertGroupInState(group);
    for (const scope of [[], { mode: 'none' }, { mode: 'folders', folderIds: [] }, ['fld_custom']]) {
      invokeMock.mockResolvedValueOnce(scope);
      expect(await autoScopeSessionOnSwitch('sess_manual_scope', group.id)).toBe(false);
    }
    expect(invokeMock.mock.calls.every(([cmd]) => cmd === 'chat_v2_get_rag_scope')).toBe(true);
  });

  it('initializes a genuinely new session when the real sidebar create callback returns void', async () => {
    const group = makeSpaceGroup('grp_void', 'Void', 'fld_void');
    useStudySpaceStore.getState().upsertGroupInState(group);
    useStudySpaceStore.getState().setActiveSpace(group.id);
    invokeMock.mockResolvedValue([]);
    const createSession = vi.fn(async () => undefined);
    const existing = { id: 'sess_existing_void', groupId: group.id };
    const { result, rerender } = renderHook(({ session }) => useSpaceAutoScope({
      currentSessionId: session.id, currentSession: session, createSession,
      sessions: [existing, session],
    }), { initialProps: { session: existing } });
    await act(async () => { await result.current.createScopedSession(); });
    rerender({ session: { id: 'sess_new_void', groupId: group.id } });
    await act(async () => undefined);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'chat_v2_set_rag_scope')).toEqual([
      ['chat_v2_set_rag_scope', { sessionId: 'sess_new_void', folderIds: ['fld_void'] }],
    ]);
  });

  it('does not overwrite a scope when the read fails', async () => {
    useStudySpaceStore.getState().upsertGroupInState(makeSpaceGroup('grp_read_error', 'Error', 'fld_error'));
    invokeMock.mockRejectedValueOnce(new Error('Disconnected'));
    expect(await autoScopeSessionOnSwitch('sess_read_error', 'grp_read_error')).toBe(false);
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it('does not overwrite a manual choice made while the automatic scope read is in flight', async () => {
    useStudySpaceStore.getState().upsertGroupInState(makeSpaceGroup('grp_manual_race', 'Race', 'fld_race'));
    let resolveRead!: (value: null) => void;
    invokeMock.mockImplementation((cmd: string) => cmd === 'chat_v2_get_rag_scope'
      ? new Promise<null>((resolve) => { resolveRead = resolve; }) : Promise.resolve(null));
    const pending = autoScopeSessionOnSwitch('sess_manual_race', 'grp_manual_race');
    await setKbScope('sess_manual_race', []);
    resolveRead(null);
    expect(await pending).toBe(false);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'chat_v2_set_rag_scope')).toEqual([
      ['chat_v2_set_rag_scope', { sessionId: 'sess_manual_race', folderIds: [] }],
    ]);
  });

  it('cancels stale automatic writes when switching sessions or entering Inbox', async () => {
    const group = makeSpaceGroup('grp_switch', 'Switch', 'fld_switch');
    useStudySpaceStore.getState().upsertGroupInState(group);
    let resolveRead!: (value: null) => void;
    invokeMock.mockImplementation((cmd: string) => cmd === 'chat_v2_get_rag_scope'
      ? new Promise<null>((resolve) => { resolveRead = resolve; }) : Promise.resolve(null));
    const createSession = vi.fn();
    const { rerender } = renderHook(({ id, groupId }) => useSpaceAutoScope({
      currentSessionId: id, currentSession: { id, groupId }, createSession,
    }), { initialProps: { id: 'sess_switch_a', groupId: group.id as string | null } });
    rerender({ id: 'sess_inbox_switch', groupId: null });
    await act(async () => { resolveRead(null); });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'chat_v2_set_rag_scope')).toEqual([]);
    expect(await autoScopeSessionOnSwitch('sess_inbox', 'fld_inbox')).toBe(false);
  });

  it('deduplicates simultaneous automatic initialization and recognizes explicit none', async () => {
    useStudySpaceStore.getState().upsertGroupInState(makeSpaceGroup('grp_double', 'Double', 'fld_double'));
    invokeMock.mockResolvedValue(null);
    const results = await Promise.all([
      autoScopeSessionOnSwitch('sess_double', 'grp_double'),
      autoScopeSessionOnSwitch('sess_double', 'grp_double'),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'chat_v2_set_rag_scope')).toHaveLength(1);
    invokeMock.mockResolvedValueOnce({ mode: 'none' });
    expect(await getSessionKbScope('sess_none_descriptor')).toEqual({ mode: 'none', folderIds: [] });
  });

  it('creates a session in the active Study Space with groupId = spaceId and scopes KB to rootFolderId, while Inbox leaves RAG unscoped', async () => {
    const physicsGroup = makeSpaceGroup('grp_physics', 'Physics I', 'fld_physics_101');

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listProfiles) return [];
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listMounts) return [];
      if (cmd === 'chat_v2_set_rag_scope') return null;
      if (cmd === 'chat_v2_get_rag_scope') return null;
      return null;
    });

    await useStudySpaceStore.getState().hydrateFromGroups([physicsGroup]);
    useStudySpaceStore.getState().setActiveSpace('grp_physics');

    const createSessionMock = vi.fn(async (groupId?: string) => ({
      id: groupId ? 'sess_in_physics' : 'sess_in_inbox',
      groupId: groupId ?? null,
    }));

    const { result } = renderHook(() =>
      useSpaceAutoScope({
        currentSessionId: null,
        currentSession: null,
        groups: [physicsGroup],
        createSession: createSessionMock,
      }),
    );

    await act(async () => {
      await result.current.createScopedSession();
    });

    expect(createSessionMock).toHaveBeenCalledWith('grp_physics');
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_set_rag_scope', {
      sessionId: 'sess_in_physics',
      folderIds: ['fld_physics_101'],
    });

    // Switch to Inbox: creating a session passes undefined groupId and does NOT restrict RAG scope
    invokeMock.mockClear();
    createSessionMock.mockClear();
    useStudySpaceStore.getState().setActiveSpace(INBOX_SPACE_ID);

    await act(async () => {
      await result.current.createScopedSession();
    });

    expect(createSessionMock).toHaveBeenCalledWith(undefined);
    expect(invokeMock).not.toHaveBeenCalledWith(
      'chat_v2_set_rag_scope',
      expect.anything(),
    );
  });

  it('does NOT overwrite an existing user-configured KbScope (custom folders or explicit mode: all) when switching sessions', async () => {
    const physicsGroup = makeSpaceGroup('grp_physics', 'Physics I', 'fld_physics_101');

    const persistedScopes = new Map<string, unknown>([
      ['sess_custom_folders', ['fld_user_picked_a', 'fld_user_picked_b']],
      ['sess_explicit_all_obj', { mode: 'all' }],
      ['sess_untouched', null],
    ]);

    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listProfiles) return [];
      if (cmd === STUDY_SPACE_IPC_COMMANDS.listMounts) return [];
      if (cmd === 'chat_v2_get_rag_scope') {
        const sid = String(args?.sessionId ?? '');
        return persistedScopes.has(sid) ? persistedScopes.get(sid) : null;
      }
      if (cmd === 'chat_v2_set_rag_scope') {
        const sid = String(args?.sessionId ?? '');
        persistedScopes.set(sid, args?.folderIds ?? []);
        return null;
      }
      return null;
    });

    await useStudySpaceStore.getState().hydrateFromGroups([physicsGroup]);

    // 1. Session with custom folders is NOT overwritten
    const changedCustom = await autoScopeSessionOnSwitch('sess_custom_folders', 'grp_physics');
    expect(changedCustom).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith(
      'chat_v2_set_rag_scope',
      expect.objectContaining({ sessionId: 'sess_custom_folders' }),
    );

    // 2. Session with explicit { mode: 'all' } (or previously auto-scoped then cleared to []) is NOT overwritten
    const changedAllObj = await autoScopeSessionOnSwitch('sess_explicit_all_obj', 'grp_physics');
    expect(changedAllObj).toBe(false);

    await setSessionKbScope('sess_cleared_to_all', { mode: 'all' });
    persistedScopes.set('sess_cleared_to_all', []);
    invokeMock.mockClear();

    const changedCleared = await autoScopeSessionOnSwitch('sess_cleared_to_all', 'grp_physics');
    expect(changedCleared).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith(
      'chat_v2_set_rag_scope',
      expect.objectContaining({ sessionId: 'sess_cleared_to_all' }),
    );

    // 3. Brand-new untouched session IS auto-scoped to [space.rootFolderId]
    const changedUntouched = await autoScopeSessionOnSwitch('sess_untouched', 'grp_physics');
    expect(changedUntouched).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_set_rag_scope', {
      sessionId: 'sess_untouched',
      folderIds: ['fld_physics_101'],
    });
  });

  it('injects deterministic memory folder instructions in sendOptions according to memoryScope', async () => {
    const mathGroup = makeSpaceGroup('grp_math', 'Linear Algebra', 'fld_math_root');
    setGroupsCache([mathGroup]);

    const makeProfile = (
      memoryScope: StudySpaceProfile['memoryScope'],
    ): StudySpaceProfile => ({
      spaceId: 'grp_math',
      rootFolderId: 'fld_math_root',
      examDate: null,
      dailyBudgetMinutes: 45,
      targetRetention: 0.9,
      workbenchLayoutPreset: 'split_reader_chat',
      defaultDeckId: null,
      memoryScope,
      createdAt: '2026-11-01T08:00:00Z',
      updatedAt: '2026-11-01T08:00:00Z',
    });

    // Direct helper unit assertions
    expect(buildStudySpaceMemoryPromptBlock('space_isolated', 'Linear Algebra')).toBe(
      '[Study Space Memory Scope: Isolated | folderPath="Spaces/Linear Algebra"] Read and write study memories strictly under folderPath "Spaces/Linear Algebra". Do not mix unrelated spaces.',
    );
    expect(buildStudySpaceMemoryPromptBlock('space_and_global', 'Linear Algebra')).toBe(
      '[Study Space Memory Scope: Space + Global | preferredFolderPath="Spaces/Linear Algebra"] Prefer folderPath "Spaces/Linear Algebra" for subject-specific notes while consulting global learner profile preferences.',
    );
    expect(buildStudySpaceMemoryPromptBlock('global_only', 'Linear Algebra')).toBeNull();

    // Full buildSendOptions integration for all 3 memoryScope policies
    useStudySpaceStore.setState({
      groupsById: { grp_math: mathGroup },
      profilesBySpaceId: { grp_math: makeProfile('space_isolated') },
    });
    const isolatedOpts = await buildSendOptions(
      makeMockAdapterHost({
        sessionId: 'sess_1',
        groupId: 'grp_math',
        memoryEnabled: true,
      }),
    );
    expect(isolatedOpts.systemPromptOverride).toContain('Base group prompt.');
    expect(isolatedOpts.systemPromptOverride).toContain(
      '[Study Space Memory Scope: Isolated | folderPath="Spaces/Linear Algebra"]',
    );

    useStudySpaceStore.setState({
      profilesBySpaceId: { grp_math: makeProfile('space_and_global') },
    });
    const preferredOpts = await buildSendOptions(
      makeMockAdapterHost({
        sessionId: 'sess_1',
        groupId: 'grp_math',
        memoryEnabled: true,
      }),
    );
    expect(preferredOpts.systemPromptOverride).toContain(
      '[Study Space Memory Scope: Space + Global | preferredFolderPath="Spaces/Linear Algebra"]',
    );

    useStudySpaceStore.setState({
      profilesBySpaceId: { grp_math: makeProfile('global_only') },
    });
    const globalOnlyOpts = await buildSendOptions(
      makeMockAdapterHost({
        sessionId: 'sess_1',
        groupId: 'grp_math',
        memoryEnabled: true,
      }),
    );
    expect(globalOnlyOpts.systemPromptOverride).toBe('Base group prompt.');
    expect(globalOnlyOpts.systemPromptOverride).not.toContain('Study Space Memory Scope');
  });
});
