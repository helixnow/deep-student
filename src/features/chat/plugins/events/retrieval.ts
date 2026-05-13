/**
 * Chat V2 - 统一知识检索事件处理插件
 *
 * 处理检索类型的后端事件：
 * - rag: 文档知识库
 * - memory: 用户记忆
 * - web_search: 网络搜索
 * - multimodal_rag: 多模态知识库
 *
 * 特点：
 * - 检索块不支持流式更新（直接返回完整结果）
 * - 使用统一的事件处理逻辑
 * - 导入即自动注册
 *
 * 约束：
 * - 检索结果存储在 block.toolOutput
 * - 中断时标记为 error
 */

import {
  eventRegistry,
  type EventHandler,
  type EventStartPayload,
} from '../../registry/eventRegistry';
import type { ChatStore } from '../../core/types';

// ============================================================================
// 检索类型定义
// ============================================================================

/**
 * 支持的检索事件类型
 */
const RETRIEVAL_TYPES = ['rag', 'memory', 'web_search', 'multimodal_rag'] as const;

type RetrievalType = (typeof RETRIEVAL_TYPES)[number];

// ============================================================================
// 检索事件处理器工厂
// ============================================================================

/**
 * 创建检索事件处理器
 *
 * 所有检索类型共享相同的处理逻辑：
 * - onStart: 创建对应类型的块
 * - onChunk: 检索块通常不需要流式更新，直接忽略
 * - onEnd: 设置检索结果到 toolOutput
 * - onError: 设置错误信息
 *
 * @param type 检索类型
 * @returns EventHandler 实例
 */
function createRetrievalHandler(type: RetrievalType): EventHandler {
  return {
    /**
     * 处理检索开始事件
     * 创建对应类型的块
     *
     * @param store ChatStore 实例
     * @param messageId 消息 ID
     * @param _payload 附加数据
     * @param backendBlockId 可选，后端传递的 blockId
     * @returns 创建的块 ID
     */
    onStart: (
      store: ChatStore,
      messageId: string,
      _payload: EventStartPayload,
      backendBlockId?: string
    ): string => {
      // 如果后端传了 blockId，使用它；否则由前端生成
      if (backendBlockId) {
        return store.createBlockWithId(messageId, type, backendBlockId);
      }
      // 创建检索块
      // Store 内部会自动添加到 activeBlockIds
      return store.createBlock(messageId, type);
    },

    /**
     * 处理检索数据块事件
     * 检索块通常不需要流式更新，直接等待完整结果
     * 但保留此方法以支持未来可能的增量更新需求
     *
     * @param _store ChatStore 实例
     * @param _blockId 块 ID
     * @param _chunk 数据块
     */
    onChunk: (
      _store: ChatStore,
      _blockId: string,
      _chunk: string
    ): void => {
      // 检索块通常不需要流式更新
      // 如果后端发送了增量数据，可以在这里处理
      // 目前直接忽略
    },

    /**
     * 处理检索结束事件
     * 将检索结果存储到 block.toolOutput
     *
     * 注意：不设置 block.citations，因为：
     * 1. 后端 SourceInfo 结构没有 type 字段，无法直接映射到前端 Citation 类型
     * 2. sourceAdapter.ts 的 retrievalOutputToSourceItems 会从 block.type 推断类型
     * 3. 块渲染组件（rag.tsx 等）也是从 toolOutput 读取数据
     *
     * @param store ChatStore 实例
     * @param blockId 块 ID
     * @param result 检索结果（格式：{ sources: SourceInfo[], durationMs: number }）
     */
    onEnd: (store: ChatStore, blockId: string, result?: unknown): void => {
      // 将完整结果存储到 toolOutput
      // sourceAdapter.ts 会从 toolOutput.sources 提取来源并从 block.type 推断类型
      store.updateBlock(blockId, {
        toolOutput: result,
      });

      // 设置状态为成功（会自动设置 endedAt 并从 activeBlockIds 移除）
      store.updateBlockStatus(blockId, 'success');
    },

    /**
     * 处理检索错误事件
     * 标记块为错误状态
     *
     * @param store ChatStore 实例
     * @param blockId 块 ID
     * @param error 错误信息
     */
    onError: (store: ChatStore, blockId: string, error: string): void => {
      // 设置错误信息
      // Store 内部会自动设置 status: 'error' 并从 activeBlockIds 移除
      store.setBlockError(blockId, error);
    },
  };
}

// ============================================================================
// 自动注册所有检索事件处理器
// ============================================================================

// 为每种检索类型创建并注册事件处理器
const retrievalHandlers: Record<RetrievalType, EventHandler> = {} as Record<
  RetrievalType,
  EventHandler
>;

RETRIEVAL_TYPES.forEach((type) => {
  const handler = createRetrievalHandler(type);
  retrievalHandlers[type] = handler;

  // 注册到 eventRegistry（导入即注册）
  eventRegistry.register(type, handler);
});

// ============================================================================
// 导出
// ============================================================================

/**
 * 检索事件处理器集合
 * 导出供测试使用
 */
export { retrievalHandlers, RETRIEVAL_TYPES };

/**
 * 单独导出各类型处理器（便于测试）
 */
export const ragEventHandler = retrievalHandlers.rag;
export const memoryEventHandler = retrievalHandlers.memory;
export const webSearchEventHandler = retrievalHandlers.web_search;
export const multimodalRagEventHandler = retrievalHandlers.multimodal_rag;
