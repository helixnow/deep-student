/**
 * Chat V2 - eventBridge 中间件单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleBackendEvent,
  clearEventContext,
  createStartEvent,
  createChunkEvent,
  createEndEvent,
  createErrorEvent,
  type BackendEvent,
} from '@/chat-v2/core/middleware/eventBridge';
import { chunkBuffer } from '@/chat-v2/core/middleware/chunkBuffer';
import { eventRegistry } from '@/chat-v2/registry/eventRegistry';
import type { ChatStore } from '@/chat-v2/core/types';

// ============================================================================
// Mock Store 创建
// ============================================================================

function createMockStore(overrides: Partial<ChatStore> = {}): ChatStore {
  return {
    sessionId: 'test-session',
    mode: 'chat',
    sessionStatus: 'idle',
    messageMap: new Map(),
    messageOrder: [],
    blocks: new Map(),
    currentStreamingMessageId: 'msg-1',
    activeBlockIds: new Set(),
    chatParams: {
      modelId: 'test-model',
      temperature: 0.7,
      contextLimit: 4096,
      maxTokens: 2048,
      enableThinking: false,
      disableTools: false,
      model2OverrideId: null,
    },
    features: new Map(),
    modeState: null,
    inputValue: '',
    attachments: [],
    panelStates: {
      rag: false,
      mcp: false,
      search: false,
      learn: false,
      model: false,
      advanced: false,
      attachment: false,
    },
    // Guards
    canSend: vi.fn(() => true),
    canEdit: vi.fn(() => true),
    canDelete: vi.fn(() => true),
    canAbort: vi.fn(() => true),
    isBlockLocked: vi.fn(() => false),
    isMessageLocked: vi.fn(() => false),
    // Actions
    sendMessage: vi.fn(),
    deleteMessage: vi.fn(),
    editMessage: vi.fn(),
    retryMessage: vi.fn(),
    abortStream: vi.fn(),
    createBlock: vi.fn(() => 'block-1'),
    updateBlockContent: vi.fn(),
    updateBlockStatus: vi.fn(),
    setBlockResult: vi.fn(),
    setBlockError: vi.fn(),
    setCurrentStreamingMessage: vi.fn(),
    addActiveBlock: vi.fn(),
    removeActiveBlock: vi.fn(),
    setChatParams: vi.fn(),
    resetChatParams: vi.fn(),
    setFeature: vi.fn(),
    toggleFeature: vi.fn(),
    getFeature: vi.fn(() => false),
    setModeState: vi.fn(),
    updateModeState: vi.fn(),
    setInputValue: vi.fn(),
    addAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    setPanelState: vi.fn(),
    initSession: vi.fn(),
    loadSession: vi.fn(),
    saveSession: vi.fn(() => Promise.resolve()),
    setSaveCallback: vi.fn(),
    setRetryCallback: vi.fn(),
    restoreFromBackend: vi.fn(),
    sendMessageWithIds: vi.fn(),
    updateBlock: vi.fn(),
    createBlockWithId: vi.fn().mockImplementation((_msgId, _type, blockId) => blockId),
    getMessage: vi.fn(),
    getMessageBlocks: vi.fn(() => []),
    getOrderedMessages: vi.fn(() => []),
    ...overrides,
  } as unknown as ChatStore;
}

// ============================================================================
// 测试
// ============================================================================

describe('eventBridge', () => {
  let mockStore: ChatStore;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockStore = createMockStore();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    // 清理上下文
    clearEventContext('test-session');
    // 清理 chunkBuffer（防止跨测试污染）
    chunkBuffer.clear();
    // 清理注册表
    eventRegistry.clear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    consoleWarnSpy.mockRestore();
  });

  describe('dispatch to registered handler', () => {
    it('should dispatch to registered handler', () => {
      const onStart = vi.fn(() => 'block-1');
      eventRegistry.register('test-event', { onStart });

      const event: BackendEvent = {
        type: 'test-event',
        phase: 'start',
        messageId: 'msg-1',
      };

      handleBackendEvent(mockStore, event);

      // payload 默认为空对象 {}
      expect(onStart).toHaveBeenCalledWith(mockStore, 'msg-1', {});
    });
  });

  describe('warn on unknown event type', () => {
    it('should warn on unknown event type', () => {
      const event: BackendEvent = {
        type: 'unknown-event',
        phase: 'start',
        messageId: 'msg-1',
      };

      handleBackendEvent(mockStore, event);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('No handler registered for event type: "unknown-event"')
      );
    });

    it('should not throw on unknown event type', () => {
      const event: BackendEvent = {
        type: 'unknown-event',
        phase: 'start',
        messageId: 'msg-1',
      };

      expect(() => handleBackendEvent(mockStore, event)).not.toThrow();
    });
  });

  describe('call onStart for start phase', () => {
    it('should call onStart for start phase', () => {
      const onStart = vi.fn(() => 'block-1');
      eventRegistry.register('thinking', { onStart });

      const event: BackendEvent = {
        type: 'thinking',
        phase: 'start',
        messageId: 'msg-1',
        payload: { extra: 'data' },
      };

      handleBackendEvent(mockStore, event);

      expect(onStart).toHaveBeenCalledWith(mockStore, 'msg-1', { extra: 'data' });
    });

    it('should store blockId in context after onStart', () => {
      const onStart = vi.fn(() => 'created-block');
      const onChunk = vi.fn();
      eventRegistry.register('thinking', { onStart, onChunk });

      // Start event
      handleBackendEvent(mockStore, {
        type: 'thinking',
        phase: 'start',
        messageId: 'msg-1',
      });

      // Chunk event without blockId should use context
      handleBackendEvent(mockStore, {
        type: 'thinking',
        phase: 'chunk',
        chunk: 'test content',
      });

      // thinking/content 的 chunk 走 chunkBuffer 批量更新（不会直接调用 handler.onChunk）
      vi.runAllTimers();
      expect(mockStore.updateBlockContent).toHaveBeenCalledWith('created-block', 'test content');
    });
  });

  describe('call onChunk for chunk phase', () => {
    it('should call onChunk for chunk phase', () => {
      const onStart = vi.fn(() => 'block-1');
      const onChunk = vi.fn();
      eventRegistry.register('content', { onStart, onChunk });

      // Start first
      handleBackendEvent(mockStore, {
        type: 'content',
        phase: 'start',
        messageId: 'msg-1',
      });

      // Then chunk
      handleBackendEvent(mockStore, {
        type: 'content',
        phase: 'chunk',
        blockId: 'block-1',
        chunk: 'hello world',
      });

      // content 的 chunk 走 chunkBuffer 批量更新（不会直接调用 handler.onChunk）
      vi.runAllTimers();
      expect(mockStore.updateBlockContent).toHaveBeenCalledWith('block-1', 'hello world');
    });

    it('should use blockId from event if provided', () => {
      const onChunk = vi.fn();
      eventRegistry.register('content', { onChunk });

      handleBackendEvent(mockStore, {
        type: 'content',
        phase: 'chunk',
        blockId: 'explicit-block-id',
        chunk: 'data',
      });

      // content 的 chunk 走 chunkBuffer 批量更新（不会直接调用 handler.onChunk）
      vi.runAllTimers();
      expect(mockStore.updateBlockContent).toHaveBeenCalledWith('explicit-block-id', 'data');
    });
  });

  describe('call onEnd for end phase', () => {
    it('should call onEnd for end phase', () => {
      const onStart = vi.fn(() => 'block-1');
      const onEnd = vi.fn();
      eventRegistry.register('content', { onStart, onEnd });

      // Start first
      handleBackendEvent(mockStore, {
        type: 'content',
        phase: 'start',
        messageId: 'msg-1',
      });

      // Then end
      handleBackendEvent(mockStore, {
        type: 'content',
        phase: 'end',
        blockId: 'block-1',
        result: { success: true },
      });

      expect(onEnd).toHaveBeenCalledWith(mockStore, 'block-1', { success: true });
    });
  });

  describe('call onError for error phase', () => {
    it('should call onError for error phase', () => {
      const onStart = vi.fn(() => 'block-1');
      const onError = vi.fn();
      eventRegistry.register('thinking', { onStart, onError });

      // Start first
      handleBackendEvent(mockStore, {
        type: 'thinking',
        phase: 'start',
        messageId: 'msg-1',
      });

      // Then error
      handleBackendEvent(mockStore, {
        type: 'thinking',
        phase: 'error',
        blockId: 'block-1',
        error: 'Something went wrong',
      });

      expect(onError).toHaveBeenCalledWith(mockStore, 'block-1', 'Something went wrong');
    });
  });

  describe('backend blockId handling (Prompt 8)', () => {
    it('should use backend blockId when provided in start event', () => {
      const backendBlockId = 'blk_backend_provided_123';
      const onStart = vi.fn().mockImplementation((_store, _msgId, _payload, providedBlockId) => {
        return providedBlockId || 'blk_frontend_fallback';
      });
      eventRegistry.register('mcp_tool', { onStart });

      // 发送带 blockId 的 start 事件（多工具并发场景）
      handleBackendEvent(mockStore, {
        type: 'mcp_tool',
        phase: 'start',
        messageId: 'msg-1',
        blockId: backendBlockId,
        payload: { toolName: 'calculator' },
      });

      // 验证 onStart 被调用时传入了后端的 blockId
      expect(onStart).toHaveBeenCalledWith(
        mockStore,
        'msg-1',
        { toolName: 'calculator' },
        backendBlockId
      );
    });

    it('should create blockId when backend does not provide in start event', () => {
      const onStart = vi.fn().mockReturnValue('blk_frontend_created');
      eventRegistry.register('thinking', { onStart });

      // 发送不带 blockId 的 start 事件
      handleBackendEvent(mockStore, {
        type: 'thinking',
        phase: 'start',
        messageId: 'msg-1',
      });

      // 验证 onStart 被调用时没有传入 blockId
      expect(onStart).toHaveBeenCalledWith(
        mockStore,
        'msg-1',
        {}
      );
    });

    it('should handle multiple tools with different backend blockIds', () => {
      const tool1BlockId = 'blk_tool_1';
      const tool2BlockId = 'blk_tool_2';
      const onStart = vi.fn().mockImplementation((_store, _msgId, _payload, providedBlockId) => {
        return providedBlockId || 'fallback';
      });
      const onEnd = vi.fn();
      eventRegistry.register('mcp_tool', { onStart, onEnd });

      // 并发发送两个工具的 start 事件
      handleBackendEvent(mockStore, {
        type: 'mcp_tool',
        phase: 'start',
        messageId: 'msg-1',
        blockId: tool1BlockId,
        payload: { toolName: 'calculator' },
      });

      handleBackendEvent(mockStore, {
        type: 'mcp_tool',
        phase: 'start',
        messageId: 'msg-1',
        blockId: tool2BlockId,
        payload: { toolName: 'web_search' },
      });

      // 验证两个工具都使用了后端提供的 blockId
      expect(onStart).toHaveBeenCalledTimes(2);
      expect(onStart).toHaveBeenNthCalledWith(
        1, mockStore, 'msg-1', { toolName: 'calculator' }, tool1BlockId
      );
      expect(onStart).toHaveBeenNthCalledWith(
        2, mockStore, 'msg-1', { toolName: 'web_search' }, tool2BlockId
      );

      // 验证 end 事件能正确使用各自的 blockId
      handleBackendEvent(mockStore, {
        type: 'mcp_tool',
        phase: 'end',
        blockId: tool1BlockId,
        result: { success: true },
      });

      expect(onEnd).toHaveBeenCalledWith(mockStore, tool1BlockId, { success: true });
    });
  });
});

describe('event helpers', () => {
  it('createStartEvent should create correct structure', () => {
    const event = createStartEvent('thinking', 'msg-1', { extra: 'data' });
    expect(event).toEqual({
      type: 'thinking',
      phase: 'start',
      messageId: 'msg-1',
      payload: { extra: 'data' },
    });
  });

  it('createChunkEvent should create correct structure', () => {
    const event = createChunkEvent('content', 'block-1', 'hello');
    expect(event).toEqual({
      type: 'content',
      phase: 'chunk',
      blockId: 'block-1',
      chunk: 'hello',
    });
  });

  it('createEndEvent should create correct structure', () => {
    const event = createEndEvent('content', 'block-1', { done: true });
    expect(event).toEqual({
      type: 'content',
      phase: 'end',
      blockId: 'block-1',
      result: { done: true },
    });
  });

  it('createErrorEvent should create correct structure', () => {
    const event = createErrorEvent('thinking', 'block-1', 'Network error');
    expect(event).toEqual({
      type: 'thinking',
      phase: 'error',
      blockId: 'block-1',
      error: 'Network error',
    });
  });
});
