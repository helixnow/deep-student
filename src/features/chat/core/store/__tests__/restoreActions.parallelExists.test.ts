/**
 * restoreFromBackend 资源 exists 校验并行化回归测试
 *
 * 断言：
 * 1. 所有引用的 exists IPC 在任何一个结果返回前就已全部发出（Promise.all 并行，
 *    而非逐个 await 的串行）；
 * 2. 校验结果语义不变：不存在的引用被剔除，校验抛错的引用被保留。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadSessionResponseType } from '../../types';
import type { ChatStoreState, GetState, SetState } from '../types';
import { createRestoreActions } from '../restoreActions';

const existsMock = vi.fn<(resourceId: string) => Promise<boolean>>();

vi.mock('../../../resources', () => ({
  resourceStoreApi: {
    exists: (resourceId: string) => existsMock(resourceId),
    get: vi.fn(),
    createOrReuse: vi.fn(),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

const VALID_HASH = 'b'.repeat(64);

function ref(resourceId: string) {
  return { resourceId, hash: VALID_HASH, typeId: 'file' };
}

function buildResponse(refs: Array<{ resourceId: string }>): LoadSessionResponseType {
  return {
    session: {
      id: 'sess_parallel',
      mode: 'chat',
      persistStatus: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    messages: [],
    blocks: [],
    state: {
      pendingContextRefsJson: JSON.stringify(refs),
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  } as LoadSessionResponseType;
}

function createHarness() {
  let state = {
    sessionId: null,
    isDataLoaded: false,
    messageMap: new Map(),
    messageOrder: [],
    blocks: new Map(),
    attachments: [],
    pendingContextRefs: [],
    groupId: null,
    sessionStatus: 'idle',
    currentStreamingMessageId: null,
    activeBlockIds: new Set(),
    streamingVariantIds: new Set(),
    pendingBlockingInteraction: null,
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

/** 冲刷微任务与 setTimeout(0) 级别的宏任务 */
async function flushAsync(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  existsMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('restoreFromBackend — 资源 exists 并行校验', () => {
  it('issues all exists calls before any of them resolves', async () => {
    const refs = [ref('res_aaaaa00001'), ref('res_aaaaa00002'), ref('res_aaaaa00003')];
    const callsAtFirstResolve: number[] = [];
    const resolvers: Array<(value: boolean) => void> = [];

    existsMock.mockImplementation(() =>
      new Promise<boolean>((resolve) => {
        resolvers.push((value) => {
          callsAtFirstResolve.push(existsMock.mock.calls.length);
          resolve(value);
        });
      }),
    );

    const { actions } = createHarness();
    actions.restoreFromBackend(buildResponse(refs));

    // 等恢复链推进到 exists 校验（Step 3）
    await vi.waitFor(() => {
      expect(existsMock).toHaveBeenCalledTimes(3);
    });

    // 串行实现下第二次调用只会在第一次 resolve 之后发生；
    // 此处三次调用已全部 pending，证明是并行发出。
    resolvers.forEach((resolve) => resolve(true));
    await flushAsync();

    expect(callsAtFirstResolve.every((count) => count === 3)).toBe(true);
  });

  it('removes refs confirmed missing and keeps refs whose check throws', async () => {
    const refs = [ref('res_keep000001'), ref('res_gone000001'), ref('res_err0000001')];
    existsMock.mockImplementation(async (resourceId: string) => {
      if (resourceId === 'res_gone000001') return false;
      if (resourceId === 'res_err0000001') throw new Error('ipc failure');
      return true;
    });

    const { actions, getState } = createHarness();
    actions.restoreFromBackend(buildResponse(refs));

    await vi.waitFor(() => {
      expect(existsMock).toHaveBeenCalledTimes(3);
    });
    await flushAsync();

    const remaining = getState().pendingContextRefs.map((r) => r.resourceId);
    expect(remaining).toContain('res_keep000001');
    expect(remaining).toContain('res_err0000001'); // 校验失败保留（宁可多保留）
    expect(remaining).not.toContain('res_gone000001');
  });
});
