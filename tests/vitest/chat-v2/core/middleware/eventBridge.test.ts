/**
 * Chat V2 - EventBridge 单元测试
 *
 * 测试内容（Prompt 9 要求）：
 * 1. 验证乱序缓存与释放
 * 2. 验证变体事件分发
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleBackendEventWithSequence,
  resetBridgeState,
  clearBridgeState,
  clearEventContext,
  EVENT_TYPE_VARIANT_START,
  EVENT_TYPE_VARIANT_END,
  type BackendEvent,
  type EventBridgeState,
} from '@/chat-v2/core/middleware/eventBridge';
import { eventRegistry } from '@/chat-v2/registry/eventRegistry';

// ============================================================================
// Mock 设置
// ============================================================================

// Mock autoSave
vi.mock('@/chat-v2/core/middleware/autoSave', () => ({
  autoSave: {
    scheduleAutoSave: vi.fn(),
    forceImmediateSave: vi.fn().mockResolvedValue(undefined),
  },
  streamingBlockSaver: {
    scheduleBlockSave: vi.fn(),
    setSaveCallback: vi.fn(),
  },
}));

// Mock chunkBuffer
vi.mock('@/chat-v2/core/middleware/chunkBuffer', () => ({
  chunkBuffer: {
    setStore: vi.fn(),
    push: vi.fn(),
    flushSession: vi.fn(),
  },
}));

// 获取 mock 的 chunkBuffer 引用
import { chunkBuffer as mockChunkBuffer } from '@/chat-v2/core/middleware/chunkBuffer';

// Mock Store
function createMockStore(sessionId: string = 'test-session') {
  return {
    sessionId,
    currentStreamingMessageId: 'msg-1',
    messageMap: new Map(),
    blocks: new Map(),
    activeBlockIds: new Set<string>(),

    // Variant methods
    handleVariantStart: vi.fn(),
    handleVariantEnd: vi.fn(),
    addBlockToVariant: vi.fn(),
    addBlockToMessage: vi.fn(),

    // Block methods
    createBlock: vi.fn().mockReturnValue('block-1'),
    createBlockWithId: vi.fn().mockImplementation((_, __, id) => id),
    updateBlockContent: vi.fn(),
    updateBlockStatus: vi.fn(),
    setBlockResult: vi.fn(),
    setBlockError: vi.fn(),
    addActiveBlock: vi.fn(),
    removeActiveBlock: vi.fn(),
  } as any;
}

// ============================================================================
// 测试：序列号检测与乱序缓冲
// ============================================================================

describe('EventBridge - 序列号检测与乱序缓冲', () => {
  let mockStore: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    mockStore = createMockStore();
    resetBridgeState(mockStore.sessionId);

    // 注册测试用 handler
    if (!eventRegistry.get('content')) {
      eventRegistry.register('content', {
        onStart: (store, messageId, _payload, blockId) => {
          return blockId ?? store.createBlock(messageId, 'content');
        },
        onChunk: (store, blockId, chunk) => {
          store.updateBlockContent(blockId, chunk);
        },
        onEnd: (store, blockId) => {
          store.updateBlockStatus(blockId, 'success');
        },
        onError: (store, blockId, error) => {
          store.setBlockError(blockId, error);
        },
      });
    }
  });

  afterEach(() => {
    clearBridgeState(mockStore.sessionId);
    clearEventContext(mockStore.sessionId);
  });

  it('应该按顺序处理连续事件', () => {
    const events: BackendEvent[] = [
      { type: 'content', phase: 'start', messageId: 'msg-1', sequenceId: 0 },
      { type: 'content', phase: 'chunk', blockId: 'block-1', chunk: 'Hello', sequenceId: 1 },
      { type: 'content', phase: 'end', blockId: 'block-1', sequenceId: 2 },
    ];

    // 按顺序处理
    events.forEach(event => handleBackendEventWithSequence(mockStore, event));

    // 验证所有事件都被处理
    expect(mockStore.createBlock).toHaveBeenCalledTimes(1);
    // content 类型的 chunk 通过 chunkBuffer 处理
    expect(mockChunkBuffer.push).toHaveBeenCalledWith(
      'block-1',
      'Hello',
      mockStore.sessionId
    );
    expect(mockStore.updateBlockStatus).toHaveBeenCalledWith('block-1', 'success');
  });

  it('应该缓冲乱序事件并按序处理', () => {
    const event0: BackendEvent = { type: 'content', phase: 'start', messageId: 'msg-1', sequenceId: 0 };
    const event1: BackendEvent = { type: 'content', phase: 'chunk', blockId: 'block-1', chunk: 'Hello', sequenceId: 1 };
    const event2: BackendEvent = { type: 'content', phase: 'end', blockId: 'block-1', sequenceId: 2 };

    // 先处理第一个事件（lastSequenceId === -1 时实现会接受任意 sequenceId）
    // 这里先喂一个正常的 0，确保后续乱序事件会进入缓冲逻辑
    handleBackendEventWithSequence(mockStore, event0);
    expect(mockStore.createBlock).toHaveBeenCalledTimes(1);

    // 事件 2 应该被缓冲（此时 expectedSeqId = 1）
    handleBackendEventWithSequence(mockStore, event2);
    expect(mockStore.updateBlockStatus).not.toHaveBeenCalled();

    // 事件 1 应该被处理，然后缓冲区中的事件 2 也应该被处理（flush buffered）
    handleBackendEventWithSequence(mockStore, event1);
    // content 类型的 chunk 通过 chunkBuffer 处理
    expect(mockChunkBuffer.push).toHaveBeenCalledWith(
      'block-1',
      'Hello',
      mockStore.sessionId
    );
    expect(mockStore.updateBlockStatus).toHaveBeenCalledWith('block-1', 'success');
  });

  it('应该忽略过期事件', () => {
    // 先处理 0 和 1
    handleBackendEventWithSequence(mockStore, {
      type: 'content', phase: 'start', messageId: 'msg-1', sequenceId: 0
    });
    handleBackendEventWithSequence(mockStore, {
      type: 'content', phase: 'chunk', blockId: 'block-1', chunk: 'Hello', sequenceId: 1
    });

    // 尝试处理过期事件（sequenceId = 0）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handleBackendEventWithSequence(mockStore, {
      type: 'content', phase: 'start', messageId: 'msg-1', sequenceId: 0
    });

    // 普通事件的过期分支会静默忽略（仅多变体相关事件会打点/告警）
    expect(warnSpy).not.toHaveBeenCalled();
    expect(mockStore.createBlock).toHaveBeenCalledTimes(1); // 只调用了一次

    warnSpy.mockRestore();
  });

  it('没有 sequenceId 时应该直接处理（向后兼容）', () => {
    const event: BackendEvent = {
      type: 'content',
      phase: 'start',
      messageId: 'msg-1',
      // 没有 sequenceId
    };

    handleBackendEventWithSequence(mockStore, event);
    expect(mockStore.createBlock).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// 测试：变体事件分发
// ============================================================================

describe('EventBridge - 变体事件分发', () => {
  let mockStore: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    mockStore = createMockStore();
    resetBridgeState(mockStore.sessionId);

    // 注册 content handler
    if (!eventRegistry.get('content')) {
      eventRegistry.register('content', {
        onStart: (store, messageId, _payload, blockId) => {
          return blockId ?? store.createBlock(messageId, 'content');
        },
        onChunk: (store, blockId, chunk) => {
          store.updateBlockContent(blockId, chunk);
        },
        onEnd: (store, blockId) => {
          store.updateBlockStatus(blockId, 'success');
        },
      });
    }
  });

  afterEach(() => {
    clearBridgeState(mockStore.sessionId);
    clearEventContext(mockStore.sessionId);
  });

  it('应该处理 variant_start 事件', () => {
    const event: BackendEvent = {
      type: EVENT_TYPE_VARIANT_START,
      phase: 'start',
      messageId: 'msg-1',
      variantId: 'var-1',
      modelId: 'gpt-4',
      sequenceId: 0,
    };

    handleBackendEventWithSequence(mockStore, event);

    // handleVariantStart 接收 BackendVariantEvent 对象
    expect(mockStore.handleVariantStart).toHaveBeenCalledWith(
      expect.objectContaining({
        type: EVENT_TYPE_VARIANT_START,
        messageId: 'msg-1',
        variantId: 'var-1',
        modelId: 'gpt-4',
        sequenceId: 0,
      })
    );
  });

  it('应该处理 variant_end 事件', () => {
    const event: BackendEvent = {
      type: EVENT_TYPE_VARIANT_END,
      phase: 'end',
      variantId: 'var-1',
      status: 'success',
      sequenceId: 5,
    };

    // 先处理一些前置事件让 lastSequenceId = 4
    // 注意：EventBridge 的首事件必须是 phase=start，否则会进入缓冲逻辑
    handleBackendEventWithSequence(mockStore, {
      type: 'content',
      phase: 'start',
      messageId: 'msg-1',
      sequenceId: 0,
    });
    for (let i = 1; i <= 4; i++) {
      handleBackendEventWithSequence(mockStore, {
        type: 'content',
        phase: 'chunk',
        blockId: 'block-1',
        chunk: 'x',
        sequenceId: i,
      });
    }

    handleBackendEventWithSequence(mockStore, event);

    // handleVariantEnd 接收 BackendVariantEvent 对象
    expect(mockStore.handleVariantEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: EVENT_TYPE_VARIANT_END,
        variantId: 'var-1',
        status: 'success',
        sequenceId: 5,
      })
    );
  });

  it('应该将带 variantId 的 block 添加到变体', () => {
    // 先发送 variant_start
    handleBackendEventWithSequence(mockStore, {
      type: EVENT_TYPE_VARIANT_START,
      phase: 'start',
      messageId: 'msg-1',
      variantId: 'var-1',
      modelId: 'gpt-4',
      sequenceId: 0,
    });

    // 发送带 variantId 的 block start 事件
    handleBackendEventWithSequence(mockStore, {
      type: 'content',
      phase: 'start',
      messageId: 'msg-1',
      variantId: 'var-1',
      sequenceId: 1,
    });

    expect(mockStore.addBlockToVariant).toHaveBeenCalledWith(
      'msg-1',
      'var-1',
      expect.any(String) // blockId
    );
  });

  it('无 variantId 的 block 应该兼容旧逻辑', () => {
    // 发送无 variantId 的 block start 事件
    handleBackendEventWithSequence(mockStore, {
      type: 'content',
      phase: 'start',
      messageId: 'msg-1',
      sequenceId: 0,
    });

    // 应该调用 createBlock（通过原有逻辑）
    expect(mockStore.createBlock).toHaveBeenCalled();
  });
});

// ============================================================================
// 测试：缓冲区边界条件
// ============================================================================

describe('EventBridge - 缓冲区边界条件', () => {
  let mockStore: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    mockStore = createMockStore();
    resetBridgeState(mockStore.sessionId);
  });

  afterEach(() => {
    clearBridgeState(mockStore.sessionId);
    clearEventContext(mockStore.sessionId);
  });

  it('缓冲区满时应该丢弃最旧的事件', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 先处理第一个事件，避免 lastSequenceId === -1 的“首事件直接接受”分支
    handleBackendEventWithSequence(mockStore, {
      type: 'content',
      phase: 'start',
      messageId: 'msg-1',
      sequenceId: 0,
    });

    // 填满缓冲区：刻意跳过 expectedSeqId=1，只发送未来事件让其进入 pendingEvents
    for (let i = 2; i <= 101; i++) {
      handleBackendEventWithSequence(mockStore, {
        type: 'content',
        phase: 'chunk',
        blockId: 'block-1',
        chunk: `chunk-${i}`,
        sequenceId: i,
      });
    }

    // 再添加一个事件，应该触发丢弃
    handleBackendEventWithSequence(mockStore, {
      type: 'content',
      phase: 'chunk',
      blockId: 'block-1',
      chunk: 'chunk-102',
      sequenceId: 102,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Buffer full')
    );

    warnSpy.mockRestore();
  });
});
