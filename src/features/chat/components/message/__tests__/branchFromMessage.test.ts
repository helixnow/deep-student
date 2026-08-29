import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../../../core/types';
import {
  getSessionBranchTargets,
  rebuildSessionBranchIndex,
  resetSessionBranchIndexForTest,
  subscribeSessionBranchIndex,
} from '../../../core/session/sessionBranchIndex';
import {
  peekPendingChatNavigation,
  resetChatNavigationHandshakeForTest,
} from '../../../navigation/pendingChatNavigation';
import { branchSessionFromMessage } from '../branchFromMessage';

function fakeStore(state: Partial<ChatStore>): StoreApi<ChatStore> {
  return {
    getState: () => state as ChatStore,
  } as StoreApi<ChatStore>;
}

describe('branchSessionFromMessage', () => {
  beforeEach(() => {
    resetSessionBranchIndexForTest();
    resetChatNavigationHandshakeForTest();
  });

  afterEach(() => {
    resetSessionBranchIndexForTest();
    resetChatNavigationHandshakeForTest();
  });

  it('uses the store branch path, records the badge, and navigates through the handshake', async () => {
    const branchSession = vi.fn().mockResolvedValue({
      id: 'sess_branch',
      mode: 'chat',
      title: 'Branch',
      createdAt: '2026-08-24T08:00:00Z',
    });
    const navigated: string[] = [];
    const privateBranchEvent = vi.fn();
    const navigationListener = (event: Event) => {
      navigated.push((event as CustomEvent<{ sessionId: string }>).detail.sessionId);
    };
    window.addEventListener('navigate-to-session', navigationListener);
    window.addEventListener('CHAT_V2_BRANCH_SESSION', privateBranchEvent);

    try {
      const result = await branchSessionFromMessage(
        fakeStore({ sessionId: 'sess_source', branchSession }),
        'msg_cut',
      );

      expect(branchSession).toHaveBeenCalledWith('msg_cut');
      expect(result.id).toBe('sess_branch');
      expect(getSessionBranchTargets('sess_source', 'msg_cut')).toEqual([{
        sessionId: 'sess_branch',
        title: 'Branch',
        branchedAt: '2026-08-24T08:00:00Z',
      }]);
      expect(navigated).toEqual(['sess_branch']);
      expect(peekPendingChatNavigation()).toEqual({
        kind: 'session',
        sessionId: 'sess_branch',
      });
      expect(privateBranchEvent).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('navigate-to-session', navigationListener);
      window.removeEventListener('CHAT_V2_BRANCH_SESSION', privateBranchEvent);
    }
  });

  it('fails without a store branch implementation and does not navigate', async () => {
    const navigated = vi.fn();
    window.addEventListener('navigate-to-session', navigated);
    try {
      await expect(
        branchSessionFromMessage(fakeStore({ sessionId: 'sess_source' }), 'msg_cut'),
      ).rejects.toThrow('store.branchSession is unavailable');
      expect(navigated).not.toHaveBeenCalled();
      expect(peekPendingChatNavigation()).toBeNull();
    } finally {
      window.removeEventListener('navigate-to-session', navigated);
    }
  });
});

describe('sessionBranchIndex', () => {
  beforeEach(() => {
    resetSessionBranchIndexForTest();
  });

  afterEach(() => {
    resetSessionBranchIndexForTest();
  });

  it('rebuilds persisted branch metadata, skips malformed entries, and deduplicates targets', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionBranchIndex(listener);
    try {
      rebuildSessionBranchIndex([
        {
          id: 'sess_branch',
          title: 'Branch',
          metadata: {
            branchedFrom: {
              sessionId: 'sess_source',
              messageId: 'msg_cut',
              branchedAt: '2026-08-24T08:00:00Z',
            },
          },
        },
        {
          id: 'sess_branch',
          title: 'Duplicate',
          metadata: {
            branchedFrom: {
              sessionId: 'sess_source',
              messageId: 'msg_cut',
            },
          },
        },
        {
          id: 'sess_invalid',
          metadata: { branchedFrom: { sessionId: '', messageId: 'msg_cut' } },
        },
      ]);

      expect(listener).toHaveBeenCalledOnce();
      expect(getSessionBranchTargets('sess_source', 'msg_cut')).toEqual([{
        sessionId: 'sess_branch',
        title: 'Branch',
        branchedAt: '2026-08-24T08:00:00Z',
      }]);
      expect(getSessionBranchTargets('sess_source', 'missing')).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});
