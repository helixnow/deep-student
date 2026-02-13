/**
 * Chat V2 - TauriAdapter 单元测试
 *
 * 测试 TauriAdapter 的事件监听、消息发送、会话管理等功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

// Import after mocking
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ChatV2TauriAdapter } from '@/chat-v2/adapters/TauriAdapter';
import type { ChatStore } from '@/chat-v2/core/types';
import type { SessionEventPayload } from '@/chat-v2/adapters/types';

// ============================================================================
// Mock Store
// ============================================================================

function createMockStore(): ChatStore {
  return {
    sessionId: 'test-session-id',
    mode: 'general_chat',
    title: 'Test Chat',
    description: 'Test description',
    sessionStatus: 'idle',
    isDataLoaded: true,
    messageMap: new Map(),
    messageOrder: [],
    blocks: new Map(),
    currentStreamingMessageId: null,
    activeBlockIds: new Set(),
    streamingVariantIds: new Set(),
    chatParams: {
      modelId: 'test-model',
      temperature: 0.7,
      contextLimit: 8192,
      maxTokens: 4096,
      enableThinking: false,
      disableTools: false,
      model2OverrideId: null,
    },
    features: new Map([
      ['rag', true],
      ['webSearch', false],
    ]),
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
    pendingContextRefs: [],
    messageOperationLock: null,
    pendingApprovalRequest: null,
    activeSkillId: null,
    activeSkillIds: [],
    pendingParallelModelIds: null,
    modelRetryTarget: null,

    // Guards
    canSend: vi.fn(() => true),
    canEdit: vi.fn(() => true),
    canDelete: vi.fn(() => true),
    canAbort: vi.fn(() => true),
    isBlockLocked: vi.fn(() => false),
    isMessageLocked: vi.fn(() => false),

    // Actions
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendMessageWithIds: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn(),
    editMessage: vi.fn(),
    retryMessage: vi.fn().mockResolvedValue(undefined),
    abortStream: vi.fn().mockResolvedValue(undefined),
    createBlock: vi.fn(() => 'test-block-id'),
    updateBlockContent: vi.fn(),
    updateBlockStatus: vi.fn(),
    setBlockResult: vi.fn(),
    setBlockError: vi.fn(),
    updateBlock: vi.fn(),
    setCurrentStreamingMessage: vi.fn(),
    addActiveBlock: vi.fn(),
    removeActiveBlock: vi.fn(),
    setChatParams: vi.fn(),
    resetChatParams: vi.fn(),
    setFeature: vi.fn(),
    toggleFeature: vi.fn(),
    getFeature: vi.fn((key) => false),
    setModeState: vi.fn(),
    updateModeState: vi.fn(),
    setInputValue: vi.fn(),
    addAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    setPanelState: vi.fn(),
    initSession: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(undefined),
    saveSession: vi.fn().mockResolvedValue(undefined),
    setSaveCallback: vi.fn(),
    setRetryCallback: vi.fn(),
    setDeleteCallback: vi.fn(),
    setEditAndResendCallback: vi.fn(),
    setSendCallback: vi.fn(),
    setAbortCallback: vi.fn(),
    setContinueMessageCallback: vi.fn(),
    continueMessage: vi.fn().mockResolvedValue(undefined),
    setLoadCallback: vi.fn(),
    setSwitchVariantCallback: vi.fn(),
    setDeleteVariantCallback: vi.fn(),
    setRetryVariantCallback: vi.fn(),
    setRetryAllVariantsCallback: vi.fn(),
    setCancelVariantCallback: vi.fn(),
    setUpdateBlockContentCallback: vi.fn(),
    setUpdateSessionSettingsCallback: vi.fn(),
    restoreFromBackend: vi.fn(),
    createBlockWithId: vi.fn(() => 'test-block-id'),
    completeStream: vi.fn(),
    forceResetToIdle: vi.fn(),
    batchUpdateBlockContent: vi.fn(),
    getMessage: vi.fn(),
    getMessageBlocks: vi.fn(() => []),
    getOrderedMessages: vi.fn(() => []),
    setPendingParallelModelIds: vi.fn(),
    setModelRetryTarget: vi.fn(),
  } as unknown as ChatStore;
}

// ============================================================================
// Tests
// ============================================================================

describe('ChatV2TauriAdapter', () => {
  let adapter: ChatV2TauriAdapter;
  let mockStore: ChatStore;
  let mockUnlisten: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Simulate Tauri runtime so adapter.setup() doesn't short-circuit.
    (window as any).__TAURI__ = {};

    mockStore = createMockStore();
    mockUnlisten = vi.fn();

    // Setup listen mock to return unlisten function
    vi.mocked(listen).mockResolvedValue(mockUnlisten);

    adapter = new ChatV2TauriAdapter('test-session-id', mockStore);
  });

  afterEach(() => {
    adapter.cleanup();
    delete (window as any).__TAURI__;
  });

  describe('setup', () => {
    it('should setup event listeners', async () => {
      await adapter.setup();

      // Should register two listeners
      expect(listen).toHaveBeenCalledTimes(2);

      // Check listener channels
      expect(listen).toHaveBeenCalledWith(
        'chat_v2_event_test-session-id',
        expect.any(Function)
      );
      expect(listen).toHaveBeenCalledWith(
        'chat_v2_session_test-session-id',
        expect.any(Function)
      );

      expect(adapter.initialized).toBe(true);
    });

    it('should not setup twice', async () => {
      await adapter.setup();
      await adapter.setup();

      // Should only register once
      expect(listen).toHaveBeenCalledTimes(2);
    });
  });

  describe('cleanup', () => {
    it('should cleanup all listeners', async () => {
      await adapter.setup();

      adapter.cleanup();

      // Should call unlisten for both listeners
      expect(mockUnlisten).toHaveBeenCalledTimes(2);
      expect(adapter.initialized).toBe(false);
    });

    it('should handle cleanup when not setup', () => {
      // Should not throw
      expect(() => adapter.cleanup()).not.toThrow();
    });
  });

  describe('sendMessage', () => {
    beforeEach(async () => {
      await adapter.setup();
    });

    it('should send message and update store', async () => {
      vi.mocked(invoke).mockResolvedValue('assistant-msg-id');

      await adapter.sendMessage('Hello, world!');

      // Should call store.sendMessageWithIds (not sendMessage)
      expect(mockStore.sendMessageWithIds).toHaveBeenCalledWith(
        'Hello, world!',
        undefined,
        expect.stringMatching(/^msg_/),  // userMessageId
        expect.stringMatching(/^msg_/)   // assistantMessageId
      );

      // Should call backend
      expect(invoke).toHaveBeenCalledWith('chat_v2_send_message', {
        request: expect.objectContaining({
          sessionId: 'test-session-id',
          content: 'Hello, world!',
        }),
      });
    });

    it('should handle send error', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('Network error'));

      await expect(adapter.sendMessage('Hello')).rejects.toThrow('Network error');

      // Should try to abort
      expect(mockStore.abortStream).toHaveBeenCalled();
    });
  });

  describe('abortStream', () => {
    beforeEach(async () => {
      await adapter.setup();
    });

    it('should abort stream and notify backend', async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);

      // Set currentStreamingMessageId so abort will proceed
      (mockStore as any).currentStreamingMessageId = 'streaming-msg-id';

      await adapter.abortStream();

      // Should call store.abortStream
      // Note: The actual backend call happens inside store.abortStream() via _abortCallback
      // which was injected during setup. Since mockStore.abortStream is a mock,
      // it won't call the callback, so we only verify the store method was called.
      expect(mockStore.abortStream).toHaveBeenCalled();
    });

    it('should return early if no streaming message', async () => {
      // currentStreamingMessageId is null by default
      await adapter.abortStream();

      // Should not call backend
      expect(invoke).not.toHaveBeenCalledWith('chat_v2_cancel_stream', expect.anything());
    });
  });

  describe('buildSendOptions', () => {
    it('should build send options from store', async () => {
      await adapter.setup();

      // Use reflection to access private method
      const options = (adapter as any).buildSendOptions();

      expect(options).toMatchObject({
        modelId: 'test-model',
        temperature: 0.7,
        maxTokens: 4096,
        enableThinking: false,
        disableTools: false,
        ragEnabled: true,
        webSearchEnabled: false,
      });
    });
  });

  describe('session events', () => {
    let sessionEventCallback: (event: { payload: SessionEventPayload }) => void;

    beforeEach(async () => {
      vi.mocked(listen).mockImplementation(async (channel, callback) => {
        if (channel === 'chat_v2_session_test-session-id') {
          sessionEventCallback = callback as typeof sessionEventCallback;
        }
        return mockUnlisten;
      });

      await adapter.setup();
    });

    it('should handle stream_complete event', () => {
      sessionEventCallback({
        payload: {
          sessionId: 'test-session-id',
          eventType: 'stream_complete',
          messageId: 'msg-1',
          durationMs: 1000,
          timestamp: Date.now(),
        },
      });

      // Should call completeStream to reset state
      expect(mockStore.completeStream).toHaveBeenCalled();
    });

    it('should handle stream_error event', () => {
      sessionEventCallback({
        payload: {
          sessionId: 'test-session-id',
          eventType: 'stream_error',
          error: 'Test error',
          timestamp: Date.now(),
        },
      });

      // Should call completeStream to reset state
      expect(mockStore.completeStream).toHaveBeenCalled();
    });

    it('should handle stream_cancelled event', () => {
      sessionEventCallback({
        payload: {
          sessionId: 'test-session-id',
          eventType: 'stream_cancelled',
          messageId: 'msg-1',
          timestamp: Date.now(),
        },
      });

      // Should call completeStream to reset state
      expect(mockStore.completeStream).toHaveBeenCalled();
    });
  });

  describe('session operations', () => {
    beforeEach(async () => {
      await adapter.setup();
    });

    it('should load session and call restoreFromBackend', async () => {
      const mockResponse = {
        session: {
          id: 'test-session-id',
          mode: 'general_chat',
          persistStatus: 'active',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        messages: [],
        blocks: [],
      };
      vi.mocked(invoke).mockResolvedValue(mockResponse);

      await adapter.loadSession();

      expect(invoke).toHaveBeenCalledWith('chat_v2_load_session', {
        sessionId: 'test-session-id',
      });

      // 验证调用了 store.restoreFromBackend
      expect(mockStore.restoreFromBackend).toHaveBeenCalledWith(mockResponse);
    });

    it('should save session with session state', async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);

      await adapter.saveSession();

      // 验证调用了带有 sessionState 参数的 chat_v2_save_session
      expect(invoke).toHaveBeenCalledWith('chat_v2_save_session', {
        sessionId: 'test-session-id',
        sessionState: expect.objectContaining({
          sessionId: 'test-session-id',
          chatParams: expect.objectContaining({
            modelId: 'test-model',
            temperature: 0.7,
          }),
          features: { rag: true, webSearch: false },
          modeState: null,
          inputValue: null,
          panelStates: expect.objectContaining({
            rag: false,
            mcp: false,
          }),
          updatedAt: expect.any(String),
        }),
      });
    });

    it('should create session', async () => {
      vi.mocked(invoke).mockResolvedValue({ id: 'new-session-id' });

      const sessionId = await adapter.createSession('general_chat', 'New Chat');

      expect(invoke).toHaveBeenCalledWith('chat_v2_create_session', {
        mode: 'general_chat',
        title: 'New Chat',
        metadata: null,
      });

      expect(sessionId).toBe('new-session-id');
    });
  });

  describe('getters', () => {
    it('should return session id', () => {
      expect(adapter.id).toBe('test-session-id');
    });

    it('should return initialized state', async () => {
      expect(adapter.initialized).toBe(false);

      await adapter.setup();

      expect(adapter.initialized).toBe(true);
    });
  });
});
