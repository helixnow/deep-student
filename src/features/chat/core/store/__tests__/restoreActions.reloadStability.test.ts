import { describe, expect, it, vi } from 'vitest';
import type { LoadSessionResponseType } from '../../types';
import type { ChatStoreState, GetState, SetState } from '../types';
import { createRestoreActions } from '../restoreActions';

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

function createHarness(live: Partial<ChatStoreState> = {}) {
  let state = {
    sessionId: 'sess_reload',
    isDataLoaded: false,
    messageMap: new Map(),
    messageOrder: [],
    blocks: new Map(),
    attachments: [],
    pendingContextRefs: [],
    pendingContextRefsDirty: false,
    groupId: null,
    sessionStatus: 'idle',
    currentStreamingMessageId: null,
    activeBlockIds: new Set(),
    streamingVariantIds: new Set(),
    pendingBlockingInteraction: null,
    inputValue: '',
    inputValueDirty: false,
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

describe('restoreActions reload stability & Turn 1 attachment preservation (G20)', () => {
  it('clears stale persisted inputValue duplicating the latest already-sent RAG prompt on reload', () => {
    const ragPrompt = '请结合知识库总结 Transformer 注意力公式';
    const { actions, getState } = createHarness();

    const response: LoadSessionResponseType = {
      session: {
        id: 'sess_reload',
        mode: 'chat',
        persistStatus: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      messages: [
        { id: 'msg_u1', sessionId: 'sess_reload', role: 'user', blockIds: ['blk_u1'], timestamp: 100 },
        { id: 'msg_a1', sessionId: 'sess_reload', role: 'assistant', blockIds: ['blk_a1'], timestamp: 200 },
      ],
      blocks: [
        { id: 'blk_u1', messageId: 'msg_u1', type: 'content', status: 'success', content: ragPrompt },
        { id: 'blk_a1', messageId: 'msg_a1', type: 'content', status: 'success', content: '已完成回答。' },
      ],
      state: {
        inputValue: ragPrompt,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    } as LoadSessionResponseType;

    actions.restoreFromBackend(response);
    expect(getState().inputValue).toBe('');
  });

  it('preserves a distinct unsent draft from persisted backend state on reload', () => {
    const { actions, getState } = createHarness();

    const response: LoadSessionResponseType = {
      session: {
        id: 'sess_reload',
        mode: 'chat',
        persistStatus: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      messages: [
        { id: 'msg_u1', sessionId: 'sess_reload', role: 'user', blockIds: ['blk_u1'], timestamp: 100 },
      ],
      blocks: [
        { id: 'blk_u1', messageId: 'msg_u1', type: 'content', status: 'success', content: '第一轮问题' },
      ],
      state: {
        inputValue: '下一轮未发送草稿',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    } as LoadSessionResponseType;

    actions.restoreFromBackend(response);
    expect(getState().inputValue).toBe('下一轮未发送草稿');
  });

  it('settles completed RAG/tool and final usage-backed content blocks to success instead of interrupted error on reload', () => {
    const { actions, getState } = createHarness();

    const response: LoadSessionResponseType = {
      session: {
        id: 'sess_reload',
        mode: 'chat',
        persistStatus: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      messages: [
        {
          id: 'msg_a1',
          sessionId: 'sess_reload',
          role: 'assistant',
          blockIds: ['blk_rag', 'blk_answer'],
          timestamp: 200,
          _meta: {
            usage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, source: 'api' },
          },
        },
      ],
      blocks: [
        {
          id: 'blk_rag',
          messageId: 'msg_a1',
          type: 'rag',
          status: 'running',
          toolOutput: { sources: [{ title: 'paper.pdf' }] },
          startedAt: 100,
        },
        {
          id: 'blk_answer',
          messageId: 'msg_a1',
          type: 'content',
          status: 'running',
          content: '这是已经完成的 RAG 检索回答。',
          startedAt: 150,
        },
      ],
    } as LoadSessionResponseType;

    actions.restoreFromBackend(response);
    expect(getState().sessionStatus).toBe('idle');
    expect(getState().blocks.get('blk_rag')).toMatchObject({
      status: 'success',
    });
    expect(getState().blocks.get('blk_rag')?.error).toBeUndefined();
    expect(getState().blocks.get('blk_answer')).toMatchObject({
      status: 'success',
      aborted: false,
    });
  });

  it('preserves same-session in-flight composer attachments while still clearing attachments on session switch', () => {
    const liveImage = {
      id: 'att_live_1',
      name: 'chart.png',
      type: 'image' as const,
      mimeType: 'image/png',
      size: 1024,
      status: 'uploading' as const,
    };

    const sameSession = createHarness({
      sessionId: 'sess_reload',
      attachments: [liveImage],
    });
    sameSession.actions.restoreFromBackend({
      session: {
        id: 'sess_reload',
        mode: 'chat',
        persistStatus: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      messages: [],
      blocks: [],
    } as LoadSessionResponseType);
    expect(sameSession.getState().attachments).toEqual([liveImage]);

    const differentSession = createHarness({
      sessionId: 'sess_previous',
      attachments: [liveImage],
    });
    differentSession.actions.restoreFromBackend({
      session: {
        id: 'sess_reload',
        mode: 'chat',
        persistStatus: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      messages: [],
      blocks: [],
    } as LoadSessionResponseType);
    expect(differentSession.getState().attachments).toEqual([]);
  });
});
