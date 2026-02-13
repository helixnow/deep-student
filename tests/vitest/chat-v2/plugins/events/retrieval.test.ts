/**
 * Chat V2 - retrieval 事件处理插件单元测试
 *
 * 测试知识检索事件处理器：rag, memory, web_search, multimodal_rag
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eventRegistry } from '@/chat-v2/registry/eventRegistry';
import type { ChatStore } from '@/chat-v2/core/types';

// 导入插件（触发自动注册）
import '@/chat-v2/plugins/events/retrieval';
import {
  RETRIEVAL_TYPES,
  ragEventHandler,
  memoryEventHandler,
  webSearchEventHandler,
  multimodalRagEventHandler,
} from '@/chat-v2/plugins/events/retrieval';

// ============================================================================
// Mock Store 创建
// ============================================================================

function createMockStore(): ChatStore {
  return {
    sessionId: 'test-session',
    mode: 'chat',
    sessionStatus: 'streaming',
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
      enableThinking: true,
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
    canSend: vi.fn(() => false),
    canEdit: vi.fn(() => false),
    canDelete: vi.fn(() => false),
    canAbort: vi.fn(() => true),
    isBlockLocked: vi.fn(() => true),
    isMessageLocked: vi.fn(() => true),
    // Actions
    sendMessage: vi.fn(),
    deleteMessage: vi.fn(),
    editMessage: vi.fn(),
    retryMessage: vi.fn(),
    abortStream: vi.fn(),
    createBlock: vi.fn((messageId: string, type: string) => `${type}-block-1`),
    createBlockWithId: vi.fn(
      (messageId: string, type: string, blockId: string) => blockId
    ),
    updateBlock: vi.fn(),
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
    getMessage: vi.fn(),
    getMessageBlocks: vi.fn(() => []),
    getOrderedMessages: vi.fn(() => []),
  } as unknown as ChatStore;
}

// ============================================================================
// 测试
// ============================================================================

describe('RetrievalEventHandlers', () => {
  let mockStore: ChatStore;

  beforeEach(() => {
    mockStore = createMockStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should register all retrieval types in eventRegistry', () => {
    expect(eventRegistry.has('rag')).toBe(true);
    expect(eventRegistry.has('memory')).toBe(true);
    expect(eventRegistry.has('web_search')).toBe(true);
    expect(eventRegistry.has('multimodal_rag')).toBe(true);
  });

  it('should export all handlers', () => {
    expect(ragEventHandler).toBeDefined();
    expect(memoryEventHandler).toBeDefined();
    expect(webSearchEventHandler).toBeDefined();
    expect(multimodalRagEventHandler).toBeDefined();
  });

  it('should export RETRIEVAL_TYPES constant', () => {
    expect(RETRIEVAL_TYPES).toEqual(['rag', 'memory', 'web_search', 'multimodal_rag']);
  });

  // ============================================================================
  // RAG 事件处理器测试
  // ============================================================================

  describe('rag handler', () => {
    it('should create rag block on start', () => {
      const handler = eventRegistry.get('rag');
      expect(handler).toBeDefined();
      expect(handler!.onStart).toBeDefined();

      const blockId = handler!.onStart!(mockStore, 'msg-1', { blockType: 'rag' });

      expect(mockStore.createBlock).toHaveBeenCalledWith('msg-1', 'rag');
      expect(blockId).toBe('rag-block-1');
    });

    it('should set result on end', () => {
      const handler = eventRegistry.get('rag');
      const mockResult = {
        sources: [
          { id: '1', type: 'rag', title: 'Doc 1', snippet: 'Content 1' },
        ],
        query: 'test query',
        totalResults: 1,
      };

      handler!.onEnd!(mockStore, 'rag-block-1', mockResult);

      expect(mockStore.updateBlock).toHaveBeenCalledWith('rag-block-1', {
        toolOutput: mockResult,
      });
      expect(mockStore.updateBlockStatus).toHaveBeenCalledWith(
        'rag-block-1',
        'success'
      );
    });

    it('should mark error on abort', () => {
      const handler = eventRegistry.get('rag');

      handler!.onError!(mockStore, 'rag-block-1', 'Search failed');

      expect(mockStore.setBlockError).toHaveBeenCalledWith('rag-block-1', 'Search failed');
    });

    it('should not update content on chunk (retrieval does not support streaming)', () => {
      const handler = eventRegistry.get('rag');
      expect(handler!.onChunk).toBeDefined();

      handler!.onChunk!(mockStore, 'rag-block-1', 'some chunk');

      expect(mockStore.updateBlockContent).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Memory 事件处理器测试
  // ============================================================================

  describe('memory handler', () => {
    it('should create memory block on start', () => {
      const handler = eventRegistry.get('memory');

      const blockId = handler!.onStart!(mockStore, 'msg-1', { blockType: 'memory' });

      expect(mockStore.createBlock).toHaveBeenCalledWith('msg-1', 'memory');
      expect(blockId).toBe('memory-block-1');
    });

    it('should set result with memory type on end', () => {
      const handler = eventRegistry.get('memory');
      const mockResult = {
        sources: [
          { id: '1', type: 'memory', title: 'Past conversation', snippet: 'User mentioned...' },
        ],
        memoryType: 'conversation',
      };

      handler!.onEnd!(mockStore, 'memory-block-1', mockResult);

      expect(mockStore.updateBlock).toHaveBeenCalledWith('memory-block-1', {
        toolOutput: mockResult,
      });
      expect(mockStore.updateBlockStatus).toHaveBeenCalledWith(
        'memory-block-1',
        'success'
      );
    });

    it('should mark error on failure', () => {
      const handler = eventRegistry.get('memory');

      handler!.onError!(mockStore, 'memory-block-1', 'Memory retrieval failed');

      expect(mockStore.setBlockError).toHaveBeenCalledWith('memory-block-1', 'Memory retrieval failed');
    });
  });

  // ============================================================================
  // WebSearch 事件处理器测试
  // ============================================================================

  describe('web_search handler', () => {
    it('should create web_search block on start', () => {
      const handler = eventRegistry.get('web_search');

      const blockId = handler!.onStart!(mockStore, 'msg-1', { blockType: 'web_search' });

      expect(mockStore.createBlock).toHaveBeenCalledWith('msg-1', 'web_search');
      expect(blockId).toBe('web_search-block-1');
    });

    it('should set result with search engine info on end', () => {
      const handler = eventRegistry.get('web_search');
      const mockResult = {
        sources: [
          { id: '1', type: 'web_search', title: 'Search Result 1', snippet: 'Found content...', url: 'https://example.com' },
        ],
        searchEngine: 'Google',
        query: 'test search',
        totalResults: 100,
      };

      handler!.onEnd!(mockStore, 'web_search-block-1', mockResult);

      expect(mockStore.updateBlock).toHaveBeenCalledWith('web_search-block-1', {
        toolOutput: mockResult,
      });
      expect(mockStore.updateBlockStatus).toHaveBeenCalledWith(
        'web_search-block-1',
        'success'
      );
    });

    it('should mark error on failure', () => {
      const handler = eventRegistry.get('web_search');

      handler!.onError!(mockStore, 'web_search-block-1', 'Web search failed');

      expect(mockStore.setBlockError).toHaveBeenCalledWith('web_search-block-1', 'Web search failed');
    });
  });

  // ============================================================================
  // 通用行为测试
  // ============================================================================

  describe('common behavior', () => {
    it.each(RETRIEVAL_TYPES)('%s handler should have all lifecycle methods', (type) => {
      const handler = eventRegistry.get(type);
      expect(handler).toBeDefined();
      expect(handler!.onStart).toBeDefined();
      expect(handler!.onChunk).toBeDefined();
      expect(handler!.onEnd).toBeDefined();
      expect(handler!.onError).toBeDefined();
    });

    it.each(RETRIEVAL_TYPES)('%s handler should create block of correct type', (type) => {
      const handler = eventRegistry.get(type);
      handler!.onStart!(mockStore, 'msg-test', { blockType: type });

      expect(mockStore.createBlock).toHaveBeenCalledWith('msg-test', type);
    });
  });
});
