/**
 * Chat V2 - Textbook 模式单元测试
 *
 * 测试教材导学模式的功能
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { modeRegistry } from '@/chat-v2/registry/modeRegistry';
import type { ChatStore } from '@/chat-v2/core/types';
import type { TextbookModeState } from '@/chat-v2/plugins/modes/textbook';
import {
  createInitialTextbookModeState,
  reloadTextbook,
} from '@/chat-v2/plugins/modes/textbook';

// ============================================================================
// Mock Store 工厂
// ============================================================================

function createMockStore(overrides: Partial<ChatStore> = {}): ChatStore {
  const modeState: TextbookModeState = {
    textbookPath: '',
    pages: [],
    currentPage: 1,
    totalPages: 0,
    loadingStatus: 'idle',
    loadingError: null,
  };

  const attachments: Array<{
    id: string;
    name: string;
    type: 'image' | 'document' | 'audio' | 'video' | 'other';
    mimeType: string;
    size: number;
    previewUrl?: string;
    status: 'pending' | 'uploading' | 'ready' | 'error';
  }> = [];

  return {
    sessionId: 'test-session',
    mode: 'textbook',
    sessionStatus: 'idle',
    messageMap: new Map(),
    messageOrder: [],
    blocks: new Map(),
    currentStreamingMessageId: null,
    activeBlockIds: new Set(),
    chatParams: {
      modelId: 'test-model',
      temperature: 0.7,
      contextLimit: 8192,
      maxTokens: 4096,
      enableThinking: false,
      disableTools: false,
      model2OverrideId: null,
    },
    features: new Map(),
    modeState: modeState as unknown as Record<string, unknown>,
    inputValue: '',
    attachments,
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
    canSend: () => true,
    canEdit: () => true,
    canDelete: () => true,
    canAbort: () => false,
    isBlockLocked: () => false,
    isMessageLocked: () => false,
    // Actions
    sendMessage: vi.fn(),
    deleteMessage: vi.fn(),
    editMessage: vi.fn(),
    retryMessage: vi.fn(),
    abortStream: vi.fn(),
    createBlock: vi.fn().mockReturnValue('block-id'),
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
    getFeature: vi.fn().mockReturnValue(false),
    setModeState: vi.fn((state) => {
      Object.assign(modeState, state);
    }),
    updateModeState: vi.fn((updates) => {
      Object.assign(modeState, updates);
    }),
    setInputValue: vi.fn(),
    addAttachment: vi.fn((attachment) => {
      attachments.push(attachment);
    }),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(() => {
      attachments.length = 0;
    }),
    setPanelState: vi.fn(),
    initSession: vi.fn(),
    loadSession: vi.fn(),
    saveSession: vi.fn(),
    getMessage: vi.fn(),
    getMessageBlocks: vi.fn().mockReturnValue([]),
    getOrderedMessages: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as ChatStore;
}

// ============================================================================
// 测试用例
// ============================================================================

describe('TextbookModePlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('registry', () => {
    it('should NOT register textbook as a standalone mode', async () => {
      // textbook.ts 已明确声明：textbook 不再作为独立模式注册
      await import('@/chat-v2/plugins/modes/textbook');
      expect(modeRegistry.has('textbook')).toBe(false);
    });
  });

  describe('createInitialTextbookModeState', () => {
    it('should create initial state', () => {
      expect(createInitialTextbookModeState('/a.pdf', 2)).toEqual({
        textbookPath: '/a.pdf',
        pages: [],
        currentPage: 2,
        totalPages: 0,
        loadingStatus: 'idle',
        loadingError: null,
      });
    });
  });

  describe('reloadTextbook', () => {
    it('should set loading then success with mock pages', async () => {
      vi.useFakeTimers();

      const mockStore = createMockStore();
      const modeState = mockStore.modeState as unknown as TextbookModeState;
      modeState.textbookPath = '/test/textbook.pdf';

      const promise = reloadTextbook(mockStore);
      await vi.runAllTimersAsync();
      await promise;

      expect(mockStore.updateModeState).toHaveBeenCalledWith(
        expect.objectContaining({ loadingStatus: 'loading' })
      );
      expect(mockStore.updateModeState).toHaveBeenCalledWith(
        expect.objectContaining({
          loadingStatus: 'success',
          totalPages: 10,
        })
      );
    });

    it('should throw when no textbookPath is available', async () => {
      const mockStore = createMockStore();
      const modeState = mockStore.modeState as unknown as TextbookModeState;
      modeState.textbookPath = '';

      await expect(reloadTextbook(mockStore)).rejects.toBeDefined();
    });
  });

  describe('setCurrentPage', () => {
    it('should set currentPage via updateModeState', async () => {
      const { setCurrentPage } = await import('@/chat-v2/plugins/modes/textbook');

      const mockStore = createMockStore();
      const modeState = mockStore.modeState as unknown as TextbookModeState;
      modeState.totalPages = 10;
      modeState.currentPage = 1;

      setCurrentPage(mockStore, 5);

      expect(mockStore.updateModeState).toHaveBeenCalledWith({ currentPage: 5 });
    });

    it('should clamp page number to valid range', async () => {
      const { setCurrentPage } = await import('@/chat-v2/plugins/modes/textbook');

      const mockStore = createMockStore();
      const modeState = mockStore.modeState as unknown as TextbookModeState;
      modeState.totalPages = 10;
      modeState.currentPage = 1;

      // 超出范围的页码应该被限制
      setCurrentPage(mockStore, 100);

      // 应该被限制到 totalPages
      expect(mockStore.updateModeState).toHaveBeenCalledWith({ currentPage: 10 });
    });

    it('should not set page below 1', async () => {
      const { setCurrentPage } = await import('@/chat-v2/plugins/modes/textbook');

      const mockStore = createMockStore();
      const modeState = mockStore.modeState as unknown as TextbookModeState;
      modeState.totalPages = 10;

      setCurrentPage(mockStore, -5);

      expect(mockStore.updateModeState).toHaveBeenCalledWith({ currentPage: 1 });
    });
  });

  describe('helper functions', () => {
    it('goToPreviousPage should decrease page number', async () => {
      const { goToPreviousPage } = await import('@/chat-v2/plugins/modes/textbook');

      const mockStore = createMockStore();
      const modeState = mockStore.modeState as unknown as TextbookModeState;
      modeState.totalPages = 10;
      modeState.currentPage = 5;

      goToPreviousPage(mockStore);

      expect(mockStore.updateModeState).toHaveBeenCalledWith({ currentPage: 4 });
    });

    it('goToNextPage should increase page number', async () => {
      const { goToNextPage } = await import('@/chat-v2/plugins/modes/textbook');

      const mockStore = createMockStore();
      const modeState = mockStore.modeState as unknown as TextbookModeState;
      modeState.totalPages = 10;
      modeState.currentPage = 5;

      goToNextPage(mockStore);

      expect(mockStore.updateModeState).toHaveBeenCalledWith({ currentPage: 6 });
    });

    it('getCurrentPageImageUrl should return correct URL', async () => {
      const { getCurrentPageImageUrl } = await import('@/chat-v2/plugins/modes/textbook');

      const mockStore = createMockStore();
      const modeState = mockStore.modeState as unknown as TextbookModeState;
      modeState.pages = [
        { pageNum: 1, imageUrl: 'url-1.png' },
        { pageNum: 2, imageUrl: 'url-2.png' },
      ];
      modeState.currentPage = 2;

      const url = getCurrentPageImageUrl(mockStore);
      expect(url).toBe('url-2.png');
    });

    it('isTextbookLoaded should return correct status', async () => {
      const { isTextbookLoaded } = await import('@/chat-v2/plugins/modes/textbook');

      const mockStore = createMockStore();
      const modeState = mockStore.modeState as unknown as TextbookModeState;

      modeState.loadingStatus = 'loading';
      expect(isTextbookLoaded(mockStore)).toBe(false);

      modeState.loadingStatus = 'success';
      expect(isTextbookLoaded(mockStore)).toBe(true);
    });
  });
});
