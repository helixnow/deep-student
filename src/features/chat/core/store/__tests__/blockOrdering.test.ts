import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBlockInternal } from '../createChatStore';
import { createStreamActions } from '../streamActions';
import type { ChatStoreState, GetState, SetState } from '../types';
import type { Block } from '../../types/block';
import type { Message } from '../../types/message';

// ============================================================================
// createBlockInternal：晚到块按 startedAt 有序插入（修复：块被 push 到末尾）
// ============================================================================

type StateSnapshot = {
  blocks: Map<string, Block>;
  messageMap: Map<string, Message>;
  activeBlockIds: Set<string>;
  sessionStatus: ChatStoreState['sessionStatus'];
  currentStreamingMessageId: string | null;
};

function makeSetHarness(initial: StateSnapshot) {
  let state = initial as unknown as ChatStoreState;
  const set: SetState = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch } as ChatStoreState;
  };
  const getState: GetState = () => state as ReturnType<GetState>;
  return {
    getState: () => state as unknown as StateSnapshot,
    set,
    getStateRaw: getState,
  };
}

function block(id: string, startedAt: number, type: Block['type'] = 'thinking'): Block {
  return { id, type, status: 'success', messageId: 'msg_1', startedAt };
}

describe('createBlockInternal ordered insertion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('inserts a late block before blocks with a later startedAt instead of appending', () => {
    const initial: StateSnapshot = {
      blocks: new Map([
        ['blk_think', block('blk_think', 1000)],
        ['blk_content', block('blk_content', 3000, 'content')],
      ]),
      messageMap: new Map<string, Message>([
        ['msg_1', {
          id: 'msg_1',
          role: 'assistant',
          blockIds: ['blk_think', 'blk_content'],
          timestamp: 1000,
        } as unknown as Message],
      ]),
      activeBlockIds: new Set(),
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
    };
    const harness = makeSetHarness(initial);

    // 模拟“晚到”块：startedAt=2000（介于已有块之间），而非真实当前时间
    vi.spyOn(Date, 'now').mockReturnValue(2000);

    createBlockInternal('msg_1', 'thinking', 'blk_late', harness.set, harness.getStateRaw);

    const state = harness.getState();
    expect(state.messageMap.get('msg_1')?.blockIds).toEqual([
      'blk_think',
      'blk_late',
      'blk_content',
    ]);
    expect(state.blocks.has('blk_late')).toBe(true);
  });

  it('still appends when the new block is the latest (normal streaming order)', () => {
    const initial: StateSnapshot = {
      blocks: new Map([
        ['blk_think', block('blk_think', 1000)],
        ['blk_content', block('blk_content', 2000, 'content')],
      ]),
      messageMap: new Map<string, Message>([
        ['msg_1', {
          id: 'msg_1',
          role: 'assistant',
          blockIds: ['blk_think', 'blk_content'],
          timestamp: 1000,
        } as unknown as Message],
      ]),
      activeBlockIds: new Set(),
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
    };
    const harness = makeSetHarness(initial);
    vi.spyOn(Date, 'now').mockReturnValue(3000);

    createBlockInternal('msg_1', 'mcp_tool', 'blk_tool', harness.set, harness.getStateRaw);

    const state = harness.getState();
    expect(state.messageMap.get('msg_1')?.blockIds).toEqual([
      'blk_think',
      'blk_content',
      'blk_tool',
    ]);
  });
});

// ============================================================================
// completeStream：终态归一化将乱序 blockIds 按时间戳重排
// ============================================================================

function createStreamHarness(initial: Partial<ChatStoreState> & {
  sessionStatus: ChatStoreState['sessionStatus'];
}) {
  let state = {
    activeBlockIds: new Set<string>(),
    currentStreamingMessageId: null as string | null,
    blocks: new Map<string, Block>(),
    messageMap: new Map<string, Message>(),
    ...initial,
  } as unknown as ChatStoreState;

  const set: SetState = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch } as ChatStoreState;
  };
  const getState: GetState = () => state as ReturnType<GetState>;
  const actions = createStreamActions(set, getState);
  return {
    getState: () => state,
    actions,
  };
}

describe('completeStream terminal normalization', () => {
  it('reorders blockIds when a late block was appended to the tail (installed-version repro)', () => {
    const thinkA = block('blk_think_a', 1000);
    const content = block('blk_content', 3000, 'content');
    // 模拟安装版 0.9.50 的数据形态：克隆 thinking 块时间戳早于 content，
    // 却被追加在消息末尾
    const thinkBClone = block('blk_think_b', 2000);
    thinkBClone.status = 'running';
    thinkBClone.endedAt = 2000;

    const msg = {
      id: 'msg_1',
      role: 'assistant',
      blockIds: ['blk_think_a', 'blk_content', 'blk_think_b'],
      timestamp: 1000,
    } as unknown as Message;

    const harness = createStreamHarness({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
      activeBlockIds: new Set(['blk_think_b']),
      blocks: new Map([
        ['blk_think_a', thinkA],
        ['blk_content', content],
        ['blk_think_b', thinkBClone],
      ]),
      messageMap: new Map([['msg_1', msg]]),
    });

    harness.actions.completeStream('success');

    const state = harness.getState();
    // 按 firstChunkAt/startedAt 重排：A(1000) → B(2000) → content(3000)
    expect(state.messageMap.get('msg_1')?.blockIds).toEqual([
      'blk_think_a',
      'blk_think_b',
      'blk_content',
    ]);
    // 残留 running 块被收尾为 success
    expect(state.blocks.get('blk_think_b')?.status).toBe('success');
  });

  it('keeps the original order when blockIds are already chronological', () => {
    const thinkA = block('blk_think_a', 1000);
    const content = block('blk_content', 2000, 'content');
    const msg = {
      id: 'msg_1',
      role: 'assistant',
      blockIds: ['blk_think_a', 'blk_content'],
      timestamp: 1000,
    } as unknown as Message;

    const harness = createStreamHarness({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
      activeBlockIds: new Set(),
      blocks: new Map([
        ['blk_think_a', thinkA],
        ['blk_content', content],
      ]),
      messageMap: new Map([['msg_1', msg]]),
    });

    const before = harness.getState().messageMap.get('msg_1');
    harness.actions.completeStream('success');
    const after = harness.getState().messageMap.get('msg_1');

    expect(after?.blockIds).toEqual(['blk_think_a', 'blk_content']);
    // 引用保持不变（零拷贝快速路径）
    expect(after).toBe(before);
  });
});
