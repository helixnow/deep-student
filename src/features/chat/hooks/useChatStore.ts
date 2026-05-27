/**
 * Chat V2 - useChatStore Hooks
 *
 * 细粒度选择器，避免不必要的重渲染
 */

import { useCallback, useRef } from 'react';
import { useStore, type StoreApi } from 'zustand';
import { shallow } from 'zustand/shallow';
import type { ChatStore, Message, Block, SessionStatus } from '../core/types';

/** Store 参数类型 */
type ChatStoreApi = StoreApi<ChatStore>;

// ============================================================================
// 消息选择器
// ============================================================================

/**
 * 订阅单条消息
 */
export function useMessage(store: ChatStoreApi, messageId: string): Message | undefined {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.messageMap.get(messageId), [messageId])
  );
}

/**
 * 🚀 P1 性能优化：只订阅消息的 blockIds 数组
 * 
 * 使用 ref 缓存避免数组引用变化导致的不必要重渲染
 * 当 blockIds 内容相同但引用不同时，返回缓存的引用
 */
export function useMessageBlockIds(store: ChatStoreApi, messageId: string): string[] {
  const prevRef = useRef<string[]>([]);
  
  return useStore(
    store,
    useCallback((s: ChatStore) => {
      const message = s.messageMap.get(messageId);
      const newBlockIds = message?.blockIds ?? [];
      
      // 如果长度相同且内容相同，返回缓存的引用
      if (
        newBlockIds.length === prevRef.current.length &&
        newBlockIds.every((id, i) => id === prevRef.current[i])
      ) {
        return prevRef.current;
      }
      
      // 内容变化，更新缓存
      prevRef.current = newBlockIds;
      return newBlockIds;
    }, [messageId])
  );
}

/**
 * 订阅消息顺序
 * 
 * 🚀 性能优化：使用 ref 缓存避免数组引用变化导致的不必要重渲染
 * 当 messageOrder 数组内容相同但引用不同时，返回缓存的引用
 */
export function useMessageOrder(store: ChatStoreApi): string[] {
  // 缓存上次结果
  const prevRef = useRef<string[]>([]);
  
  return useStore(
    store,
    useCallback((s: ChatStore) => {
      const newOrder = s.messageOrder;
      
      // 如果长度相同且内容相同，返回缓存的引用
      if (
        newOrder.length === prevRef.current.length &&
        newOrder.every((id, i) => id === prevRef.current[i])
      ) {
        return prevRef.current;
      }
      
      // 内容变化，更新缓存
      prevRef.current = newOrder;
      return newOrder;
    }, [])
  );
}

/**
 * 订阅消息的所有块
 * 
 * 性能优化：使用 shallow 比较避免不必要的重渲染
 */
export function useMessageBlocks(store: ChatStoreApi, messageId: string): Block[] {
  // 缓存上次结果，用于 shallow 比较
  const prevBlocksRef = useRef<Block[]>([]);
  
  return useStore(
    store,
    useCallback(
      (s: ChatStore) => {
        const message = s.messageMap.get(messageId);
        if (!message) return prevBlocksRef.current.length === 0 ? prevBlocksRef.current : [];
        
        const newBlocks = message.blockIds
          .map((id) => s.blocks.get(id))
          .filter((b): b is Block => b !== undefined);
        
        // 如果块数量和内容都相同，返回之前的引用
        if (
          newBlocks.length === prevBlocksRef.current.length &&
          newBlocks.every((b, i) => b === prevBlocksRef.current[i])
        ) {
          return prevBlocksRef.current;
        }
        
        prevBlocksRef.current = newBlocks;
        return newBlocks;
      },
      [messageId]
    )
  );
}

/**
 * 订阅指定 blockIds 对应的块列表
 *
 * 用于消息级渲染场景：只在当前显示的块内容变化时重渲染，
 * 避免依赖 getState() 读取瞬时快照导致的漏渲染。
 */
export function useBlocksByIds(store: ChatStoreApi, blockIds: string[]): Block[] {
  const prevBlocksRef = useRef<Block[]>([]);

  return useStore(
    store,
    useCallback((s: ChatStore) => {
      const nextBlocks = blockIds
        .map((id) => s.blocks.get(id))
        .filter((block): block is Block => block !== undefined);

      if (
        nextBlocks.length === prevBlocksRef.current.length &&
        nextBlocks.every((block, index) => block === prevBlocksRef.current[index])
      ) {
        return prevBlocksRef.current;
      }

      prevBlocksRef.current = nextBlocks;
      return nextBlocks;
    }, [blockIds])
  );
}

// ============================================================================
// 块选择器
// ============================================================================

/**
 * 订阅单个块
 */
export function useBlock(store: ChatStoreApi, blockId: string): Block | undefined {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.blocks.get(blockId), [blockId])
  );
}

// ============================================================================
// 会话状态选择器
// ============================================================================

/**
 * 订阅会话状态
 */
export function useSessionStatus(store: ChatStoreApi): SessionStatus {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.sessionStatus, [])
  );
}

/**
 * 订阅数据是否已加载
 */
export function useIsDataLoaded(store: ChatStoreApi): boolean {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.isDataLoaded, [])
  );
}

/**
 * 订阅是否可以发送
 */
export function useCanSend(store: ChatStoreApi): boolean {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.canSend(), [])
  );
}

/**
 * 订阅是否可以中断
 */
export function useCanAbort(store: ChatStoreApi): boolean {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.canAbort(), [])
  );
}

// ============================================================================
// 会话元信息选择器
// ============================================================================

/**
 * 订阅会话标题
 */
export function useTitle(store: ChatStoreApi): string {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.title, [])
  );
}

// ============================================================================
// 输入框状态选择器
// ============================================================================

/**
 * 订阅输入框内容
 */
export function useInputValue(store: ChatStoreApi): string {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.inputValue, [])
  );
}

/**
 * 订阅附件列表
 */
export function useAttachments(store: ChatStoreApi): ChatStore['attachments'] {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.attachments, [])
  );
}

/**
 * 订阅面板状态
 */
export function usePanelStates(store: ChatStoreApi): ChatStore['panelStates'] {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.panelStates, [])
  );
}

// ============================================================================
// 配置选择器
// ============================================================================

/**
 * 订阅对话参数
 */
export function useChatParams(store: ChatStoreApi): ChatStore['chatParams'] {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.chatParams, [])
  );
}

/**
 * 订阅功能开关
 */
export function useFeature(store: ChatStoreApi, key: string): boolean {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.features.get(key) ?? false, [key])
  );
}

/**
 * 订阅模式状态
 */
export function useModeState(store: ChatStoreApi): ChatStore['modeState'] {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.modeState, [])
  );
}

// ============================================================================
// 流式状态选择器
// ============================================================================

/**
 * 订阅当前流式消息 ID
 */
export function useCurrentStreamingMessageId(store: ChatStoreApi): string | null {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.currentStreamingMessageId, [])
  );
}

/**
 * 订阅活跃块 ID 集合
 */
export function useActiveBlockIds(store: ChatStoreApi): Set<string> {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.activeBlockIds, [])
  );
}

/**
 * 检查块是否活跃（正在流式）
 */
export function useIsBlockActive(store: ChatStoreApi, blockId: string): boolean {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.activeBlockIds.has(blockId), [blockId])
  );
}
