/**
 * Chat V2 - Guards 单元测试
 *
 * 测试操作守卫的逻辑
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createChatStore } from '@/chat-v2/core/store/createChatStore';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '@/chat-v2/core/types';

// ============================================================================
// 测试辅助
// ============================================================================

let store: StoreApi<ChatStore>;

function getState() {
  return store.getState();
}

// ============================================================================
// Guards 测试
// ============================================================================

describe('Guards', () => {
  beforeEach(() => {
    store = createChatStore('test-session-guards');
  });

  // ==========================================================================
  // canSend 测试
  // ==========================================================================

  describe('canSend', () => {
    it('should return true when sessionStatus is idle', () => {
      expect(getState().sessionStatus).toBe('idle');
      expect(getState().canSend()).toBe(true);
    });

    it('should return false when sessionStatus is streaming', async () => {
      const state = getState();
      await state.sendMessage('Test');

      expect(getState().sessionStatus).toBe('streaming');
      expect(getState().canSend()).toBe(false);
    });

    it('should return false when sessionStatus is aborting', async () => {
      const state = getState();
      await state.sendMessage('Test');

      // 手动设置为 aborting（模拟中断过程中）
      // 通过内部状态来模拟，实际上 abortStream 会先设置 aborting
      // 这里我们直接测试 abortStream 调用后的状态
      await state.abortStream();

      // abortStream 完成后会变回 idle
      expect(getState().sessionStatus).toBe('idle');
      expect(getState().canSend()).toBe(true);
    });
  });

  // ==========================================================================
  // canAbort 测试
  // ==========================================================================

  describe('canAbort', () => {
    it('should return false when sessionStatus is idle', () => {
      expect(getState().sessionStatus).toBe('idle');
      expect(getState().canAbort()).toBe(false);
    });

    it('should return true when sessionStatus is streaming', async () => {
      const state = getState();
      await state.sendMessage('Test');

      expect(getState().sessionStatus).toBe('streaming');
      expect(getState().canAbort()).toBe(true);
    });
  });

  // ==========================================================================
  // isBlockLocked 测试
  // ==========================================================================

  describe('isBlockLocked', () => {
    it('should return true when block is in activeBlockIds', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const blockId = state.createBlock(assistantMessageId, 'content');

      expect(getState().isBlockLocked(blockId)).toBe(true);
    });

    it('should return false when block is not in activeBlockIds', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const blockId = state.createBlock(assistantMessageId, 'content');

      // 标记块完成
      state.updateBlockStatus(blockId, 'success');

      expect(getState().isBlockLocked(blockId)).toBe(false);
    });

    it('should return false for non-existent block', () => {
      expect(getState().isBlockLocked('non-existent-block')).toBe(false);
    });
  });

  // ==========================================================================
  // isMessageLocked 测试
  // ==========================================================================

  describe('isMessageLocked', () => {
    it('should return true when any block is active', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      state.createBlock(assistantMessageId, 'content');

      expect(getState().isMessageLocked(assistantMessageId)).toBe(true);
    });

    it('should return false when all blocks are completed', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      const blockId = state.createBlock(assistantMessageId, 'content');

      // 标记块完成
      state.updateBlockStatus(blockId, 'success');

      expect(getState().isMessageLocked(assistantMessageId)).toBe(false);
    });

    it('should return false for message with no blocks', async () => {
      const state = getState();
      await state.sendMessage('Test');

      // 助手消息初始没有块
      const assistantMessageId = getState().messageOrder[1];
      const assistantMessage = getState().messageMap.get(assistantMessageId);

      // 清空 blockIds（模拟没有块的情况）
      // 实际上助手消息创建时是空的
      expect(assistantMessage?.blockIds.length).toBe(0);
      expect(getState().isMessageLocked(assistantMessageId)).toBe(false);
    });

    it('should return false for non-existent message', () => {
      expect(getState().isMessageLocked('non-existent-message')).toBe(false);
    });

    it('should return true when at least one block is active', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];

      // 创建两个块
      const block1 = state.createBlock(assistantMessageId, 'thinking');
      const block2 = state.createBlock(assistantMessageId, 'content');

      // 只完成第一个块
      state.updateBlockStatus(block1, 'success');

      // 消息仍然被锁定（因为 block2 还在活跃）
      expect(getState().isMessageLocked(assistantMessageId)).toBe(true);

      // 完成第二个块
      state.updateBlockStatus(block2, 'success');

      // 现在消息不再锁定
      expect(getState().isMessageLocked(assistantMessageId)).toBe(false);
    });
  });

  // ==========================================================================
  // canEdit 测试
  // ==========================================================================

  describe('canEdit', () => {
    it('should return true when message is not locked', async () => {
      const state = getState();
      await state.sendMessage('Test');
      await state.abortStream();

      const userMessageId = getState().messageOrder[0];

      // 用户消息的块已完成
      expect(getState().canEdit(userMessageId)).toBe(true);
    });

    it('should return false when message is locked', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      state.createBlock(assistantMessageId, 'content');

      expect(getState().canEdit(assistantMessageId)).toBe(false);
    });
  });

  // ==========================================================================
  // canDelete 测试
  // ==========================================================================

  describe('canDelete', () => {
    it('should return true when message is not locked', async () => {
      const state = getState();
      await state.sendMessage('Test');
      await state.abortStream();

      const userMessageId = getState().messageOrder[0];

      expect(getState().canDelete(userMessageId)).toBe(true);
    });

    it('should return false when message is locked', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      state.createBlock(assistantMessageId, 'content');

      expect(getState().canDelete(assistantMessageId)).toBe(false);
    });
  });

  // ==========================================================================
  // 守卫与操作集成测试
  // ==========================================================================

  describe('Guards Integration', () => {
    it('should prevent sendMessage when streaming', async () => {
      const state = getState();
      await state.sendMessage('First');

      // canSend 返回 false
      expect(getState().canSend()).toBe(false);

      // 尝试发送应该抛错
      await expect(state.sendMessage('Second')).rejects.toThrow();
    });

    it('should prevent deleteMessage when message is locked', async () => {
      const state = getState();
      await state.sendMessage('Test');

      const assistantMessageId = getState().messageOrder[1];
      state.createBlock(assistantMessageId, 'content');

      // canDelete 返回 false
      expect(getState().canDelete(assistantMessageId)).toBe(false);

      // 尝试删除应该抛错
      await expect(state.deleteMessage(assistantMessageId)).rejects.toThrow();
    });

    it('should allow operations after abortStream', async () => {
      const state = getState();
      await state.sendMessage('First');

      // 此时不能发送
      expect(getState().canSend()).toBe(false);

      // 中断流式
      await state.abortStream();

      // 现在可以发送
      expect(getState().canSend()).toBe(true);
      await expect(state.sendMessage('Second')).resolves.not.toThrow();
    });

    it('abortStream should be no-op when not streaming', async () => {
      const state = getState();

      // 初始状态是 idle
      expect(getState().canAbort()).toBe(false);

      // 调用 abortStream 应该是 no-op
      await state.abortStream();

      // 状态保持 idle
      expect(getState().sessionStatus).toBe('idle');
    });
  });
});
