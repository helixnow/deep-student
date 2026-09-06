import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventRegistry } from '../../../registry/eventRegistry';
import {
  clearBridgeState,
  clearEventContext,
  clearProcessedEventIds,
  flushPendingBackendEvents,
  handleBackendEventWithSequence,
  resetBridgeState,
  type BackendEvent,
} from '../eventBridge';
import type { ChatStore } from '../../types';

function createStore(skillStateVersion = 3) {
  return {
    sessionId: 'sess_test',
    currentStreamingMessageId: 'msg_test',
    skillStateJson: JSON.stringify({ version: skillStateVersion }),
    messageMap: new Map(),
    blocks: new Map(),
    activeBlockIds: new Set(),
    streamingVariantIds: new Set(),
    handleVariantStart: vi.fn(),
    handleVariantEnd: vi.fn(),
    createBlockWithId: vi.fn((_messageId: string, _type: string, backendBlockId: string) => backendBlockId),
    createBlock: vi.fn(() => 'blk_generated'),
    updateBlock: vi.fn(),
    setBlockError: vi.fn(),
    saveSession: vi.fn(async () => undefined),
  } as unknown as ChatStore & { skillStateJson: string };
}

describe('eventBridge guards', () => {
  const onStart = vi.fn((_, __, ___, backendBlockId?: string) => backendBlockId ?? 'blk_generated');
  const onError = vi.fn();
  const onEnd = vi.fn();

  beforeEach(() => {
    eventRegistry.clear();
    eventRegistry.register('tool_call', {
      onStart,
      onError,
      onEnd,
    });
    onStart.mockClear();
    onError.mockClear();
    onEnd.mockClear();
    resetBridgeState('sess_test');
  });

  afterEach(() => {
    clearProcessedEventIds('sess_test');
    clearEventContext('sess_test');
    clearBridgeState('sess_test');
    eventRegistry.clear();
  });

  it('drops stale events from older skillStateVersion', () => {
    const store = createStore(3);
    const event: BackendEvent = {
      sequenceId: 0,
      type: 'tool_call',
      phase: 'start',
      messageId: 'msg_test',
      blockId: 'blk_old',
      payload: { toolName: 'fetch' },
      skillStateVersion: 2,
      roundId: 'tool-round-0',
    };

    handleBackendEventWithSequence(store, event);

    expect(onStart).not.toHaveBeenCalled();
  });

  it('drops events explicitly tagged for a different session', () => {
    const store = createStore(3);
    handleBackendEventWithSequence(store, {
      sequenceId: 0,
      sessionId: 'sess_old',
      type: 'tool_call',
      phase: 'start',
      messageId: 'msg_test',
      blockId: 'blk_stale_session',
      skillStateVersion: 3,
    });

    expect(onStart).not.toHaveBeenCalled();
  });

  it('drops stale tool events from an older round', () => {
    const store = createStore(3);

    handleBackendEventWithSequence(store, {
      sequenceId: 0,
      type: 'tool_call',
      phase: 'start',
      messageId: 'msg_test',
      blockId: 'blk_round',
      payload: { toolName: 'fetch' },
      skillStateVersion: 3,
      roundId: 'tool-round-1',
    });

    handleBackendEventWithSequence(store, {
      sequenceId: 1,
      type: 'tool_call',
      phase: 'error',
      blockId: 'blk_round',
      error: 'late error',
      skillStateVersion: 3,
      roundId: 'tool-round-0',
    });

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('drains sequence-buffered block events at the terminal boundary', () => {
    const store = createStore(3);

    handleBackendEventWithSequence(store, {
      sequenceId: 0,
      type: 'tool_call',
      phase: 'start',
      messageId: 'msg_test',
      blockId: 'blk_tail',
      payload: { toolName: 'fetch' },
      skillStateVersion: 3,
      roundId: 'tool-round-1',
    });
    // Sequence 1 is absent, so this valid tail event waits in pendingEvents.
    handleBackendEventWithSequence(store, {
      sequenceId: 2,
      type: 'tool_call',
      phase: 'end',
      blockId: 'blk_tail',
      skillStateVersion: 3,
      roundId: 'tool-round-1',
    });

    expect(onEnd).not.toHaveBeenCalled();

    flushPendingBackendEvents(store);

    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('eventBridge duplicate start guard', () => {
  const onStart = vi.fn((_, __, ___, backendBlockId?: string) => backendBlockId ?? 'blk_generated');
  const onEnd = vi.fn();
  const onError = vi.fn();

  beforeEach(() => {
    eventRegistry.clear();
    eventRegistry.register('thinking', { onStart, onEnd, onError });
    onStart.mockClear();
    onEnd.mockClear();
    onError.mockClear();
    resetBridgeState('sess_test');
  });

  afterEach(() => {
    clearProcessedEventIds('sess_test');
    clearEventContext('sess_test');
    clearBridgeState('sess_test');
    eventRegistry.clear();
  });

  it('reuses an existing block instead of creating a clone when the same start replays', () => {
    const store = createStore(3);
    // 模拟 restore 后继续流式：blockId 已存在于 store
    (store as { blocks: Map<string, { id: string }> }).blocks = new Map([
      ['blk_restored', { id: 'blk_restored' }],
    ]);

    handleBackendEventWithSequence(store, {
      sequenceId: 0,
      type: 'thinking',
      phase: 'start',
      messageId: 'msg_test',
      blockId: 'blk_restored',
    });

    // 重复 start：不再创建克隆块（onStart 不应被再次调用）
    handleBackendEventWithSequence(store, {
      sequenceId: 1,
      type: 'thinking',
      phase: 'start',
      messageId: 'msg_test',
      blockId: 'blk_restored',
    });

    expect(onStart).not.toHaveBeenCalled();
  });
});

describe('eventBridge virtual-block terminal delivery (deliverTerminalByBlockId)', () => {
  const onStart = vi.fn((_, __, ___, backendBlockId?: string) => backendBlockId ?? 'blk_generated');
  const onEnd = vi.fn();
  const onError = vi.fn();
  const orphanOnError = vi.fn();

  beforeEach(() => {
    eventRegistry.clear();
    eventRegistry.register('tool_approval_request', {
      onStart,
      onEnd,
      onError,
      deliverTerminalByBlockId: true,
    });
    eventRegistry.register('web_search', { onStart, onEnd, onError: orphanOnError });
    onStart.mockClear();
    onEnd.mockClear();
    onError.mockClear();
    orphanOnError.mockClear();
    resetBridgeState('sess_test');
  });

  afterEach(() => {
    clearProcessedEventIds('sess_test');
    clearEventContext('sess_test');
    clearBridgeState('sess_test');
    eventRegistry.clear();
  });

  it('delivers terminal events by blockId when the stream already ended (untracked virtual block)', () => {
    const store = createStore(3);
    // 流已结束：无 currentStreamingMessageId，事件上下文按 '' 重建，
    // approval_* 虚拟块从未落库，必然未被追踪
    store.currentStreamingMessageId = null;

    handleBackendEventWithSequence(store, {
      type: 'tool_approval_request',
      phase: 'error',
      blockId: 'approval_call-1',
      error: 'approval_expired',
    });

    expect(onError).toHaveBeenCalledWith(store, 'approval_call-1', 'approval_expired');
  });

  it('delivers end events by blockId for opted-in handlers', () => {
    const store = createStore(3);
    store.currentStreamingMessageId = null;

    handleBackendEventWithSequence(store, {
      type: 'tool_approval_request',
      phase: 'end',
      blockId: 'approval_call-2',
      result: { toolCallId: 'call-2', approved: true },
    });

    expect(onEnd).toHaveBeenCalledWith(
      store,
      'approval_call-2',
      expect.objectContaining({ toolCallId: 'call-2', approved: true })
    );
  });

  it('delivers sequenced terminal events after the gap buffer drains', () => {
    const store = createStore(3);
    store.currentStreamingMessageId = null;

    // 流结束后桥状态已重置：首包非 start 会进序列缓冲，flush 后仍应直投
    handleBackendEventWithSequence(store, {
      sequenceId: 5,
      type: 'tool_approval_request',
      phase: 'error',
      blockId: 'approval_call-3',
      error: 'approval_expired',
    });
    expect(onError).not.toHaveBeenCalled();

    flushPendingBackendEvents(store);
    expect(onError).toHaveBeenCalledWith(store, 'approval_call-3', 'approval_expired');
  });

  it('keeps orphan buffering for handlers without the opt-in', () => {
    const store = createStore(3);
    store.currentStreamingMessageId = null;

    handleBackendEventWithSequence(store, {
      type: 'web_search',
      phase: 'error',
      blockId: 'blk_unknown',
      error: 'late error',
    });

    // 未 opt-in：进孤儿缓冲等待 start，不直投
    expect(orphanOnError).not.toHaveBeenCalled();
  });
});
