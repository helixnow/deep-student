/**
 * restoreFromBackend：加载完成前已加进内存、尚未保存的引用不被后端快照冲掉。
 *
 * 场景：工作台里对话窗口未打开时从 PDF 划词「添加到聊天」——引用先进草稿 store，
 * 窗口随后打开才真正从后端恢复；此前整体替换 pendingContextRefs，提示「已引用到对话」
 * 却在输入框里找不到。
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

function createHarness(live: Partial<ChatStoreState> = {}) {
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
    ...live,
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
  existsMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('restoreFromBackend — 保留加载前加入的未保存引用', () => {
  it('与快照按 resourceId 合并，并保持 dirty 让其落盘', async () => {
    const { actions, getState } = createHarness({
      sessionId: 'sess_parallel',
      pendingContextRefs: [ref('res_live000001'), ref('res_both000001')],
      pendingContextRefsDirty: true,
    } as Partial<ChatStoreState>);
    actions.restoreFromBackend(buildResponse([ref('res_saved00001'), ref('res_both000001')]));

    await vi.waitFor(() => {
      expect(getState().isDataLoaded).toBe(true);
    });
    await flushAsync();

    expect(getState().pendingContextRefs.map((r) => r.resourceId)).toEqual([
      'res_saved00001',
      'res_both000001',
      'res_live000001',
    ]);
    expect(getState().pendingContextRefsDirty).toBe(true);
  });

  it('没有未保存改动（非 dirty）或属于别的会话时，以快照为准', async () => {
    const clean = createHarness({
      sessionId: 'sess_parallel',
      pendingContextRefs: [ref('res_stale00001')],
      pendingContextRefsDirty: false,
    } as Partial<ChatStoreState>);
    clean.actions.restoreFromBackend(buildResponse([ref('res_saved00001')]));
    await vi.waitFor(() => expect(clean.getState().isDataLoaded).toBe(true));
    await flushAsync();
    expect(clean.getState().pendingContextRefs.map((r) => r.resourceId)).toEqual(['res_saved00001']);
    expect(clean.getState().pendingContextRefsDirty).toBe(false);

    const other = createHarness({
      sessionId: 'sess_other',
      pendingContextRefs: [ref('res_other0001')],
      pendingContextRefsDirty: true,
    } as Partial<ChatStoreState>);
    other.actions.restoreFromBackend(buildResponse([ref('res_saved00001')]));
    await vi.waitFor(() => expect(other.getState().isDataLoaded).toBe(true));
    await flushAsync();
    expect(other.getState().pendingContextRefs.map((r) => r.resourceId)).toEqual(['res_saved00001']);
  });
});
