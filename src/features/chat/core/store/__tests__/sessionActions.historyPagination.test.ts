/**
 * 历史消息分页（向上懒加载）状态机回归测试
 *
 * 覆盖：
 * - sessionActions.loadEarlierMessages：成功 / 失败重试 / 最早页短路 /
 *   防重入 / 快速切会话迟到错误不污染新会话 / 无回调报错
 * - restoreFromBackend / prependHistoryFromBackend 的分页标志维护
 *   （hasMoreHistory / earlierHistoryExhausted / 全量响应语义 / 旧请求丢弃）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionActions } from '../sessionActions';
import { createRestoreActions } from '../restoreActions';
import type { ChatStoreState, GetState, SetState } from '../types';
import { createInitialState } from '../types';
import type { Message } from '../../types/message';
import type { LoadSessionResponseType } from '../../types';

vi.mock('../../../resources', () => ({
  resourceStoreApi: {
    exists: vi.fn(async () => true),
    get: vi.fn(),
    createOrReuse: vi.fn(),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('../../registry/eventRegistry', () => {
  const handlers = new Map<string, unknown>();
  return {
    eventRegistry: {
      register: (type: string, handler: unknown) => handlers.set(type, handler),
      get: (type: string) => handlers.get(type),
      has: (type: string) => handlers.has(type),
    },
  };
});

function createHarness(initial?: Partial<ChatStoreState>) {
  let state = { ...createInitialState('sess_1'), ...initial } as ChatStoreState;
  const set: SetState = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch } as ChatStoreState;
  };
  const sessionActions = createSessionActions(set as never, () => state as never, () => {});
  const restoreActions = createRestoreActions(set, () => state as ReturnType<GetState>);
  return { sessionActions, restoreActions, getState: () => state };
}

function backendMessage(
  id: string,
  timestamp: number,
): LoadSessionResponseType['messages'][number] {
  return { id, sessionId: 'sess_1', role: 'assistant', blockIds: [], timestamp };
}

function pageResponse(
  messages: LoadSessionResponseType['messages'],
  totalMessageCount?: number,
): LoadSessionResponseType {
  return {
    session: {
      id: 'sess_1',
      mode: 'chat',
      persistStatus: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    messages,
    blocks: [],
    ...(totalMessageCount === undefined ? {} : { totalMessageCount }),
  };
}

describe('loadEarlierMessages（store action）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('成功：调用回调并维护 isLoadingEarlier 生命周期', async () => {
    const { sessionActions, getState } = createHarness({ hasMoreHistory: true });
    let loadingDuringCall: boolean | undefined;
    const callback = vi.fn(async () => {
      loadingDuringCall = getState().isLoadingEarlier;
    });
    sessionActions.setLoadEarlierMessagesCallback(callback);

    await sessionActions.loadEarlierMessages();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(loadingDuringCall).toBe(true);
    expect(getState().isLoadingEarlier).toBe(false);
    expect(getState().loadEarlierError).toBeNull();
  });

  it('失败重试：reject 置 error，重试成功后清空', async () => {
    const { sessionActions, getState } = createHarness({ hasMoreHistory: true });
    const callback = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined);
    sessionActions.setLoadEarlierMessagesCallback(callback);

    await sessionActions.loadEarlierMessages();
    expect(getState().loadEarlierError).toBe('network down');
    expect(getState().isLoadingEarlier).toBe(false);

    await sessionActions.loadEarlierMessages();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(getState().loadEarlierError).toBeNull();
    expect(getState().isLoadingEarlier).toBe(false);
  });

  it('最早页：hasMoreHistory=false 时短路不再请求', async () => {
    const { sessionActions } = createHarness({ hasMoreHistory: false });
    const callback = vi.fn(async () => {});
    sessionActions.setLoadEarlierMessagesCallback(callback);

    await sessionActions.loadEarlierMessages();
    expect(callback).not.toHaveBeenCalled();
  });

  it('防重入：加载在途时重复调用不再触发回调', async () => {
    const { sessionActions } = createHarness({ hasMoreHistory: true });
    let release!: () => void;
    const callback = vi.fn(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    sessionActions.setLoadEarlierMessagesCallback(callback);

    const first = sessionActions.loadEarlierMessages();
    await sessionActions.loadEarlierMessages();
    expect(callback).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('快速切会话：迟到的失败不污染新会话分页状态', async () => {
    const { sessionActions, getState } = createHarness({ hasMoreHistory: true });
    const callback = vi.fn(async () => {
      // 模拟请求在途期间用户切换到 sess_2（新会话 restore 会重置标志）
      const setSession = { sessionId: 'sess_2', isLoadingEarlier: false, loadEarlierError: null };
      Object.assign(getState(), setSession);
      throw new Error('stale failure');
    });
    sessionActions.setLoadEarlierMessagesCallback(callback);

    await sessionActions.loadEarlierMessages();

    expect(getState().loadEarlierError).toBeNull();
    expect(getState().isLoadingEarlier).toBe(false);
  });

  it('无回调注入时抛出配置错误', async () => {
    const { sessionActions } = createHarness({ hasMoreHistory: true });
    await expect(sessionActions.loadEarlierMessages()).rejects.toThrow(
      'History pagination callback is not configured',
    );
  });
});

describe('restore/prepend 分页标志', () => {
  function restoreHarness() {
    let state = {
      ...createInitialState('sess_1'),
      sessionId: null,
      attachments: [],
      setPendingApproval: () => {},
      repairSkillState: vi.fn(),
    } as unknown as ChatStoreState;
    const set: SetState = (partial) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const actions = createRestoreActions(set, () => state as ReturnType<GetState>);
    return { actions, getState: () => state };
  }

  it('restoreFromBackend：总数大于尾部窗口时 hasMoreHistory=true 且标志重置', () => {
    const { actions, getState } = restoreHarness();
    actions.restoreFromBackend(
      pageResponse([backendMessage('m1', 100), backendMessage('m2', 200)], 10),
    );
    expect(getState().hasMoreHistory).toBe(true);
    expect(getState().isLoadingEarlier).toBe(false);
    expect(getState().loadEarlierError).toBeNull();
    expect(getState().earlierHistoryExhausted).toBe(false);
  });

  it('restoreFromBackend：总数等于已加载时 hasMoreHistory=false', () => {
    const { actions, getState } = restoreHarness();
    actions.restoreFromBackend(
      pageResponse([backendMessage('m1', 100), backendMessage('m2', 200)], 2),
    );
    expect(getState().hasMoreHistory).toBe(false);
    expect(getState().earlierHistoryExhausted).toBe(false);
  });

  it('prependHistoryFromBackend：按页总数更新 hasMore，抵达最早页置 exhausted', () => {
    const { sessionActions, restoreActions, getState } = createHarness({
      sessionId: 'sess_1',
      isDataLoaded: true,
      hasMoreHistory: true,
    });
    void sessionActions;

    // 中间页：total=4，当前 2 条 + 页 1 条 → 仍有更早历史
    restoreActions.prependHistoryFromBackend(
      pageResponse([backendMessage('m0', 50)], 4),
    );
    expect(getState().messageOrder).toEqual(['m0']);
    expect(getState().hasMoreHistory).toBe(true);
    expect(getState().earlierHistoryExhausted).toBe(false);

    // 最早页：total=2，合并后 2 条 → exhausted
    restoreActions.prependHistoryFromBackend(
      pageResponse([backendMessage('m-1', 10)], 2),
    );
    expect(getState().hasMoreHistory).toBe(false);
    expect(getState().earlierHistoryExhausted).toBe(true);
  });

  it('prependHistoryFromBackend：无 totalMessageCount 的响应视为全量', () => {
    const { restoreActions, getState } = createHarness({
      sessionId: 'sess_1',
      isDataLoaded: true,
      hasMoreHistory: true,
    });
    restoreActions.prependHistoryFromBackend(
      pageResponse([backendMessage('m0', 50)]),
    );
    expect(getState().hasMoreHistory).toBe(false);
    expect(getState().earlierHistoryExhausted).toBe(true);
  });

  it('prependHistoryFromBackend：页内容全去重时也同步分页标志', () => {
    const existing: Message = { id: 'm0', role: 'assistant', blockIds: [], timestamp: 50 };
    const { restoreActions, getState } = createHarness({
      sessionId: 'sess_1',
      isDataLoaded: true,
      hasMoreHistory: true,
      messageMap: new Map([[existing.id, existing]]),
      messageOrder: [existing.id],
    });
    // 同一消息再次下发改造成"无变化"分支，但 total=1 == 已加载 → exhausted
    restoreActions.prependHistoryFromBackend(
      pageResponse([backendMessage('m0', 50)], 1),
    );
    expect(getState().hasMoreHistory).toBe(false);
    expect(getState().earlierHistoryExhausted).toBe(true);
  });

  it('prependHistoryFromBackend：旧会话的迟到响应被整体丢弃', () => {
    const { restoreActions, getState } = createHarness({
      sessionId: 'sess_new',
      isDataLoaded: true,
      hasMoreHistory: false,
    });
    restoreActions.prependHistoryFromBackend(
      pageResponse([backendMessage('m0', 50)], 99),
    );
    expect(getState().messageOrder).toEqual([]);
    expect(getState().hasMoreHistory).toBe(false);
    expect(getState().earlierHistoryExhausted).toBe(false);
  });
});
