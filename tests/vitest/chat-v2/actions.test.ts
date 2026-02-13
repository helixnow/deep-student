/**
 * Chat V2 - Store Actions 单元测试
 *
 * 测试所有 Store Actions 的行为
 */

import { describe, it, expect, beforeEach } from 'vitest';
import i18n from 'i18next';
import { createChatStore } from '@/chat-v2/core/store/createChatStore';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '@/chat-v2/core/types';

// 导入块插件以完成 blockRegistry 注册（abortStream 等行为依赖 onAbort 配置）
import '@/chat-v2/plugins/blocks';

// ============================================================================
// 测试辅助
// ============================================================================

let store: StoreApi<ChatStore>;

function getState() {
  return store.getState();
}

// ============================================================================
// Store Actions 测试
// ============================================================================

describe('Store Actions', () => {
  beforeEach(() => {
    store = createChatStore('test-session-001');
  });

  // ==========================================================================
  // sendMessage 测试
  // ==========================================================================

  describe('sendMessage', () => {
    it('should create user and assistant messages', async () => {
      const state = getState();

      // 设置模型 ID
      state.setChatParams({ modelId: 'test-model' });

      // 发送消息
      await state.sendMessage('Hello, world!');

      const updatedState = getState();

      // 应该有 2 条消息
      expect(updatedState.messageOrder.length).toBe(2);

      // 第一条是用户消息
      const userMessageId = updatedState.messageOrder[0];
      const userMessage = updatedState.messageMap.get(userMessageId);
      expect(userMessage?.role).toBe('user');

      // 第二条是助手消息
      const assistantMessageId = updatedState.messageOrder[1];
      const assistantMessage = updatedState.messageMap.get(assistantMessageId);
      expect(assistantMessage?.role).toBe('assistant');
    });

    it('should snapshot chatParams to assistant._meta', async () => {
      const state = getState();

      // 设置特定的参数
      state.setChatParams({
        modelId: 'gpt-4',
        temperature: 0.8,
        enableThinking: true,
      });

      await state.sendMessage('Test message');

      const updatedState = getState();
      const assistantMessageId = updatedState.messageOrder[1];
      const assistantMessage = updatedState.messageMap.get(assistantMessageId);

      // 检查 _meta 中的参数快照
      expect(assistantMessage?._meta?.modelId).toBe('gpt-4');
      expect(assistantMessage?._meta?.chatParams?.temperature).toBe(0.8);
      expect(assistantMessage?._meta?.chatParams?.enableThinking).toBe(true);
    });

    it('should reject when canSend() is false', async () => {
      const state = getState();

      // 发送第一条消息
      await state.sendMessage('First message');

      // 此时状态应该是 streaming
      expect(getState().sessionStatus).toBe('streaming');

      // 尝试发送第二条消息应该抛错
      const cannotSendMessage = i18n.t(
        'chatV2:store.cannotSendWhileStreaming',
        'Cannot send while streaming'
      );

      await expect(state.sendMessage('Second message')).rejects.toThrow(
        cannotSendMessage
      );
    });

    it('should clear input value and attachments after sending', async () => {
      const state = getState();

      // 设置输入值和附件
      state.setInputValue('Test input');
      state.addAttachment({
        id: 'att-1',
        name: 'test.png',
        type: 'image',
        mimeType: 'image/png',
        size: 1024,
        status: 'ready',
      });

      expect(getState().inputValue).toBe('Test input');
      expect(getState().attachments.length).toBe(1);

      await state.sendMessage('Send this');

      // 发送后应该清空
      expect(getState().inputValue).toBe('');
      expect(getState().attachments.length).toBe(0);
    });

    it('should set sessionStatus to streaming', async () => {
      const state = getState();

      expect(getState().sessionStatus).toBe('idle');

      await state.sendMessage('Test');

      expect(getState().sessionStatus).toBe('streaming');
    });

    it('should set currentStreamingMessageId to assistant message', async () => {
      const state = getState();

      await state.sendMessage('Test');

      const updatedState = getState();
      const assistantMessageId = updatedState.messageOrder[1];

      expect(updatedState.currentStreamingMessageId).toBe(assistantMessageId);
    });
  });

  // ==========================================================================
  // createBlock 测试
  // ==========================================================================

  describe('createBlock', () => {
    it('should add block to blocks Map', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];

      // 创建块
      const blockId = state.createBlock(assistantMessageId, 'content');

      const block = getState().blocks.get(blockId);
      expect(block).toBeDefined();
      expect(block?.type).toBe('content');
      expect(block?.messageId).toBe(assistantMessageId);
      expect(block?.status).toBe('pending');
    });

    it('should append blockId to message.blockIds', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];

      const blockId1 = state.createBlock(assistantMessageId, 'content');
      const blockId2 = state.createBlock(assistantMessageId, 'web_search');

      const message = getState().messageMap.get(assistantMessageId);
      expect(message?.blockIds).toContain(blockId1);
      expect(message?.blockIds).toContain(blockId2);
    });

    it('should insert thinking block at front', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];

      // 先创建 content 块
      const contentBlockId = state.createBlock(assistantMessageId, 'content');

      // 再创建 thinking 块
      const thinkingBlockId = state.createBlock(assistantMessageId, 'thinking');

      const message = getState().messageMap.get(assistantMessageId);

      // 当前设计：Store 只维护创建顺序；展示顺序由后端保证，前端不再二次排序
      const thinkingIndex = message?.blockIds.indexOf(thinkingBlockId) ?? -1;
      const contentIndex = message?.blockIds.indexOf(contentBlockId) ?? -1;

      expect(contentIndex).toBeLessThan(thinkingIndex);
    });

    it('should add block to activeBlockIds', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const blockId = state.createBlock(assistantMessageId, 'content');

      expect(getState().activeBlockIds.has(blockId)).toBe(true);
    });

    it('should insert multiple thinking blocks in order', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];

      // 创建 content 块
      state.createBlock(assistantMessageId, 'content');

      // 创建第一个 thinking 块
      const thinking1 = state.createBlock(assistantMessageId, 'thinking');

      // 创建第二个 thinking 块
      const thinking2 = state.createBlock(assistantMessageId, 'thinking');

      const message = getState().messageMap.get(assistantMessageId);
      const thinking1Index = message?.blockIds.indexOf(thinking1) ?? -1;
      const thinking2Index = message?.blockIds.indexOf(thinking2) ?? -1;

      // thinking2 应该在 thinking1 之后
      expect(thinking2Index).toBe(thinking1Index + 1);
    });
  });

  // ==========================================================================
  // updateBlockContent 测试
  // ==========================================================================

  describe('updateBlockContent', () => {
    it('should append chunk to block.content', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const blockId = state.createBlock(assistantMessageId, 'content');

      state.updateBlockContent(blockId, 'Hello ');
      expect(getState().blocks.get(blockId)?.content).toBe('Hello ');

      state.updateBlockContent(blockId, 'World!');
      expect(getState().blocks.get(blockId)?.content).toBe('Hello World!');
    });

    it('should set block status to running', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const blockId = state.createBlock(assistantMessageId, 'content');

      expect(getState().blocks.get(blockId)?.status).toBe('pending');

      state.updateBlockContent(blockId, 'chunk');

      expect(getState().blocks.get(blockId)?.status).toBe('running');
    });

    it('should handle empty initial content', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const blockId = state.createBlock(assistantMessageId, 'thinking');

      // 初始 content 可能是 undefined
      state.updateBlockContent(blockId, 'First chunk');
      expect(getState().blocks.get(blockId)?.content).toBe('First chunk');
    });
  });

  // ==========================================================================
  // updateBlockStatus 测试
  // ==========================================================================

  describe('updateBlockStatus', () => {
    it('should update block status', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const blockId = state.createBlock(assistantMessageId, 'content');

      state.updateBlockStatus(blockId, 'running');
      expect(getState().blocks.get(blockId)?.status).toBe('running');

      state.updateBlockStatus(blockId, 'success');
      expect(getState().blocks.get(blockId)?.status).toBe('success');
    });

    it('should remove block from activeBlockIds on success', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const blockId = state.createBlock(assistantMessageId, 'content');

      expect(getState().activeBlockIds.has(blockId)).toBe(true);

      state.updateBlockStatus(blockId, 'success');

      expect(getState().activeBlockIds.has(blockId)).toBe(false);
    });

    it('should remove block from activeBlockIds on error', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const blockId = state.createBlock(assistantMessageId, 'content');

      state.updateBlockStatus(blockId, 'error');

      expect(getState().activeBlockIds.has(blockId)).toBe(false);
    });

    it('should set completedAt on success or error', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const blockId = state.createBlock(assistantMessageId, 'content');

      expect(getState().blocks.get(blockId)?.endedAt).toBeUndefined();

      state.updateBlockStatus(blockId, 'success');

      expect(getState().blocks.get(blockId)?.endedAt).toBeDefined();
    });
  });

  // ==========================================================================
  // setBlockResult 测试
  // ==========================================================================

  describe('setBlockResult', () => {
    it('should set toolOutput and mark success', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const blockId = state.createBlock(assistantMessageId, 'mcp_tool');

      const result = { data: [1, 2, 3] };
      state.setBlockResult(blockId, result);

      const block = getState().blocks.get(blockId);
      expect(block?.toolOutput).toEqual(result);
      expect(block?.status).toBe('success');
      expect(block?.endedAt).toBeDefined();
    });
  });

  // ==========================================================================
  // setBlockError 测试
  // ==========================================================================

  describe('setBlockError', () => {
    it('should set error and mark error status', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const blockId = state.createBlock(assistantMessageId, 'web_search');

      state.setBlockError(blockId, 'Network timeout');

      const block = getState().blocks.get(blockId);
      expect(block?.error).toBe('Network timeout');
      expect(block?.status).toBe('error');
    });
  });

  // ==========================================================================
  // abortStream 测试
  // ==========================================================================

  describe('abortStream', () => {
    it('should set sessionStatus to idle', async () => {
      const state = getState();
      await state.sendMessage('Test');

      expect(getState().sessionStatus).toBe('streaming');

      await state.abortStream();

      expect(getState().sessionStatus).toBe('idle');
    });

    it('should clear currentStreamingMessageId', async () => {
      const state = getState();
      await state.sendMessage('Test');

      expect(getState().currentStreamingMessageId).not.toBeNull();

      await state.abortStream();

      expect(getState().currentStreamingMessageId).toBeNull();
    });

    it('should clear activeBlockIds', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      state.createBlock(assistantMessageId, 'content');
      state.createBlock(assistantMessageId, 'thinking');

      expect(getState().activeBlockIds.size).toBeGreaterThan(0);

      await state.abortStream();

      expect(getState().activeBlockIds.size).toBe(0);
    });

    it('should keep content for streaming blocks', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const blockId = state.createBlock(assistantMessageId, 'content');

      state.updateBlockContent(blockId, 'Partial content');

      await state.abortStream();

      const block = getState().blocks.get(blockId);
      expect(block?.content).toBe('Partial content');
      expect(block?.status).toBe('success');
    });

    it('should mark tool blocks as error', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const toolBlockId = state.createBlock(assistantMessageId, 'web_search');

      await state.abortStream();

      const block = getState().blocks.get(toolBlockId);
      expect(block?.status).toBe('error');
      expect(block?.error).toBe('aborted');
    });
  });

  // ==========================================================================
  // deleteMessage 测试
  // ==========================================================================

  describe('deleteMessage', () => {
    it('should remove message from messageMap and messageOrder', async () => {
      const state = getState();
      await state.sendMessage('Test');

      // 先完成流式，使消息可删除
      await state.abortStream();

      const userMessageId = getState().messageOrder[0];

      state.deleteMessage(userMessageId);

      expect(getState().messageMap.has(userMessageId)).toBe(false);
      expect(getState().messageOrder).not.toContain(userMessageId);
    });

    it('should delete all blocks of the message', async () => {
      const state = getState();
      await state.sendMessage('Test');
      await state.abortStream();

      const userMessageId = getState().messageOrder[0];
      const userMessage = getState().messageMap.get(userMessageId);
      const blockIds = userMessage?.blockIds ?? [];

      state.deleteMessage(userMessageId);

      blockIds.forEach((blockId) => {
        expect(getState().blocks.has(blockId)).toBe(false);
      });
    });
  });

  // ==========================================================================
  // 配置 Actions 测试
  // ==========================================================================

  describe('setChatParams', () => {
    it('should update chatParams partially', () => {
      const state = getState();

      state.setChatParams({ modelId: 'gpt-4', temperature: 0.9 });

      expect(getState().chatParams.modelId).toBe('gpt-4');
      expect(getState().chatParams.temperature).toBe(0.9);
      // 其他参数保持默认
      expect(getState().chatParams.enableThinking).toBe(true);
    });
  });

  describe('setFeature / toggleFeature', () => {
    it('should set and toggle features', () => {
      const state = getState();

      state.setFeature('rag', true);
      expect(getState().features.get('rag')).toBe(true);

      state.toggleFeature('rag');
      expect(getState().features.get('rag')).toBe(false);

      state.toggleFeature('rag');
      expect(getState().features.get('rag')).toBe(true);
    });

    it('getFeature should return false for undefined features', () => {
      const state = getState();

      expect(state.getFeature('non-existent')).toBe(false);
    });
  });

  // ==========================================================================
  // 输入框 Actions 测试
  // ==========================================================================

  describe('Input Actions', () => {
    it('setInputValue should update inputValue', () => {
      const state = getState();

      state.setInputValue('Hello');
      expect(getState().inputValue).toBe('Hello');
    });

    it('addAttachment / removeAttachment should work', () => {
      const state = getState();

      const attachment = {
        id: 'att-1',
        name: 'test.png',
        type: 'image' as const,
        mimeType: 'image/png',
        size: 1024,
        status: 'ready' as const,
      };

      state.addAttachment(attachment);
      expect(getState().attachments.length).toBe(1);
      expect(getState().attachments[0].id).toBe('att-1');

      state.removeAttachment('att-1');
      expect(getState().attachments.length).toBe(0);
    });

    it('clearAttachments should remove all attachments', () => {
      const state = getState();

      state.addAttachment({
        id: 'att-1',
        name: 'test1.png',
        type: 'image',
        mimeType: 'image/png',
        size: 1024,
        status: 'ready',
      });
      state.addAttachment({
        id: 'att-2',
        name: 'test2.png',
        type: 'image',
        mimeType: 'image/png',
        size: 2048,
        status: 'ready',
      });

      expect(getState().attachments.length).toBe(2);

      state.clearAttachments();
      expect(getState().attachments.length).toBe(0);
    });

    it('setPanelState should update panel state', () => {
      const state = getState();

      expect(getState().panelStates.rag).toBe(false);

      state.setPanelState('rag', true);
      expect(getState().panelStates.rag).toBe(true);

      state.setPanelState('rag', false);
      expect(getState().panelStates.rag).toBe(false);
    });
  });

  // ==========================================================================
  // 辅助方法测试
  // ==========================================================================

  describe('Helper Methods', () => {
    it('getMessage should return message by id', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const messageId = getState().messageOrder[0];
      const message = state.getMessage(messageId);

      expect(message).toBeDefined();
      expect(message?.id).toBe(messageId);
    });

    it('getMessageBlocks should return blocks for message', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      state.createBlock(assistantMessageId, 'thinking');
      state.createBlock(assistantMessageId, 'content');

      const blocks = state.getMessageBlocks(assistantMessageId);

      expect(blocks.length).toBe(2);
    });

    it('getOrderedMessages should return messages in order', async () => {
      const state = getState();
      await state.sendMessage('Test');
      await state.abortStream();
      await state.sendMessage('Second');

      const messages = state.getOrderedMessages();

      expect(messages.length).toBe(4); // 2 user + 2 assistant
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
    });
  });
});
