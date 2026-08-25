/**
 * 会话分支统一路径（branchFromMessage + sessionBranchIndex）契约：
 * - 统一走 store.branchSession（不再组件内直连 invoke chat_v2_branch_session）；
 * - 成功后通过标准 navigate-to-session 握手切换并唤起 Chat 主窗；
 * - 成功后原会话消息立即可查到「已从此处分支」目标（recordSessionBranch）；
 * - 索引可由会话列表 metadata.branchedFrom 全量重建（重启后角标仍在）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '@/features/chat/core/types';
import { branchSessionFromMessage } from '@/features/chat/components/message/branchFromMessage';
import {
  getSessionBranchTargets,
  rebuildSessionBranchIndex,
  recordSessionBranch,
  resetSessionBranchIndexForTest,
  subscribeSessionBranchIndex,
} from '@/features/chat/core/session/sessionBranchIndex';
import { resetChatNavigationHandshakeForTest } from '@/features/chat/navigation/pendingChatNavigation';

function createStoreStub(overrides: Partial<ChatStore> = {}): StoreApi<ChatStore> {
  const state = {
    sessionId: 'sess_source',
    branchSession: vi.fn(async () => ({
      id: 'sess_branch',
      mode: 'chat',
      title: '分支会话',
      createdAt: '2026-08-24T00:00:00Z',
    })),
    ...overrides,
  } as unknown as ChatStore;
  return { getState: () => state } as unknown as StoreApi<ChatStore>;
}

describe('branchSessionFromMessage', () => {
  const navigationListener = vi.fn();

  beforeEach(() => {
    resetSessionBranchIndexForTest();
    resetChatNavigationHandshakeForTest();
    navigationListener.mockClear();
    window.addEventListener('navigate-to-session', navigationListener);
  });

  afterEach(() => {
    window.removeEventListener('navigate-to-session', navigationListener);
    resetSessionBranchIndexForTest();
    resetChatNavigationHandshakeForTest();
  });

  it('branches through store.branchSession and requests standard session navigation', async () => {
    const store = createStoreStub();

    const result = await branchSessionFromMessage(store, 'msg_cut');

    expect(store.getState().branchSession).toHaveBeenCalledWith('msg_cut');
    expect(result.id).toBe('sess_branch');
    expect(navigationListener).toHaveBeenCalledTimes(1);
    const event = navigationListener.mock.calls[0][0] as CustomEvent<{ sessionId: string }>;
    expect(event.detail.sessionId).toBe('sess_branch');
  });

  it('records the branch so the source message immediately exposes a navigable target', async () => {
    const store = createStoreStub();

    await branchSessionFromMessage(store, 'msg_cut');

    const targets = getSessionBranchTargets('sess_source', 'msg_cut');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ sessionId: 'sess_branch', title: '分支会话' });
  });

  it('throws (instead of silently invoking the backend directly) when branchSession is missing', async () => {
    const store = createStoreStub({ branchSession: undefined });

    await expect(branchSessionFromMessage(store, 'msg_cut')).rejects.toThrow(/branchSession/);
    expect(navigationListener).not.toHaveBeenCalled();
  });
});

describe('sessionBranchIndex', () => {
  beforeEach(() => resetSessionBranchIndexForTest());
  afterEach(() => resetSessionBranchIndexForTest());

  it('rebuilds from session metadata.branchedFrom (persistent across restarts)', () => {
    rebuildSessionBranchIndex([
      { id: 'sess_plain', title: '普通会话', metadata: null },
      {
        id: 'sess_branch_a',
        title: '分支 A',
        metadata: {
          branchedFrom: { sessionId: 'sess_src', messageId: 'msg_1', branchedAt: '2026-08-24T00:00:00Z' },
        },
      },
      {
        id: 'sess_branch_b',
        title: '分支 B',
        metadata: {
          branchedFrom: { sessionId: 'sess_src', messageId: 'msg_1' },
        },
      },
    ]);

    const targets = getSessionBranchTargets('sess_src', 'msg_1');
    expect(targets.map((t) => t.sessionId)).toEqual(['sess_branch_a', 'sess_branch_b']);
    expect(getSessionBranchTargets('sess_src', 'msg_other')).toEqual([]);
    expect(getSessionBranchTargets('sess_plain', 'msg_1')).toEqual([]);
  });

  it('deduplicates recordSessionBranch against a later rebuild', () => {
    recordSessionBranch('sess_src', 'msg_1', { sessionId: 'sess_branch_a', title: '分支 A' });
    rebuildSessionBranchIndex([
      {
        id: 'sess_branch_a',
        title: '分支 A',
        metadata: { branchedFrom: { sessionId: 'sess_src', messageId: 'msg_1' } },
      },
    ]);

    expect(getSessionBranchTargets('sess_src', 'msg_1')).toHaveLength(1);
  });

  it('notifies subscribers on record and rebuild', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionBranchIndex(listener);

    recordSessionBranch('sess_src', 'msg_1', { sessionId: 'sess_branch_a' });
    expect(listener).toHaveBeenCalledTimes(1);

    rebuildSessionBranchIndex([]);
    expect(listener).toHaveBeenCalledTimes(2);

    // 重复 record 同一分支：无变化不通知
    recordSessionBranch('sess_src', 'msg_1', { sessionId: 'sess_branch_a' });
    rebuildSessionBranchIndex([
      {
        id: 'sess_branch_a',
        metadata: { branchedFrom: { sessionId: 'sess_src', messageId: 'msg_1' } },
      },
    ]);
    recordSessionBranch('sess_src', 'msg_1', { sessionId: 'sess_branch_a' });
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
  });
});
