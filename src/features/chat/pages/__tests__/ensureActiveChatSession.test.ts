import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '../../types/session';
import {
  __resetHiddenDraftSessionTrackingForTests,
  buildHiddenDraftSessionMetadata,
  getDraftSessionScope,
} from '../draftSession';
import { ensureActiveChatSession } from '../ensureActiveChatSession';
import { sessionManager } from '../../core/session/sessionManager';

const { invokeMock, createSessionWithDefaultsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  createSessionWithDefaultsMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('../../core/session/createSessionWithDefaults', () => ({
  createSessionWithDefaults: createSessionWithDefaultsMock,
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

describe('ensureActiveChatSession anti-hijack', () => {
  beforeEach(async () => {
    localStorage.clear();
    __resetHiddenDraftSessionTrackingForTests();
    sessionManager.setCurrentSessionId(null);
    await sessionManager.destroyAll();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    createSessionWithDefaultsMock.mockReset();
  });

  afterEach(async () => {
    sessionManager.setCurrentSessionId(null);
    await sessionManager.destroyAll();
    localStorage.clear();
    __resetHiddenDraftSessionTrackingForTests();
  });

  it('creates and activates a fresh hidden draft instead of hijacking an active session with messages', async () => {
    const existingStore = sessionManager.getOrCreate('sess_dijkstra', { mode: 'chat' });
    existingStore.setState({ messageOrder: ['msg_1', 'msg_2'] });
    sessionManager.setCurrentSessionId('sess_dijkstra');

    const scope = getDraftSessionScope('chat', null);
    const freshDraft = makeSession({
      id: 'sess_draft_new',
      title: null,
      metadata: buildHiddenDraftSessionMetadata(null, scope),
    });
    createSessionWithDefaultsMock.mockResolvedValueOnce(freshDraft);

    const resolvedId = await ensureActiveChatSession();

    expect(resolvedId).toBe('sess_draft_new');
    expect(sessionManager.getCurrentSessionId()).toBe('sess_draft_new');
    expect(createSessionWithDefaultsMock).toHaveBeenCalledTimes(1);
    expect(sessionManager.peek('sess_draft_new')?.getState().sessionMetadata).toEqual(freshDraft.metadata);
  });

  it('reuses an active empty draft so multi-quote flows accumulate refs in the same draft', async () => {
    const scope = getDraftSessionScope('chat', null);
    const draftStore = sessionManager.getOrCreate('sess_draft_empty', { mode: 'chat' });
    draftStore.setState({
      messageOrder: [],
      sessionMetadata: buildHiddenDraftSessionMetadata(null, scope),
    });
    sessionManager.setCurrentSessionId('sess_draft_empty');

    const resolvedId = await ensureActiveChatSession();

    expect(resolvedId).toBe('sess_draft_empty');
    expect(createSessionWithDefaultsMock).not.toHaveBeenCalled();
  });

  it('keeps the active non-empty session when preferFreshDraft is false', async () => {
    const existingStore = sessionManager.getOrCreate('sess_existing', { mode: 'chat' });
    existingStore.setState({ messageOrder: ['msg_1'] });
    sessionManager.setCurrentSessionId('sess_existing');

    const resolvedId = await ensureActiveChatSession({ preferFreshDraft: false });

    expect(resolvedId).toBe('sess_existing');
    expect(createSessionWithDefaultsMock).not.toHaveBeenCalled();
  });
});
