/**
 * Chat V2 - 正文事件处理插件
 *
 * 处理 content（正文）类型的后端事件。
 *
 * 事件类型：content
 * 块类型：content
 *
 * 特点：
 * - content 块按到达顺序追加到消息的块列表
 * - 流式中断时保留已有内容
 *
 * 约束：
 * - 文件导入即自动注册（自执行）
 */

import { eventRegistry, type EventHandler } from '../../registry/eventRegistry';
import type { ChatStore } from '../../core/types';

// ============================================================================
// 事件处理器
// ============================================================================

/**
 * 正文事件处理器
 *
 * 注意：Store actions 内部已处理 activeBlockIds 管理：
 * - createBlock 自动添加到 activeBlockIds
 * - updateBlockContent 自动将状态设为 running
 * - updateBlockStatus(success/error) 自动从 activeBlockIds 移除
 * - setBlockError 自动设置错误状态并从 activeBlockIds 移除
 */
const contentEventHandler: EventHandler = {
  /**
   * 处理 content_start 事件
   * 创建新的 content 块
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
    // 如果后端传了 blockId，使用它；否则由前端生成
    if (backendBlockId) {
      return store.createBlockWithId(messageId, 'content', backendBlockId);
    }
    // 创建 content 块（按到达顺序追加）
    // Store 内部会自动添加到 activeBlockIds
    return store.createBlock(messageId, 'content');
  },

  /**
   * 处理 content_chunk 事件
   * 追加内容到 content 块
   *
   * @param store ChatStore 实例
   * @param blockId 块 ID
   * @param chunk 内容块
   */
  onChunk: (store: ChatStore, blockId: string, chunk: string): void => {
    // Store 内部会自动将状态设为 running
    store.updateBlockContent(blockId, chunk);
  },

  /**
   * 处理 content_end 事件
   * 完成 content 块
   *
   * @param store ChatStore 实例
   * @param blockId 块 ID
   */
  onEnd: (store: ChatStore, blockId: string): void => {
    // Store 内部会自动从 activeBlockIds 移除
    store.updateBlockStatus(blockId, 'success');
  },

  /**
   * 处理 content_error 事件
   * 标记 content 块为错误状态
   * 注意：content 块保留已有内容
   *
   * @param store ChatStore 实例
   * @param blockId 块 ID
   * @param error 错误信息
   */
  onError: (store: ChatStore, blockId: string, error: string): void => {
    // Store 内部会自动设置错误状态并从 activeBlockIds 移除
    store.setBlockError(blockId, error);
  },
};

// ============================================================================
// 自动注册
// ============================================================================

// 注册到 eventRegistry（导入即注册）
eventRegistry.register('content', contentEventHandler);

// 导出 handler 供测试使用
export { contentEventHandler };
