/**
 * Chat V2 - Store 单元测试
 *
 * 测试 createChatStore 的核心功能
 * 验证 Prompt 8 要求：
 * - store.retryMessage() 状态设置
 * - store.saveSession() 回调执行
 * - sendMessageWithIds 使用指定 ID
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import i18n from 'i18next';
import { createChatStore } from '@/chat-v2/core/store/createChatStore';
import type { ChatStore } from '@/chat-v2/core/types';
import type { StoreApi } from 'zustand';

describe('ChatStore Actions', () => {
  let storeApi: StoreApi<ChatStore>;

  beforeEach(() => {
    storeApi = createChatStore('sess_test_123');
  });

  describe('retryMessage', () => {
    it('should set streaming status when retrying with callback', async () => {
      // 创建一个助手消息
      const assistantMsgId = 'msg_assistant_123';
      const mockRetryCallback = vi.fn().mockResolvedValue({
        success: true,
        messageId: assistantMsgId,
      });

      storeApi.setState({
        messageMap: new Map([
          [
            assistantMsgId,
            {
              id: assistantMsgId,
              role: 'assistant',
              blockIds: [],
              timestamp: Date.now(),
            },
          ],
        ]),
        messageOrder: [assistantMsgId],
        sessionStatus: 'idle',
        currentStreamingMessageId: null,
      });

      // 必须先设置 retryCallback
      storeApi.getState().setRetryCallback(mockRetryCallback);

      // 执行重试
      await storeApi.getState().retryMessage(assistantMsgId);

      // 验证状态变为 streaming
      expect(storeApi.getState().sessionStatus).toBe('streaming');
    });

    it('should not set streaming when no callback is set', async () => {
      const assistantMsgId = 'msg_assistant_no_cb';
      storeApi.setState({
        messageMap: new Map([
          [
            assistantMsgId,
            {
              id: assistantMsgId,
              role: 'assistant',
              blockIds: [],
              timestamp: Date.now(),
            },
          ],
        ]),
        messageOrder: [assistantMsgId],
        sessionStatus: 'idle',
        currentStreamingMessageId: null,
      });

      // 不设置 callback，直接重试
      storeApi.getState().setRetryCallback(null);
      await storeApi.getState().retryMessage(assistantMsgId);

      // 验证状态仍然是 idle（因为没有 callback）
      expect(storeApi.getState().sessionStatus).toBe('idle');
    });

    it('should throw error when retrying locked message', async () => {
      const assistantMsgId = 'msg_assistant_456';
      const blockId = 'blk_active_123';
      const mockRetryCallback = vi.fn().mockResolvedValue({
        success: true,
        messageId: assistantMsgId,
      });

      storeApi.setState({
        messageMap: new Map([
          [
            assistantMsgId,
            {
              id: assistantMsgId,
              role: 'assistant',
              blockIds: [blockId], // 消息有一个块
              timestamp: Date.now(),
            },
          ],
        ]),
        messageOrder: [assistantMsgId],
        sessionStatus: 'streaming',
        currentStreamingMessageId: 'msg_other',
        activeBlockIds: new Set([blockId]), // 块正在活跃中，所以消息被锁定
      });

      // 设置 callback
      storeApi.getState().setRetryCallback(mockRetryCallback);

      // 验证抛出错误（消息被锁定因为有活跃的块）
      await expect(
        storeApi.getState().retryMessage(assistantMsgId)
      ).rejects.toThrow(
        i18n.t('chatV2:store.cannotRetryLocked', 'Cannot retry locked message')
      );
    });

    it('should throw error when message not found', async () => {
      storeApi.setState({
        messageMap: new Map(),
        sessionStatus: 'idle',
      });

      await expect(
        storeApi.getState().retryMessage('msg_nonexistent')
      ).rejects.toThrow(
        i18n.t('chatV2:store.messageNotFound', 'Message not found')
      );
    });

    it('should throw error when trying to retry user message', async () => {
      const userMsgId = 'msg_user_123';
      storeApi.setState({
        messageMap: new Map([
          [
            userMsgId,
            {
              id: userMsgId,
              role: 'user',
              blockIds: [],
              timestamp: Date.now(),
            },
          ],
        ]),
        messageOrder: [userMsgId],
        sessionStatus: 'idle',
      });

      await expect(
        storeApi.getState().retryMessage(userMsgId)
      ).rejects.toThrow(
        i18n.t('chatV2:store.canOnlyRetryAssistant', 'Can only retry assistant messages')
      );
    });

    it('should call retry callback when set', async () => {
      const assistantMsgId = 'msg_assistant_callback';
      // retryMessage 语义：重试是“替换原消息内容”，后端应返回原消息 ID
      const mockRetryCallback = vi.fn().mockResolvedValue({
        success: true,
        messageId: assistantMsgId,
      });

      storeApi.setState({
        messageMap: new Map([
          [
            assistantMsgId,
            {
              id: assistantMsgId,
              role: 'assistant',
              blockIds: [],
              timestamp: Date.now(),
            },
          ],
        ]),
        messageOrder: [assistantMsgId],
        sessionStatus: 'idle',
        currentStreamingMessageId: null,
      });

      // 设置重试回调
      storeApi.getState().setRetryCallback(mockRetryCallback);

      // 执行重试
      await storeApi.getState().retryMessage(assistantMsgId, 'model_override');

      // 验证回调被调用
      expect(mockRetryCallback).toHaveBeenCalledWith(assistantMsgId, 'model_override');

      // 验证状态更新
      const state = storeApi.getState();
      expect(state.sessionStatus).toBe('streaming');
      expect(state.currentStreamingMessageId).toBe(assistantMsgId);
    });

    it('should not throw when retry callback is null', async () => {
      const assistantMsgId = 'msg_assistant_no_callback';

      storeApi.setState({
        messageMap: new Map([
          [
            assistantMsgId,
            {
              id: assistantMsgId,
              role: 'assistant',
              blockIds: [],
              timestamp: Date.now(),
            },
          ],
        ]),
        messageOrder: [assistantMsgId],
        sessionStatus: 'idle',
      });

      storeApi.getState().setRetryCallback(null);

      // 应该不抛错，只输出 warn
      await expect(storeApi.getState().retryMessage(assistantMsgId)).resolves.toBeUndefined();
    });

    it('should reset status on callback error', async () => {
      const assistantMsgId = 'msg_assistant_error';
      const mockError = new Error('Retry failed');
      const mockRetryCallback = vi.fn().mockRejectedValue(mockError);

      storeApi.setState({
        messageMap: new Map([
          [
            assistantMsgId,
            {
              id: assistantMsgId,
              role: 'assistant',
              blockIds: [],
              timestamp: Date.now(),
            },
          ],
        ]),
        messageOrder: [assistantMsgId],
        sessionStatus: 'idle',
        currentStreamingMessageId: null,
      });

      storeApi.getState().setRetryCallback(mockRetryCallback);

      // 执行重试并期望抛错
      await expect(storeApi.getState().retryMessage(assistantMsgId)).rejects.toThrow('Retry failed');

      // 验证状态被重置
      const state = storeApi.getState();
      expect(state.sessionStatus).toBe('idle');
      expect(state.currentStreamingMessageId).toBeNull();
    });
  });

  describe('sendMessageWithIds', () => {
    it('should use provided message IDs', async () => {
      const userMessageId = 'msg_user_provided';
      const assistantMessageId = 'msg_assistant_provided';

      storeApi.setState({
        sessionStatus: 'idle',
        messageMap: new Map(),
        messageOrder: [],
        blocks: new Map(),
        attachments: [],
      });

      await storeApi
        .getState()
        .sendMessageWithIds('Hello', undefined, userMessageId, assistantMessageId);

      const state = storeApi.getState();

      // 验证使用了提供的 ID
      expect(state.messageMap.has(userMessageId)).toBe(true);
      expect(state.messageMap.has(assistantMessageId)).toBe(true);
      expect(state.messageOrder).toContain(userMessageId);
      expect(state.messageOrder).toContain(assistantMessageId);

      // 验证消息内容
      const userMsg = state.messageMap.get(userMessageId);
      expect(userMsg?.role).toBe('user');

      const assistantMsg = state.messageMap.get(assistantMessageId);
      expect(assistantMsg?.role).toBe('assistant');
    });

    it('should throw error when streaming', async () => {
      storeApi.setState({
        sessionStatus: 'streaming',
      });

      await expect(
        storeApi
          .getState()
          .sendMessageWithIds('Hello', undefined, 'msg_1', 'msg_2')
      ).rejects.toThrow(
        i18n.t('chatV2:store.cannotSendWhileStreaming', 'Cannot send while streaming')
      );
    });
  });

  describe('saveSession', () => {
    it('should call save callback when set', async () => {
      const mockSaveCallback = vi.fn().mockResolvedValue(undefined);

      storeApi.getState().setSaveCallback(mockSaveCallback);
      await storeApi.getState().saveSession();

      expect(mockSaveCallback).toHaveBeenCalledTimes(1);
    });

    it('should not throw when save callback is null', async () => {
      storeApi.getState().setSaveCallback(null);

      // 应该不抛错，只输出 warn
      await expect(storeApi.getState().saveSession()).resolves.toBeUndefined();
    });

    it('should propagate callback errors', async () => {
      const mockError = new Error('Save failed');
      const mockSaveCallback = vi.fn().mockRejectedValue(mockError);

      storeApi.getState().setSaveCallback(mockSaveCallback);

      await expect(storeApi.getState().saveSession()).rejects.toThrow('Save failed');
    });
  });

  describe('createBlockWithId', () => {
    it('should create block with provided ID', () => {
      const messageId = 'msg_test';
      const providedBlockId = 'blk_provided_123';

      storeApi.setState({
        messageMap: new Map([
          [messageId, { id: messageId, role: 'assistant', blockIds: [], timestamp: Date.now() }],
        ]),
        blocks: new Map(),
      });

      const resultId = storeApi.getState().createBlockWithId(messageId, 'content', providedBlockId);

      expect(resultId).toBe(providedBlockId);
      expect(storeApi.getState().blocks.has(providedBlockId)).toBe(true);

      const block = storeApi.getState().blocks.get(providedBlockId);
      expect(block?.type).toBe('content');
      expect(block?.messageId).toBe(messageId);
    });
  });
});
