/**
 * Immer 辅助工具 - 优化 Store 的不可变更新性能
 *
 * 问题背景：
 * - createChatStore.ts 中有 66+ 处 `new Map()` 和 `new Set()` 创建操作
 * - 每次状态更新都创建深拷贝，导致长对话时性能下降、GC 压力增大
 *
 * 解决方案：
 * - 使用 immer 的 produce 函数进行选择性更新
 * - 保持 Zustand 的不可变性要求，但优化热点路径
 * - 提供类型安全的辅助函数，避免手动管理 Map/Set 复制
 */

import { produce, enableMapSet, type Draft } from 'immer';

/**
 * 🔧 CRITICAL FIX: 启用 Immer 的 Map/Set 支持
 *
 * Immer 默认不支持 Map 和 Set 数据结构。
 * 由于 ChatStore 使用 Map<string, Block> 和 Map<string, Message> 等结构，
 * 必须在使用 produce 之前调用 enableMapSet()。
 *
 * 不启用会导致：
 * - 流式消息更新时报错 "[Immer] The plugin for 'MapSet' has not been loaded"
 * - 消息发送后前端无法显示内容
 * - 刷新后能正常显示（因为加载时不经过 produce）
 */
enableMapSet();
import type { ChatStoreState } from './types';
import type { Block } from '../types/block';
import type { Message } from '../types/message';

/**
 * 使用 Immer 更新单个 Block
 *
 * @example
 * set(updateSingleBlock(blockId, (draft) => {
 *   draft.content += chunk;
 *   draft.status = 'running';
 * }))
 */
export function updateSingleBlock(
  blockId: string,
  updater: (draft: Draft<Block>) => void
): (state: ChatStoreState) => Partial<ChatStoreState> {
  return (state) => {
    const block = state.blocks.get(blockId);
    if (!block) return {};

    const newBlocks = produce(state.blocks, (draft) => {
      const draftBlock = draft.get(blockId);
      if (draftBlock) {
        updater(draftBlock as Draft<Block>);
      }
    });

    return { blocks: newBlocks };
  };
}

/**
 * 使用 Immer 批量更新多个 Block
 *
 * @example
 * set(updateMultipleBlocks((draft) => {
 *   draft.get(blockId1)!.status = 'success';
 *   draft.get(blockId2)!.status = 'error';
 * }))
 */
export function updateMultipleBlocks(
  updater: (draft: Draft<Map<string, Block>>) => void
): (state: ChatStoreState) => Partial<ChatStoreState> {
  return (state) => {
    const newBlocks = produce(state.blocks, updater);
    return { blocks: newBlocks };
  };
}

/**
 * 使用 Immer 更新单个 Message
 *
 * @example
 * set(updateSingleMessage(messageId, (draft) => {
 *   draft.activeVariantId = newVariantId;
 * }))
 */
export function updateSingleMessage(
  messageId: string,
  updater: (draft: Draft<Message>) => void
): (state: ChatStoreState) => Partial<ChatStoreState> {
  return (state) => {
    const message = state.messageMap.get(messageId);
    if (!message) return {};

    const newMessageMap = produce(state.messageMap, (draft) => {
      const draftMessage = draft.get(messageId);
      if (draftMessage) {
        updater(draftMessage as Draft<Message>);
      }
    });

    return { messageMap: newMessageMap };
  };
}

/**
 * 使用 Immer 批量更新多个 Message
 *
 * @example
 * set(updateMultipleMessages((draft) => {
 *   for (const [msgId, message] of draft) {
 *     if (message.role === 'assistant') {
 *       message.variants = updateVariants(message.variants);
 *     }
 *   }
 * }))
 */
export function updateMultipleMessages(
  updater: (draft: Draft<Map<string, Message>>) => void
): (state: ChatStoreState) => Partial<ChatStoreState> {
  return (state) => {
    const newMessageMap = produce(state.messageMap, updater);
    return { messageMap: newMessageMap };
  };
}

/**
 * 使用 Immer 同时更新 Message 和 Block
 *
 * MEDIUM-004 修复：使用单次 produce 调用实现原子更新
 * 之前的两次 produce 调用不是原子操作，可能导致状态不一致
 *
 * @example
 * set(updateMessageAndBlocks(messageId,
 *   (draftMessage) => {
 *     draftMessage.blockIds.push(newBlockId);
 *   },
 *   (draftBlocks) => {
 *     draftBlocks.set(newBlockId, newBlock);
 *   }
 * ))
 */
export function updateMessageAndBlocks(
  messageId: string,
  messageUpdater: (draft: Draft<Message>) => void,
  blocksUpdater: (draft: Draft<Map<string, Block>>) => void
): (state: ChatStoreState) => ChatStoreState {
  return (state) => {
    const message = state.messageMap.get(messageId);
    if (!message) return state;

    // 使用单次 produce 调用确保原子更新
    return produce(state, (draft) => {
      const draftMessage = draft.messageMap.get(messageId);
      if (draftMessage) {
        messageUpdater(draftMessage as Draft<Message>);
      }
      blocksUpdater(draft.blocks);
    });
  };
}

/**
 * 优化的 Set 操作 - 添加单个元素
 *
 * CRITICAL-001 修复：始终返回新实例以保证 Zustand 不可变性原则
 * Zustand 依赖引用比较来检测状态变化，返回原引用会导致状态更新失效
 *
 * @example
 * set({ activeBlockIds: addToSet(state.activeBlockIds, blockId) })
 */
export function addToSet<T>(set: Set<T>, value: T): Set<T> {
  if (set.has(value)) return set;
  const newSet = new Set(set);
  newSet.add(value);
  return newSet;
}

/**
 * 优化的 Set 操作 - 删除单个元素
 *
 * CRITICAL-001 修复：始终返回新实例以保证 Zustand 不可变性原则
 * Zustand 依赖引用比较来检测状态变化，返回原引用会导致状态更新失效
 *
 * @example
 * set({ activeBlockIds: removeFromSet(state.activeBlockIds, blockId) })
 */
export function removeFromSet<T>(set: Set<T>, value: T): Set<T> {
  if (!set.has(value)) return set;
  const newSet = new Set(set);
  newSet.delete(value);
  return newSet;
}

/**
 * 优化的 Set 操作 - 批量添加元素
 *
 * CRITICAL-001 修复：始终返回新实例以保证 Zustand 不可变性原则
 * Zustand 依赖引用比较来检测状态变化，返回原引用会导致状态更新失效
 *
 * @example
 * set({ activeBlockIds: addMultipleToSet(state.activeBlockIds, [id1, id2, id3]) })
 */
export function addMultipleToSet<T>(set: Set<T>, values: T[]): Set<T> {
  // 始终创建新 Set 实例，确保引用变化
  const newSet = new Set(set);
  values.forEach(v => newSet.add(v));
  return newSet;
}

/**
 * 优化的 Set 操作 - 批量删除元素
 *
 * CRITICAL-001 修复：始终返回新实例以保证 Zustand 不可变性原则
 * Zustand 依赖引用比较来检测状态变化，返回原引用会导致状态更新失效
 *
 * @example
 * set({ activeBlockIds: removeMultipleFromSet(state.activeBlockIds, [id1, id2, id3]) })
 */
export function removeMultipleFromSet<T>(set: Set<T>, values: T[]): Set<T> {
  // 始终创建新 Set 实例，确保引用变化
  const newSet = new Set(set);
  values.forEach(v => newSet.delete(v));
  return newSet;
}

/**
 * 批量更新状态 - 使用 Immer 进行复杂的多字段更新
 *
 * CRITICAL-006 修复：返回完整 ChatStoreState 而非 Partial
 * produce 返回的是完整状态对象，强制转换为 Partial 会丢失类型安全性
 * Zustand 的 set 函数可以接受完整状态对象，会自动进行浅合并
 *
 * @example
 * set(batchUpdate((draft) => {
 *   draft.messageMap.get(msgId)!.activeVariantId = variantId;
 *   draft.blocks.get(blockId)!.status = 'success';
 *   draft.activeBlockIds = new Set(draft.activeBlockIds);
 *   draft.activeBlockIds.delete(blockId);
 * }))
 */
export function batchUpdate(
  updater: (draft: Draft<ChatStoreState>) => void
): (state: ChatStoreState) => ChatStoreState {
  return (state) => {
    return produce(state, updater);
  };
}

/**
 * 类型守卫 - 检查 Map 中是否存在键
 */
export function hasInMap<K, V>(map: Map<K, V>, key: K): boolean {
  return map.has(key);
}

/**
 * 安全获取 Map 中的值
 */
export function getFromMap<K, V>(map: Map<K, V>, key: K): V | undefined {
  return map.get(key);
}
