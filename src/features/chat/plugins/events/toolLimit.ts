/**
 * Chat V2 - 工具限制事件处理插件
 *
 * 处理 tool_limit（工具递归限制）类型的后端事件。
 *
 * 事件类型：tool_limit
 * 块类型：tool_limit
 *
 * 特点：
 * - 达到工具递归限制时显示提示块
 * - 非流式块，只有 start 和 end 两个阶段
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
 * 工具限制事件处理器
 */
const toolLimitEventHandler: EventHandler = {
  /**
   * 处理 tool_limit_start 事件
   * 创建新的 tool_limit 块
   *
   * @param store ChatStore 实例
   * @param messageId 消息 ID
   * @param _payload 附加数据（未使用）
   * @param backendBlockId 后端传递的 blockId
   * @returns 创建的块 ID
   */
  onStart: (
    store: ChatStore,
    messageId: string,
    _payload?: unknown,
    backendBlockId?: string
  ): string => {
    // 如果后端传了 blockId，使用它；否则由前端生成
    const blockId = backendBlockId
      ? store.createBlockWithId(messageId, 'tool_limit', backendBlockId)
      : store.createBlock(messageId, 'tool_limit');

    // 🆕 设置阻塞交互状态
    // onContinue 清除阻塞并调用 continueMessage 继续生成
    store.setBlockingInteraction({
      kind: 'tool_limit',
      blockId,
      content: '', // Will be updated in onEnd when content arrives
      onContinue: async () => {
        store.clearBlockingInteraction();
        await store.continueMessage(messageId);
      },
    });

    return blockId;
  },

  /**
   * 处理 tool_limit_end 事件
   * 设置块内容和状态
   *
   * @param store ChatStore 实例
   * @param blockId 块 ID
   * @param result 结果数据，包含 content 等
   */
  onEnd: (store: ChatStore, blockId: string, result?: unknown): void => {
    // 从 result 中提取内容
    const data = result as { content?: string } | undefined;
    if (data?.content) {
      // 设置块内容
      store.updateBlockContent(blockId, data.content);
    }
    // 标记为成功状态
    store.updateBlockStatus(blockId, 'success');

    // 🆕 更新阻塞交互内容（保持阻塞状态，等用户点击"继续"）
    const currentBlocking = store.pendingBlockingInteraction;
    if (currentBlocking && currentBlocking.kind === 'tool_limit' && currentBlocking.blockId === blockId) {
      store.setBlockingInteraction({
        ...currentBlocking,
        content: data?.content || '',
      });
    }
  },

  /**
   * 处理 tool_limit_error 事件
   * 标记块为错误状态
   *
   * @param store ChatStore 实例
   * @param blockId 块 ID
   * @param error 错误信息
   */
  onError: (store: ChatStore, blockId: string, error: string): void => {
    store.setBlockError(blockId, error);

    // 🆕 错误时清除阻塞交互状态
    const currentBlocking = store.pendingBlockingInteraction;
    if (currentBlocking && currentBlocking.kind === 'tool_limit' && currentBlocking.blockId === blockId) {
      store.clearBlockingInteraction();
    }
  },
};

// ============================================================================
// 自动注册
// ============================================================================

// 注册到 eventRegistry（导入即注册）
eventRegistry.register('tool_limit', toolLimitEventHandler);

// 导出 handler 供测试使用
export { toolLimitEventHandler };
