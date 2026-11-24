import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { ChatSession } from '../../types/session';
import {
  __resetSessionListStoreForTests,
} from '../../stores/sessionListStore';
import {
  __resetHiddenDraftSessionTrackingForTests,
  buildHiddenDraftSessionMetadata,
  getDraftSessionScope,
  persistHiddenDraftSessionId,
  clearHiddenDraftSessionId,
} from '../draftSession';
import {
  LAST_ACTIVE_SESSION_KEY,
  clearLastActiveSessionId,
  clearLastActiveSessionIdIfMatches,
  isResumableSession,
  isResumableSessionId,
  persistLastActiveSessionId,
  readLastActiveSessionId,
  resolveStartupResumableSessionId,
} from '../lastActiveSession';
import {
  requestChatNewSession,
  requestChatSessionNavigation,
  resetChatNavigationHandshakeForTest,
} from '../../navigation/pendingChatNavigation';
import { sessionManager } from '../../core/session/sessionManager';
import {
  useSessionLifecycle,
  type UseSessionLifecycleDeps,
} from '../useSessionLifecycle';

const { invokeMock, createSessionWithDefaultsMock, notifyMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  createSessionWithDefaultsMock: vi.fn(),
  notifyMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('../../core/session/createSessionWithDefaults', () => ({
  createSessionWithDefaults: createSessionWithDefaultsMock,
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: notifyMock,
}));

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const id = overrides.id ?? 'sess_1';
  return {
    id,
    mode: 'chat',
    title: `Session ${id}`,
    persistStatus: 'active',
    createdAt: '2026-11-24T08:00:00.000Z',
    updatedAt: '2026-11-24T08:10:00.000Z',
    ...overrides,
  };
}

function makeDraftSession(id = 'sess_draft_1', groupId: string | null = null): ChatSession {
  const scope = getDraftSessionScope('chat', groupId);
  return makeSession({
    id,
    title: undefined,
    groupId: groupId ?? undefined,
    metadata: buildHiddenDraftSessionMetadata(null, scope),
  });
}

describe('lastActiveSession helpers', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetHiddenDraftSessionTrackingForTests();
  });

  afterEach(() => {
    localStorage.clear();
    __resetHiddenDraftSessionTrackingForTests();
  });

  it('persists real persisted sessions and rejects hidden drafts and subagents', () => {
    const scope = getDraftSessionScope('chat', null);
    persistHiddenDraftSessionId(scope, 'sess_draft_hidden');

    expect(isResumableSessionId('sess_real_1')).toBe(true);
    expect(isResumableSessionId('sess_draft_hidden')).toBe(false);
    expect(isResumableSessionId('agent_worker_1')).toBe(false);
    expect(isResumableSessionId('subagent_research_1')).toBe(false);
    expect(isResumableSessionId('demo-draft-123')).toBe(false);
    expect(isResumableSessionId('sess_sub', { mode: 'subagent' })).toBe(false);
    expect(isResumableSessionId('sess_sub_meta', { metadata: { is_subagent: true } })).toBe(false);
    expect(isResumableSessionId('sess_meta_draft', {
      metadata: buildHiddenDraftSessionMetadata(null, scope),
    })).toBe(false);

    expect(persistLastActiveSessionId('sess_real_1')).toBe(true);
    expect(readLastActiveSessionId()).toBe('sess_real_1');

    // Hidden drafts and subagents never clobber the stored real session
    expect(persistLastActiveSessionId('sess_draft_hidden')).toBe(false);
    expect(persistLastActiveSessionId('agent_worker_1')).toBe(false);
    expect(readLastActiveSessionId()).toBe('sess_real_1');

    // After promoting a hidden draft, it becomes resumable and persistable
    clearHiddenDraftSessionId(scope, 'sess_draft_hidden');
    expect(persistLastActiveSessionId('sess_draft_hidden')).toBe(true);
    expect(readLastActiveSessionId()).toBe('sess_draft_hidden');
  });

  it('resolves startup resumable session and cleans up deleted/archived/stale entries', () => {
    const active = makeSession({ id: 'sess_active' });
    const archived = makeSession({ id: 'sess_archived', persistStatus: 'archived' });
    const deleted = makeSession({ id: 'sess_deleted', persistStatus: 'deleted' });

    expect(isResumableSession(active)).toBe(true);
    expect(isResumableSession(archived)).toBe(false);
    expect(isResumableSession(deleted)).toBe(false);

    persistLastActiveSessionId('sess_active');
    expect(resolveStartupResumableSessionId([active, archived])).toBe('sess_active');

    // Archived session is rejected and cleaned up
    persistLastActiveSessionId('sess_archived');
    expect(resolveStartupResumableSessionId([active, archived])).toBeNull();
    expect(readLastActiveSessionId()).toBeNull();

    // Missing/deleted session is rejected and cleaned up
    persistLastActiveSessionId('sess_missing');
    expect(resolveStartupResumableSessionId([active])).toBeNull();
    expect(readLastActiveSessionId()).toBeNull();

    // clearLastActiveSessionIdIfMatches only clears when matching
    persistLastActiveSessionId('sess_keep');
    clearLastActiveSessionIdIfMatches('sess_other');
    expect(readLastActiveSessionId()).toBe('sess_keep');
    clearLastActiveSessionIdIfMatches('sess_keep');
    expect(readLastActiveSessionId()).toBeNull();
  });
});

describe('useSessionLifecycle auto-resume', () => {
  interface HarnessApi {
    lifecycle: ReturnType<typeof useSessionLifecycle>;
    currentSessionIdRef: React.MutableRefObject<string | null>;
    selectionEpochRef: React.MutableRefObject<number>;
    earlyNewSessionIntentRef: React.MutableRefObject<boolean>;
    sessionsRef: React.MutableRefObject<ChatSession[]>;
    setCurrentSessionId: ReturnType<typeof vi.fn>;
    setIsInitialLoading: ReturnType<typeof vi.fn>;
  }

  function renderLifecycle(options?: {
    initialSessions?: ChatSession[];
  }): HarnessApi {
    const currentSessionIdRef: React.MutableRefObject<string | null> = { current: null };
    const selectionEpochRef: React.MutableRefObject<number> = { current: 0 };
    const earlyNewSessionIntentRef: React.MutableRefObject<boolean> = { current: false };
    const sessionsRef: React.MutableRefObject<ChatSession[]> = {
      current: options?.initialSessions ?? [],
    };
    const setIsInitialLoading = vi.fn();

    const setCurrentSessionId = vi.fn(
      (idOrUpdater: string | null | ((prev: string | null) => string | null)) => {
        selectionEpochRef.current += 1;
        const nextId =
          typeof idOrUpdater === 'function'
            ? idOrUpdater(currentSessionIdRef.current)
            : idOrUpdater;
        currentSessionIdRef.current = nextId;
        sessionManager.setCurrentSessionId(nextId);
        if (nextId) {
          const listed = sessionsRef.current.find((s) => s.id === nextId);
          persistLastActiveSessionId(nextId, LAST_ACTIVE_SESSION_KEY, {
            mode: listed?.mode ?? null,
            metadata: listed?.metadata ?? null,
          });
        }
      },
    );

    const api: Partial<HarnessApi> = {
      currentSessionIdRef,
      selectionEpochRef,
      earlyNewSessionIntentRef,
      sessionsRef,
      setCurrentSessionId,
      setIsInitialLoading,
    };

    function Harness() {
      const deps: UseSessionLifecycleDeps = {
        currentSessionId: currentSessionIdRef.current,
        currentSessionIdRef,
        selectionEpochRef,
        earlyNewSessionIntentRef,
        setSessions: vi.fn((updater) => {
          sessionsRef.current =
            typeof updater === 'function' ? updater(sessionsRef.current) : updater;
        }),
        setCurrentSessionId,
        setIsLoading: vi.fn(),
        setTotalSessionCount: vi.fn(),
        setUngroupedSessionCount: vi.fn(),
        setIsInitialLoading,
        sessionsRef,
        t: ((key: string) => key) as unknown as TFunction,
        LAST_SESSION_KEY: LAST_ACTIVE_SESSION_KEY,
      };
      api.lifecycle = useSessionLifecycle(deps);
      return null;
    }

    render(<Harness />);
    return api as HarnessApi;
  }

  function mockSessionListIpc(ungrouped: ChatSession[], grouped: ChatSession[] = []) {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'chat_v2_list_sessions') {
        if (args?.groupId === '*') return grouped;
        return ungrouped;
      }
      if (command === 'chat_v2_list_groups') return [];
      if (command === 'chat_v2_count_sessions') {
        if (args?.groupId === '') return ungrouped.length;
        return ungrouped.length + grouped.length;
      }
      if (command === 'chat_v2_delete_session') return null;
      if (command === 'chat_v2_get_session') return null;
      return null;
    });
  }

  beforeEach(async () => {
    localStorage.clear();
    __resetSessionListStoreForTests();
    __resetHiddenDraftSessionTrackingForTests();
    resetChatNavigationHandshakeForTest();
    sessionManager.setCurrentSessionId(null);
    await sessionManager.destroyAll();
    invokeMock.mockReset();
    createSessionWithDefaultsMock.mockReset();
    notifyMock.mockReset();
  });

  afterEach(async () => {
    localStorage.clear();
    __resetSessionListStoreForTests();
    __resetHiddenDraftSessionTrackingForTests();
    resetChatNavigationHandshakeForTest();
    sessionManager.setCurrentSessionId(null);
    await sessionManager.destroyAll();
  });

  it('auto-resumes stored lastActiveSessionId when it exists in the loaded session list', async () => {
    const sess1 = makeSession({ id: 'sess_recent_1', title: 'Commute Notes' });
    const sess2 = makeSession({ id: 'sess_older_2', title: 'Old Topic' });
    persistLastActiveSessionId('sess_recent_1');
    mockSessionListIpc([sess1, sess2]);

    const api = renderLifecycle();
    await act(async () => {
      await api.lifecycle.loadSessions();
    });

    expect(api.setCurrentSessionId).toHaveBeenCalledWith('sess_recent_1');
    expect(api.currentSessionIdRef.current).toBe('sess_recent_1');
    expect(createSessionWithDefaultsMock).not.toHaveBeenCalled();
    expect(readLastActiveSessionId()).toBe('sess_recent_1');
    expect(api.setIsInitialLoading).toHaveBeenCalledWith(false);
  });

  it('falls back cleanly to a blank hidden draft when stored lastActiveSessionId no longer exists', async () => {
    const other = makeSession({ id: 'sess_other' });
    const draft = makeDraftSession('sess_draft_fallback');
    persistLastActiveSessionId('sess_deleted_before_reload');
    mockSessionListIpc([other]);
    createSessionWithDefaultsMock.mockResolvedValue(draft);

    const api = renderLifecycle();
    await act(async () => {
      await api.lifecycle.loadSessions();
    });

    expect(api.setCurrentSessionId).toHaveBeenCalledWith('sess_draft_fallback');
    expect(api.currentSessionIdRef.current).toBe('sess_draft_fallback');
    // Stale ID was cleaned up and the hidden draft ID was NOT persisted as last active session
    expect(readLastActiveSessionId()).toBeNull();
  });

  it('clears lastActiveSessionId on explicit New Session so a reload stays on blank draft', async () => {
    const active = makeSession({ id: 'sess_active_1' });
    const draft = makeDraftSession('sess_draft_new');
    persistLastActiveSessionId('sess_active_1');
    mockSessionListIpc([active]);
    createSessionWithDefaultsMock.mockResolvedValue(draft);

    const api = renderLifecycle({ initialSessions: [active] });
    await act(async () => {
      await api.lifecycle.createSession();
    });

    expect(api.currentSessionIdRef.current).toBe('sess_draft_new');
    expect(readLastActiveSessionId()).toBeNull();

    // Simulate reload: fresh lifecycle mount should open blank draft, NOT hijack back to sess_active_1
    __resetSessionListStoreForTests();
    sessionManager.setCurrentSessionId(null);
    const reloadedApi = renderLifecycle();
    // Reuse stored draft from chat_v2_get_session on reload
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'chat_v2_list_sessions') return args?.groupId === '*' ? [] : [active];
      if (command === 'chat_v2_list_groups') return [];
      if (command === 'chat_v2_count_sessions') return 1;
      if (command === 'chat_v2_get_session' && args?.sessionId === 'sess_draft_new') return draft;
      return null;
    });

    await act(async () => {
      await reloadedApi.lifecycle.loadSessions();
    });

    expect(reloadedApi.currentSessionIdRef.current).toBe('sess_draft_new');
    expect(readLastActiveSessionId()).toBeNull();
  });

  it('never overwrites a user-initiated session selection that happens while loadSessions is in flight', async () => {
    const stored = makeSession({ id: 'sess_stored' });
    const userPicked = makeSession({ id: 'sess_user_picked' });
    persistLastActiveSessionId('sess_stored');

    let resolveUngrouped!: (value: ChatSession[]) => void;
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === 'chat_v2_list_sessions') {
        if (args?.groupId === '*') return Promise.resolve([]);
        return new Promise<ChatSession[]>((resolve) => {
          resolveUngrouped = resolve;
        });
      }
      if (command === 'chat_v2_list_groups') return Promise.resolve([]);
      if (command === 'chat_v2_count_sessions') return Promise.resolve(2);
      return Promise.resolve(null);
    });

    const api = renderLifecycle({ initialSessions: [stored, userPicked] });
    const loadPromise = api.lifecycle.loadSessions();

    // User clicks another session before the async list load completes
    act(() => {
      api.setCurrentSessionId('sess_user_picked');
    });

    await act(async () => {
      resolveUngrouped([stored, userPicked]);
      await loadPromise;
    });

    expect(api.currentSessionIdRef.current).toBe('sess_user_picked');
    expect(api.setCurrentSessionId).toHaveBeenCalledTimes(1);
    expect(readLastActiveSessionId()).toBe('sess_user_picked');
  });

  it('never overwrites an explicit New Session click triggered while loadSessions is in flight', async () => {
    const stored = makeSession({ id: 'sess_stored' });
    const draft = makeDraftSession('sess_draft_clicked');
    persistLastActiveSessionId('sess_stored');
    createSessionWithDefaultsMock.mockResolvedValue(draft);

    let resolveUngrouped!: (value: ChatSession[]) => void;
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === 'chat_v2_list_sessions') {
        if (args?.groupId === '*') return Promise.resolve([]);
        return new Promise<ChatSession[]>((resolve) => {
          resolveUngrouped = resolve;
        });
      }
      if (command === 'chat_v2_list_groups') return Promise.resolve([]);
      if (command === 'chat_v2_count_sessions') return Promise.resolve(1);
      return Promise.resolve(null);
    });

    const api = renderLifecycle();
    const loadPromise = api.lifecycle.loadSessions();

    await act(async () => {
      await api.lifecycle.createSession();
    });

    await act(async () => {
      resolveUngrouped([stored]);
      await loadPromise;
    });

    expect(api.currentSessionIdRef.current).toBe('sess_draft_clicked');
    expect(readLastActiveSessionId()).toBeNull();
  });

  it('skips auto-resume when explicit new-session or session navigation intent is pending', async () => {
    const stored = makeSession({ id: 'sess_stored' });
    const draft = makeDraftSession('sess_draft_pending');
    persistLastActiveSessionId('sess_stored');
    mockSessionListIpc([stored]);
    createSessionWithDefaultsMock.mockResolvedValue(draft);

    // 1. Pending new-session handshake
    requestChatNewSession();
    const api1 = renderLifecycle();
    await act(async () => {
      await api1.lifecycle.loadSessions();
    });
    expect(api1.currentSessionIdRef.current).toBe('sess_draft_pending');
    expect(readLastActiveSessionId()).toBeNull();

    // 2. Pending target session navigation handshake (e.g., workshop / note origin)
    __resetSessionListStoreForTests();
    resetChatNavigationHandshakeForTest();
    persistLastActiveSessionId('sess_stored');
    requestChatSessionNavigation('sess_workshop_target');
    const api2 = renderLifecycle();
    await act(async () => {
      await api2.lifecycle.loadSessions();
    });
    // Does not auto-resume sess_stored while target navigation is pending
    expect(api2.currentSessionIdRef.current).not.toBe('sess_stored');

    // 3. Early CHAT_NEW_SESSION event during cold load (e.g., PREFILL_CHAT_INPUT newSession)
    __resetSessionListStoreForTests();
    resetChatNavigationHandshakeForTest();
    persistLastActiveSessionId('sess_stored');
    const api3 = renderLifecycle();
    api3.earlyNewSessionIntentRef.current = true;
    await act(async () => {
      await api3.lifecycle.loadSessions();
    });
    expect(api3.currentSessionIdRef.current).toBe('sess_draft_pending');
    expect(readLastActiveSessionId()).toBeNull();
  });

  it('preserves an external hidden draft that already has user-attached context/input', async () => {
    const stored = makeSession({ id: 'sess_stored' });
    const externalDraftId = 'sess_external_draft';
    const scope = getDraftSessionScope('chat', null);
    persistLastActiveSessionId('sess_stored');
    persistHiddenDraftSessionId(scope, externalDraftId);
    mockSessionListIpc([stored]);

    const draftStore = sessionManager.getOrCreate(externalDraftId);
    draftStore.setState({
      sessionMetadata: buildHiddenDraftSessionMetadata(null, scope),
      inputValue: 'Summarize this PDF excerpt',
    });
    sessionManager.setCurrentSessionId(externalDraftId);

    const api = renderLifecycle();
    await act(async () => {
      await api.lifecycle.loadSessions();
    });

    expect(api.currentSessionIdRef.current).toBe(externalDraftId);
  });

  it('clears lastActiveSessionId and falls back cleanly when deleting the only active session', async () => {
    const onlySession = makeSession({ id: 'sess_only' });
    const replacementDraft = makeDraftSession('sess_draft_after_delete');
    persistLastActiveSessionId('sess_only');
    mockSessionListIpc([onlySession]);
    createSessionWithDefaultsMock.mockResolvedValue(replacementDraft);

    const api = renderLifecycle({ initialSessions: [onlySession] });
    api.currentSessionIdRef.current = 'sess_only';

    await act(async () => {
      await api.lifecycle.deleteSession('sess_only');
    });

    await waitFor(() => {
      expect(api.currentSessionIdRef.current).toBe('sess_draft_after_delete');
    });
    expect(readLastActiveSessionId()).toBeNull();
  });

  it('recovers stored lastActiveSessionId via chat_v2_get_session when it is not in the first page list', async () => {
    const page1Session = makeSession({ id: 'sess_page_1', title: 'Page 1' });
    const olderStored = makeSession({ id: 'sess_older_active', title: 'Older Commute Session' });
    persistLastActiveSessionId('sess_older_active');

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'chat_v2_list_sessions') {
        if (args?.groupId === '*') return [];
        return [page1Session];
      }
      if (command === 'chat_v2_list_groups') return [];
      if (command === 'chat_v2_count_sessions') return 1;
      if (command === 'chat_v2_get_session' && args?.sessionId === 'sess_older_active') {
        return olderStored;
      }
      return null;
    });

    const api = renderLifecycle();
    await act(async () => {
      await api.lifecycle.loadSessions();
    });

    expect(api.currentSessionIdRef.current).toBe('sess_older_active');
    expect(readLastActiveSessionId()).toBe('sess_older_active');
    expect(api.sessionsRef.current.some((s) => s.id === 'sess_older_active')).toBe(true);
  });
});
