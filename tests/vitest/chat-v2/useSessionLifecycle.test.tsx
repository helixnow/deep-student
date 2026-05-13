import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionLifecycle, type UseSessionLifecycleDeps } from '@/features/chat/pages/useSessionLifecycle';
import type { ChatSession } from '@/features/chat/types/session';

const { createSessionWithDefaultsMock, invokeMock, sessionManagerGetMock } = vi.hoisted(() => ({
  createSessionWithDefaultsMock: vi.fn(),
  invokeMock: vi.fn(),
  sessionManagerGetMock: vi.fn(),
}));

vi.mock('@/features/chat/core/session/createSessionWithDefaults', () => ({
  createSessionWithDefaults: createSessionWithDefaultsMock,
}));

vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: {
    get: sessionManagerGetMock,
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    readFileAsBytes: vi.fn(),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

function buildDraftSession(id: string, groupId?: string): ChatSession {
  const scope = groupId ? `chat:group:${groupId}` : 'chat:ungrouped';

  return {
    id,
    mode: 'chat',
    title: null,
    metadata: {
      chatV2Draft: {
        hidden: true,
        scope,
        version: 1,
      },
    },
    groupId,
    persistStatus: 'active',
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:00.000Z',
  };
}

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

function createDeps(overrides: Partial<UseSessionLifecycleDeps> = {}): UseSessionLifecycleDeps {
  const sessionsRef = { current: [] as ChatSession[] };
  return {
    currentSessionId: null,
    setSessions: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setIsLoading: vi.fn(),
    setTotalSessionCount: vi.fn(),
    setUngroupedSessionCount: vi.fn(),
    setHasMoreSessions: vi.fn(),
    setIsInitialLoading: vi.fn(),
    setIsLoadingMore: vi.fn(),
    setShowChatControl: vi.fn(),
    isLoadingMore: false,
    hasMoreSessions: true,
    sessionsRef,
    t: ((key: string, fallback?: string) => fallback ?? key) as UseSessionLifecycleDeps['t'],
    PAGE_SIZE: 50,
    LAST_SESSION_KEY: 'chat-v2-last-session-id',
    ...overrides,
  };
}

describe('useSessionLifecycle hidden draft creation', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
    createSessionWithDefaultsMock.mockReset();
    invokeMock.mockReset();
    sessionManagerGetMock.mockReset();
  });

  it('does not create another session while the current session is a hidden draft', async () => {
    const deps = createDeps({ currentSessionId: 'sess_draft_1' });
    let api: ReturnType<typeof useSessionLifecycle> | null = null;

    sessionManagerGetMock.mockReturnValue({
      getState: () => ({
        sessionMetadata: {
          chatV2Draft: {
            hidden: true,
            scope: 'chat:ungrouped',
            version: 1,
          },
        },
      }),
    });

    function Harness() {
      api = useSessionLifecycle(deps);
      return null;
    }

    render(<Harness />);

    await act(async () => {
      await api!.createSession();
    });

    expect(createSessionWithDefaultsMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith('chat_v2_get_session', expect.anything());
    expect(deps.setCurrentSessionId).not.toHaveBeenCalled();
  });

  it('creates a hidden draft when the current session is already a normal session', async () => {
    const nextDraft = buildDraftSession('sess_draft_next');
    const deps = createDeps({ currentSessionId: 'sess_normal_1' });
    let api: ReturnType<typeof useSessionLifecycle> | null = null;

    sessionManagerGetMock.mockReturnValue({
      getState: () => ({
        sessionMetadata: null,
      }),
    });
    createSessionWithDefaultsMock.mockResolvedValueOnce(nextDraft);

    function Harness() {
      api = useSessionLifecycle(deps);
      return null;
    }

    render(<Harness />);

    await act(async () => {
      await api!.createSession();
    });

    expect(createSessionWithDefaultsMock).toHaveBeenCalledTimes(1);
    expect(deps.setCurrentSessionId).toHaveBeenCalledWith('sess_draft_next');
  });

  it('creates a group-scoped draft when the current hidden draft belongs to another scope', async () => {
    const nextDraft = buildDraftSession('sess_group_draft', 'group-114');
    const deps = createDeps({ currentSessionId: 'sess_ungrouped_draft' });
    let api: ReturnType<typeof useSessionLifecycle> | null = null;

    sessionManagerGetMock.mockReturnValue({
      getState: () => ({
        sessionMetadata: {
          chatV2Draft: {
            hidden: true,
            scope: 'chat:ungrouped',
            version: 1,
          },
        },
      }),
    });
    createSessionWithDefaultsMock.mockResolvedValueOnce(nextDraft);

    function Harness() {
      api = useSessionLifecycle(deps);
      return null;
    }

    render(<Harness />);

    await act(async () => {
      await api!.createSession('group-114');
    });

    expect(createSessionWithDefaultsMock).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'group-114',
      metadata: expect.objectContaining({
        chatV2Draft: expect.objectContaining({
          hidden: true,
          scope: 'chat:group:group-114',
        }),
      }),
    }));
    expect(deps.setCurrentSessionId).toHaveBeenCalledWith('sess_group_draft');
  });
});
