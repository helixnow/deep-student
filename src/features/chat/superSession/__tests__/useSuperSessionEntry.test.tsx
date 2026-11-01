import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { SuperSessionChangedPayload } from '../api';

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  changedHandler: null as ((payload: SuperSessionChangedPayload) => void) | null,
  unlisten: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../api', () => ({
  getSuperSessionState: mocks.getState,
  onSuperSessionChanged: async (handler: (payload: SuperSessionChangedPayload) => void) => {
    mocks.changedHandler = handler;
    return mocks.unlisten;
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

import { useSuperSessionEntry } from '../useSuperSessionEntry';

describe('useSuperSessionEntry', () => {
  beforeEach(() => {
    mocks.getState.mockReset();
    mocks.invoke.mockReset();
    mocks.unlisten.mockReset();
    mocks.changedHandler = null;
  });

  it('loads state and fetches the session summary by id', async () => {
    mocks.getState.mockResolvedValue({ enabled: true, sessionId: 'sess_super', workspaceId: 'ws', pendingInbox: 0 });
    mocks.invoke.mockImplementation(async (cmd: string, args: { sessionId: string }) =>
      cmd === 'chat_v2_get_session' ? { id: args.sessionId, mode: 'chat', title: 'Super-agent' } : null,
    );

    const { result } = renderHook(() => useSuperSessionEntry());
    await waitFor(() => expect(result.current.session?.id).toBe('sess_super'));
    expect(result.current.enabled).toBe(true);
    expect(result.current.sessionId).toBe('sess_super');
    expect(result.current.loading).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith('chat_v2_get_session', { sessionId: 'sess_super' });
  });

  it('follows super_session_changed (switch and disable)', async () => {
    mocks.getState.mockResolvedValue({ enabled: true, sessionId: 'sess_a', workspaceId: null, pendingInbox: 0 });
    mocks.invoke.mockImplementation(async (_cmd: string, args: { sessionId: string }) => ({
      id: args.sessionId,
      mode: 'chat',
    }));

    const { result, unmount } = renderHook(() => useSuperSessionEntry());
    await waitFor(() => expect(result.current.session?.id).toBe('sess_a'));
    await waitFor(() => expect(mocks.changedHandler).not.toBeNull());

    act(() => mocks.changedHandler!({ enabled: true, sessionId: 'sess_b' }));
    await waitFor(() => expect(result.current.session?.id).toBe('sess_b'));

    act(() => mocks.changedHandler!({ enabled: false, sessionId: null }));
    await waitFor(() => expect(result.current.sessionId).toBeNull());
    expect(result.current.enabled).toBe(false);
    expect(result.current.session).toBeNull();

    unmount();
    expect(mocks.unlisten).toHaveBeenCalled();
  });
});
