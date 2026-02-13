/**
 * Chat V2 - 思维链事件处理插件
 *
 * 处理 thinking（思维链）类型的后端事件。
 *
 * 事件类型：thinking
 * 块类型：thinking
 *
 * 特点：
 * - thinking 块在消息的块列表中始终置顶
 * - 流式中断时保留已有内容
 *
 * 约束：
 * - 文件导入即自动注册（自执行）
 */

import { eventRegistry, type EventHandler } from '../../registry/eventRegistry';
import type { ChatStore } from '../../core/types';
import { logChatV2 } from '../../debug/chatV2Logger';

// ============================================================================
// 事件处理器
// ============================================================================

/**
 * 思维链事件处理器
 *
 * 注意：Store actions 内部已处理 activeBlockIds 管理：
 * - createBlock 自动添加到 activeBlockIds
 * - updateBlockContent 自动将状态设为 running
 * - updateBlockStatus(success/error) 自动从 activeBlockIds 移除
 * - setBlockError 自动设置错误状态并从 activeBlockIds 移除
 */
const thinkingEventHandler: EventHandler = {
  /**
   * 处理 thinking_start 事件
   * 创建新的 thinking 块
   *
   * @param store ChatStore 实例
   * @param messageId 消息 ID
   * @param _payload 附加数据（未使用）
   * @param backendBlockId 可选，后端传递的 blockId
   * @returns 创建的块 ID
   */
  onStart: (
    store: ChatStore,
    messageId: string,
    _payload?: unknown,
    backendBlockId?: string
  ): string => {
    logChatV2('thinking', 'middleware', 'thinking_start', {
      messageId,
      backendBlockId,
      sessionId: store.sessionId,
    }, 'info');

    // 如果后端传了 blockId，使用它；否则由前端生成
    let blockId: string;
    if (backendBlockId) {
      blockId = store.createBlockWithId(messageId, 'thinking', backendBlockId);
    } else {
      // 创建 thinking 块
      // Store 内部会：1. 处理置顶逻辑 2. 自动添加到 activeBlockIds
      blockId = store.createBlock(messageId, 'thinking');
    }

    logChatV2('thinking', 'middleware', 'thinking_block_created', {
      messageId,
      blockId,
    }, 'success');

    return blockId;
  },

  /**
   * 处理 thinking_chunk 事件
   * 追加内容到 thinking 块
   *
   * @param store ChatStore 实例
   * @param blockId 块 ID
   * @param chunk 内容块
   */
  onChunk: (store: ChatStore, blockId: string, chunk: string): void => {
    logChatV2('thinking', 'middleware', 'thinking_chunk', {
      blockId,
      chunkLength: chunk.length,
    }, 'debug');

    // Store 内部会自动将状态设为 running
    store.updateBlockContent(blockId, chunk);
  },

  /**
   * 处理 thinking_end 事件
   * 完成 thinking 块
   *
   * @param store ChatStore 实例
   * @param blockId 块 ID
   */
  onEnd: (store: ChatStore, blockId: string): void => {
    logChatV2('thinking', 'middleware', 'thinking_end', {
      blockId,
      sessionId: store.sessionId,
    }, 'success');

    // Store 内部会自动从 activeBlockIds 移除
    store.updateBlockStatus(blockId, 'success');
  },

  /**
   * 处理 thinking_error 事件
   * 标记 thinking 块为错误状态
   * 注意：thinking 块保留已有内容
   *
   * @param store ChatStore 实例
   * @param blockId 块 ID
   * @param error 错误信息
   */
  onError: (store: ChatStore, blockId: string, error: string): void => {
    logChatV2('thinking', 'middleware', 'thinking_error', {
      blockId,
      error,
      sessionId: store.sessionId,
    }, 'error');

    // Store 内部会自动设置错误状态并从 activeBlockIds 移除
    store.setBlockError(blockId, error);
  },
};

// ============================================================================
// 自动注册
// ============================================================================

// 注册到 eventRegistry（导入即注册）
eventRegistry.register('thinking', thinkingEventHandler);

// 导出 handler 供测试使用
export { thinkingEventHandler };
