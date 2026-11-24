/**
 * Chat V2 - useVariantUI Hook
 *
 * 封装变体相关的 UI 状态和操作
 * 提供统一的变体管理接口
 */

import { useMemo, useCallback, useRef, useEffect } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../core/types/store';
import type { Message, Variant, VariantStatus } from '../core/types/message';
import type { Block } from '../core/types/block';
import { logMultiVariant } from '@/shared/debug/channels/multiVariant';
import { isChatV2LoggingEnabled } from '../debug/chatV2Logger';
import { isParallelVariantViewEnabled } from '@/config/featureFlags';

// ============================================================================
// 类型定义
// ============================================================================

export interface UseVariantUIOptions {
  /** Store 实例 */
  store: StoreApi<ChatStore>;
  /** 消息 ID */
  messageId: string;
}

export interface UseVariantUIResult {
  /** 消息对象 */
  message: Message | undefined;
  /** 变体列表 */
  variants: Variant[];
  /** 当前激活的变体 */
  activeVariant: Variant | undefined;
  /** 当前激活的变体 ID */
  activeVariantId: string | undefined;
  /** 是否为多变体消息 */
  isMultiVariant: boolean;
  /** 是否为重新生成产生的版本序列（单列内联 1 / 2 切换，而非并行分栏） */
  isVersioned: boolean;
  /** 版本总数（仅 isVersioned 时 > 1） */
  versionCount: number;
  /** 当前版本 0-based 索引 */
  activeVersionIndex: number;
  /** 是否有上一可切换版本 */
  canPrevVersion: boolean;
  /** 是否有下一可切换版本 */
  canNextVersion: boolean;
  /** 切换到上一版本 */
  switchToPrevVersion: () => void;
  /** 切换到下一版本 */
  switchToNextVersion: () => void;
  /** 正在流式生成的变体数量 */
  streamingCount: number;

  /** 获取当前应该显示的 blockIds */
  displayBlockIds: string[];
  /** 共享上下文（多变体检索结果） */
  sharedContext: Message['sharedContext'];
  /** 获取变体的块列表 */
  getVariantBlocks: (variantId: string) => Block[];
  /** 切换变体 */
  switchVariant: (variantId: string) => void;
  /** 取消变体 */
  cancelVariant: (variantId: string) => Promise<void>;
  /** 重试变体 */
  retryVariant: (variantId: string) => Promise<void>;
  /** 删除变体 */
  deleteVariant: (variantId: string) => Promise<void>;
  /** 停止所有变体 */
  stopAllVariants: () => Promise<void>;
  /** 重试所有变体 */
  retryAllVariants: () => Promise<void>;
  /** 判断变体是否可切换 */
  canSwitchTo: (variant: Variant) => boolean;
  /** 判断变体是否可重试 */
  canRetry: (variant: Variant) => boolean;
  /** 判断变体是否可取消 */
  canCancel: (variant: Variant) => boolean;
  /** 判断变体是否可删除 */
  canDelete: (variant: Variant) => boolean;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 判断变体是否可切换
 * 可切换状态: pending, streaming, success, cancelled
 */
function isVariantSwitchable(status: VariantStatus): boolean {
  return status !== 'error';
}

/**
 * 判断变体是否可重试
 */
function isVariantRetryable(status: VariantStatus): boolean {
  return status === 'error' || status === 'cancelled';
}

/**
 * 判断变体是否可取消
 */
function isVariantCancellable(status: VariantStatus): boolean {
  return status === 'streaming' || status === 'pending';
}

// ============================================================================
// 注意：displayBlockIds 的计算逻辑
// ============================================================================
// 
// displayBlockIds 是决定消息显示哪些块的核心逻辑，需要确保前后端一致。
// 
// 【权威实现位置】：
//   - 前端：src/features/chat/core/store/createChatStore.ts - getDisplayBlockIds()
//   - 后端：src-tauri/src/chat_v2/types.rs - get_active_block_ids()
// 
// 【统一逻辑】：
//   1. 无变体时：返回 message.blockIds
//   2. 有变体时：返回 activeVariant.blockIds
//   3. 找不到激活变体时：回退到 message.blockIds
// 
// 【重要】：本 Hook 应该使用 Store 的 getDisplayBlockIds() 方法，
// 不要在此处重复实现逻辑，以确保一致性。
// ============================================================================

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * useVariantUI - 变体 UI 管理 Hook
 *
 * 功能：
 * 1. 订阅消息和变体状态
 * 2. 计算派生状态（是否多变体、流式数量等）
 * 3. 提供变体操作方法
 * 4. 判断操作可用性
 */
export function useVariantUI({
  store,
  messageId,
}: UseVariantUIOptions): UseVariantUIResult {
  // 订阅消息
  const message = useStore(store, (s) => s.messageMap.get(messageId));

  // 派生状态
  const variants = useMemo(() => message?.variants ?? [], [message?.variants]);

  const activeVariantId = message?.activeVariantId;

  const activeVariant = useMemo(() => {
    return variants.find((v) => v.id === activeVariantId);
  }, [variants, activeVariantId]);

  // 单模型重新生成的历史版本（variant.meta.versioned === true）走单列 1/2 切换，不进入并行分栏视图
  const isVersioned = variants.length > 1 && variants.every((v) => v.meta?.versioned === true);
  const isMultiVariant = isParallelVariantViewEnabled() && variants.length > 1 && !isVersioned;
  const versionCount = isVersioned ? variants.length : 0;
  const activeVersionIndex = useMemo(() => {
    if (!isVersioned) return 0;
    const idx = variants.findIndex((v) => v.id === activeVariantId);
    return idx >= 0 ? idx : Math.max(0, variants.length - 1);
  }, [isVersioned, variants, activeVariantId]);

  const streamingCount = useMemo(
    () => variants.filter((v) => v.status === 'streaming').length,
    [variants]
  );

  // 🔧 P2优化：稳定 displayBlockIds 引用，避免不必要的重渲染
  // 🔧 P3修复：使用 Store 的 getDisplayBlockIds（权威实现，不再排序；块顺序由创建时的有序插入与终态归一化维护）
  // 确保刷新后思维链与工具调用保持交替顺序
  const prevDisplayBlockIdsRef = useRef<string[]>([]);
  const displayBlockIds = useMemo(() => {
    // 🔧 P3修复：使用 Store 的 getDisplayBlockIds（权威实现）而不是本地简单函数
    // 权威实现保持 blockIds 原始顺序（由创建时有序插入与终态归一化维护），
    // 渲染阶段不再排序，避免与后端持久化顺序漂移
    const newIds = store.getState().getDisplayBlockIds(messageId);
    
    // 浅比较，如果内容相同则返回之前的引用
    if (
      newIds.length === prevDisplayBlockIdsRef.current.length &&
      newIds.every((id, i) => id === prevDisplayBlockIdsRef.current[i])
    ) {
      return prevDisplayBlockIdsRef.current;
    }
    prevDisplayBlockIdsRef.current = newIds;
    return newIds;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- message 是有意的重算触发器：useMemo 内部通过 getState() 命令式读取，消息（变体/blockIds）变化时必须重算
  }, [store, messageId, message]);

  // 🔧 调试打点：追踪 displayBlockIds 计算
  useEffect(() => {
    // 🚀 性能：日志系统关闭时（生产环境默认）短路，避免每次 displayBlockIds
    // 变化都构造 variants 映射等日志数据
    if (isMultiVariant && isChatV2LoggingEnabled()) {
      logMultiVariant('store', 'useVariantUI_displayBlockIds', {
        messageId,
        isMultiVariant,
        activeVariantId,
        displayBlockIds,
        variantCount: variants.length,
        variants: variants.map(v => ({
          id: v.id,
          status: v.status,
          blockIds: v.blockIds,
        })),
        messageBlockIds: message?.blockIds ?? [],
      }, displayBlockIds.length > 0 ? 'info' : 'warning');
    }
  }, [messageId, isMultiVariant, activeVariantId, displayBlockIds, variants, message?.blockIds]);

  // 🔧 P0优化：不订阅整个 blocks Map，改为在调用时从 store 获取
  // 避免任何块变化都触发重渲染
  const getVariantBlocks = useCallback(
    (variantId: string): Block[] => {
      const variant = variants.find((v) => v.id === variantId);
      if (!variant) return [];

      const blocks = store.getState().blocks;
      return variant.blockIds
        .map((id) => blocks.get(id))
        .filter((b): b is Block => b !== undefined);
    },
    [store, variants]
  );

  // 切换变体（150ms 防抖由 Store 层处理）
  const switchVariant = useCallback(
    (variantId: string) => {
      const variant = variants.find((v) => v.id === variantId);
      if (!variant || !isVariantSwitchable(variant.status)) return;
      if (variantId === activeVariantId) return;

      // 直接调用 Store 的 switchVariant
      store.getState().switchVariant(messageId, variantId);
    },
    [store, messageId, variants, activeVariantId]
  );

  const prevSwitchableVariant = useMemo(() => {
    if (!isVersioned) return undefined;
    for (let i = activeVersionIndex - 1; i >= 0; i--) {
      if (isVariantSwitchable(variants[i]!.status)) return variants[i];
    }
    return undefined;
  }, [isVersioned, variants, activeVersionIndex]);

  const nextSwitchableVariant = useMemo(() => {
    if (!isVersioned) return undefined;
    for (let i = activeVersionIndex + 1; i < variants.length; i++) {
      if (isVariantSwitchable(variants[i]!.status)) return variants[i];
    }
    return undefined;
  }, [isVersioned, variants, activeVersionIndex]);

  const canPrevVersion = Boolean(prevSwitchableVariant);
  const canNextVersion = Boolean(nextSwitchableVariant);

  const switchToPrevVersion = useCallback(() => {
    if (prevSwitchableVariant) switchVariant(prevSwitchableVariant.id);
  }, [prevSwitchableVariant, switchVariant]);

  const switchToNextVersion = useCallback(() => {
    if (nextSwitchableVariant) switchVariant(nextSwitchableVariant.id);
  }, [nextSwitchableVariant, switchVariant]);

  // 取消变体
  const cancelVariant = useCallback(
    async (variantId: string) => {
      await store.getState().cancelVariant(variantId);
    },
    [store]
  );

  // 重试变体
  const retryVariant = useCallback(
    async (variantId: string) => {
      await store.getState().retryVariant(messageId, variantId);
    },
    [store, messageId]
  );

  // 删除变体
  const deleteVariant = useCallback(
    async (variantId: string) => {
      await store.getState().deleteVariant(messageId, variantId);
    },
    [store, messageId]
  );

  // 停止所有变体
  const stopAllVariants = useCallback(async () => {
    const streamingVariants = variants.filter(
      (v) => v.status === 'streaming' || v.status === 'pending'
    );
    await Promise.all(streamingVariants.map((v) => cancelVariant(v.id)));
  }, [variants, cancelVariant]);

  // 重试所有变体
  const retryAllVariants = useCallback(async () => {
    await store.getState().retryAllVariants(messageId);
  }, [store, messageId]);

  // 判断操作可用性
  const canSwitchTo = useCallback(
    (variant: Variant) => isVariantSwitchable(variant.status),
    []
  );

  const canRetry = useCallback(
    (variant: Variant) => isVariantRetryable(variant.status),
    []
  );

  const canCancel = useCallback(
    (variant: Variant) => isVariantCancellable(variant.status),
    []
  );

  const canDelete = useCallback(
    (variant: Variant) => {
      // 不能删除最后一个变体
      if (variants.length <= 1) return false;
      // 不能删除正在流式的变体
      if (variant.status === 'streaming') return false;
      return true;
    },
    [variants.length]
  );

  // 共享上下文（多变体检索结果）
  const sharedContext = message?.sharedContext;

  return {
    message,
    variants,
    activeVariant,
    activeVariantId,
    isMultiVariant,
    isVersioned,
    versionCount,
    activeVersionIndex,
    canPrevVersion,
    canNextVersion,
    switchToPrevVersion,
    switchToNextVersion,
    streamingCount,
    displayBlockIds,
    sharedContext,
    getVariantBlocks,
    switchVariant,
    cancelVariant,
    retryVariant,
    deleteVariant,
    stopAllVariants,
    retryAllVariants,
    canSwitchTo,
    canRetry,
    canCancel,
    canDelete,
  };
}

export default useVariantUI;
