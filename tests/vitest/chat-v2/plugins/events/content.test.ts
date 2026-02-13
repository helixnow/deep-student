/**
 * Chat V2 - content 事件处理插件单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eventRegistry } from '@/chat-v2/registry/eventRegistry';
import type { ChatStore } from '@/chat-v2/core/types';

// 导入插件（触发自动注册）
import '@/chat-v2/plugins/events/content';

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
    createBlock: vi.fn(() => 'content-block-1'),
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

describe('ContentEventHandler', () => {
  let mockStore: ChatStore;

  beforeEach(() => {
    mockStore = createMockStore();
  });

  it('should be registered in eventRegistry', () => {
    expect(eventRegistry.has('content')).toBe(true);
  });

  describe('onStart', () => {
    it('should create content block on start', () => {
      const handler = eventRegistry.get('content');
      expect(handler).toBeDefined();
      expect(handler!.onStart).toBeDefined();

      const blockId = handler!.onStart!(mockStore, 'msg-1', undefined);

      expect(mockStore.createBlock).toHaveBeenCalledWith('msg-1', 'content');
      expect(blockId).toBe('content-block-1');
    });

    it('should return the created block id', () => {
      const handler = eventRegistry.get('content');
      const blockId = handler!.onStart!(mockStore, 'msg-1', undefined);

      // Store 内部会自动处理 activeBlockIds
      expect(blockId).toBe('content-block-1');
    });
  });

  describe('onChunk', () => {
    it('should update block content on chunk', () => {
      const handler = eventRegistry.get('content');
      expect(handler!.onChunk).toBeDefined();

      handler!.onChunk!(mockStore, 'content-block-1', 'Hello, world!');

      expect(mockStore.updateBlockContent).toHaveBeenCalledWith(
        'content-block-1',
        'Hello, world!'
      );
    });

    it('should handle empty chunk', () => {
      const handler = eventRegistry.get('content');
      handler!.onChunk!(mockStore, 'content-block-1', '');

      expect(mockStore.updateBlockContent).toHaveBeenCalledWith('content-block-1', '');
    });
  });

  describe('onEnd', () => {
    it('should set success status on end', () => {
      const handler = eventRegistry.get('content');
      expect(handler!.onEnd).toBeDefined();

      handler!.onEnd!(mockStore, 'content-block-1', undefined);

      // Store 内部会自动从 activeBlockIds 移除
      expect(mockStore.updateBlockStatus).toHaveBeenCalledWith('content-block-1', 'success');
    });
  });

  describe('onError', () => {
    it('should set error on block', () => {
      const handler = eventRegistry.get('content');
      expect(handler!.onError).toBeDefined();

      handler!.onError!(mockStore, 'content-block-1', 'Network error');

      // Store 内部会自动设置错误状态并从 activeBlockIds 移除
      expect(mockStore.setBlockError).toHaveBeenCalledWith('content-block-1', 'Network error');
    });
  });
});
