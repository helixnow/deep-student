/**
 * Chat V2 - autoSave 中间件单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAutoSaveMiddleware } from '@/chat-v2/core/middleware/autoSave';
import type { ChatStore } from '@/chat-v2/core/types';

// ============================================================================
// Mock Store 创建
// ============================================================================

function createMockStore(
  sessionId: string = 'test-session'
): ChatStore & { _saveCallCount: number } {
  const store = {
    sessionId,
    mode: 'chat',
    sessionStatus: 'idle',
    messageMap: new Map(),
    messageOrder: [],
    blocks: new Map(),
    currentStreamingMessageId: null,
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
    canSend: () => true,
    canEdit: () => true,
    canDelete: () => true,
    canAbort: () => false,
    isBlockLocked: () => false,
    isMessageLocked: () => false,
    // Actions - 只 mock saveSession
    saveSession: vi.fn(() => {
      store._saveCallCount++;
      return Promise.resolve();
    }),
    // 其他 actions 简单 mock
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
    getFeature: () => false,
    setModeState: vi.fn(),
    updateModeState: vi.fn(),
    setInputValue: vi.fn(),
    addAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    setPanelState: vi.fn(),
    initSession: vi.fn(),
    loadSession: vi.fn(),
    getMessage: () => undefined,
    getMessageBlocks: () => [],
    getOrderedMessages: () => [],
    // 辅助属性
    _saveCallCount: 0,
  };
  return store as unknown as ChatStore & { _saveCallCount: number };
}

// ============================================================================
// 测试
// ============================================================================

describe('autoSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('throttle save calls', () => {
    it('should throttle save calls within throttleMs', async () => {
      const autoSave = createAutoSaveMiddleware({ throttleMs: 500 });
      const store = createMockStore();

      // 第一次调用，立即执行
      autoSave.scheduleAutoSave(store);
      expect(store.saveSession).toHaveBeenCalledTimes(1);

      // 第二次调用，应该被节流
      autoSave.scheduleAutoSave(store);
      expect(store.saveSession).toHaveBeenCalledTimes(1);

      // 第三次调用，仍然被节流
      autoSave.scheduleAutoSave(store);
      expect(store.saveSession).toHaveBeenCalledTimes(1);

      // 等待节流时间过去
      await vi.advanceTimersByTimeAsync(500);

      // 应该执行了延迟的保存
      expect(store.saveSession).toHaveBeenCalledTimes(2);

      // 清理
      autoSave.cleanup(store.sessionId);
    });

    it('should execute immediately if enough time has passed', async () => {
      const autoSave = createAutoSaveMiddleware({ throttleMs: 500 });
      const store = createMockStore();

      // 第一次调用
      autoSave.scheduleAutoSave(store);
      expect(store.saveSession).toHaveBeenCalledTimes(1);

      // 等待超过节流时间
      await vi.advanceTimersByTimeAsync(600);

      // 第二次调用，应该立即执行
      autoSave.scheduleAutoSave(store);
      expect(store.saveSession).toHaveBeenCalledTimes(2);

      // 清理
      autoSave.cleanup(store.sessionId);
    });

    it('should cancel previous pending save when new save is scheduled', async () => {
      const autoSave = createAutoSaveMiddleware({ throttleMs: 500 });
      const store = createMockStore();

      // 第一次调用
      autoSave.scheduleAutoSave(store);
      expect(store.saveSession).toHaveBeenCalledTimes(1);

      // 快速连续调用
      autoSave.scheduleAutoSave(store);
      autoSave.scheduleAutoSave(store);
      autoSave.scheduleAutoSave(store);

      // 只有第一次立即执行
      expect(store.saveSession).toHaveBeenCalledTimes(1);

      // 等待节流时间
      await vi.advanceTimersByTimeAsync(500);

      // 只应该再执行一次（最后一个被调度的）
      expect(store.saveSession).toHaveBeenCalledTimes(2);

      // 清理
      autoSave.cleanup(store.sessionId);
    });
  });

  describe('force immediate save when requested', () => {
    it('should force immediate save', async () => {
      const autoSave = createAutoSaveMiddleware({ throttleMs: 500 });
      const store = createMockStore();

      // 第一次调用
      autoSave.scheduleAutoSave(store);
      expect(store.saveSession).toHaveBeenCalledTimes(1);

      // 强制立即保存（即使在节流时间内）
      await autoSave.forceImmediateSave(store);
      expect(store.saveSession).toHaveBeenCalledTimes(2);

      // 清理
      autoSave.cleanup(store.sessionId);
    });

    it('should cancel pending save when force save is called', async () => {
      const autoSave = createAutoSaveMiddleware({ throttleMs: 500 });
      const store = createMockStore();

      // 调度一个延迟保存
      autoSave.scheduleAutoSave(store);
      autoSave.scheduleAutoSave(store);

      // 应该有一个待执行的保存
      expect(autoSave.hasPendingSave(store.sessionId)).toBe(true);

      // 强制立即保存
      await autoSave.forceImmediateSave(store);

      // 待执行的保存应该被取消
      expect(autoSave.hasPendingSave(store.sessionId)).toBe(false);

      // 等待原本的延迟时间
      await vi.advanceTimersByTimeAsync(500);

      // saveSession 只被调用了 2 次（初始 + 强制）
      expect(store.saveSession).toHaveBeenCalledTimes(2);

      // 清理
      autoSave.cleanup(store.sessionId);
    });
  });

  describe('hasPendingSave', () => {
    it('should return true when there is a pending save', () => {
      const autoSave = createAutoSaveMiddleware({ throttleMs: 500 });
      const store = createMockStore();

      // 第一次立即执行
      autoSave.scheduleAutoSave(store);

      // 第二次被延迟
      autoSave.scheduleAutoSave(store);

      expect(autoSave.hasPendingSave(store.sessionId)).toBe(true);

      // 清理
      autoSave.cleanup(store.sessionId);
    });

    it('should return false when there is no pending save', () => {
      const autoSave = createAutoSaveMiddleware({ throttleMs: 500 });
      const store = createMockStore();

      expect(autoSave.hasPendingSave(store.sessionId)).toBe(false);
    });
  });

  describe('cancelPendingSave', () => {
    it('should cancel pending save', async () => {
      const autoSave = createAutoSaveMiddleware({ throttleMs: 500 });
      const store = createMockStore();

      // 调度延迟保存
      autoSave.scheduleAutoSave(store);
      autoSave.scheduleAutoSave(store);

      expect(autoSave.hasPendingSave(store.sessionId)).toBe(true);

      // 取消
      autoSave.cancelPendingSave(store.sessionId);

      expect(autoSave.hasPendingSave(store.sessionId)).toBe(false);

      // 等待原本的延迟时间
      await vi.advanceTimersByTimeAsync(500);

      // 只有第一次立即执行的保存
      expect(store.saveSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('multiple sessions', () => {
    it('should handle multiple sessions independently', async () => {
      const autoSave = createAutoSaveMiddleware({ throttleMs: 500 });
      const store1 = createMockStore('session-1');
      const store2 = createMockStore('session-2');

      // 两个会话同时调度保存
      autoSave.scheduleAutoSave(store1);
      autoSave.scheduleAutoSave(store2);

      expect(store1.saveSession).toHaveBeenCalledTimes(1);
      expect(store2.saveSession).toHaveBeenCalledTimes(1);

      // 清理
      autoSave.cleanup(store1.sessionId);
      autoSave.cleanup(store2.sessionId);
    });
  });
});
