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
import { logMultiVariant } from '../../debug-panel/plugins/MultiVariantDebugPlugin';
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
  /** 正在流式生成的变体数量 */
  streamingCount: number;
  /** 是否显示并行流式预览 */
  showParallelView: boolean;
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
//   - 前端：src/chat-v2/core/store/createChatStore.ts - getDisplayBlockIds()
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

  // 🚩 Feature Flag：当 enableParallelVariantView 为 false 时，强制返回 false
  // 这样即使消息有多个变体，UI 也会降级为单变体展示（只显示激活变体）
  //
  // 多变体判断标准：variants.length > 1
  // - variants 为空或只有 1 个元素（单变体重试产生）：不是多变体
  // - variants 有 2+ 个元素（真正的多变体）：是多变体
  // 注意：此判断逻辑需与后端 types.rs 的 is_multi_variant() 保持一致
  const isMultiVariant = isParallelVariantViewEnabled() && variants.length > 1;

  const streamingCount = useMemo(
    () => variants.filter((v) => v.status === 'streaming').length,
    [variants]
  );

  // ============================================================================
  // 🔧 并行流式预览中间态 UI 控制
  // ============================================================================
  //
  // 【当前状态】禁用，保持 streaming 和 completed 状态的 UI 一致性
  //
  // 【设计意图】
  // - showParallelView 原本用于区分"并行流式预览"和"完成后对比"两种场景
  // - 当 streamingCount >= 2 时，可能需要特殊的预览 UI（如简化视图、进度条等）
  //
  // 【当前实现】
  // - MessageItem.tsx 实际使用 isMultiVariant 而非 showParallelView 来决定是否渲染 ParallelVariantView
  // - ParallelVariantView 已完善流式支持（BlockRendererWithStore 独立订阅、状态图标、动画指示器）
  // - 因此禁用 showParallelView 不影响当前功能，流式多变体能正确显示
  //
  // 【原逻辑】const showParallelView = streamingCount >= 2;
  //
  // TODO: 后续优化方向
  // 1. 如果需要区分"并行流式预览"和"完成后对比"的 UI 差异，可在 MessageItem 中使用 showParallelView
  // 2. 可考虑为流式预览添加：简化卡片视图、实时进度指示、自动聚焦最新内容等功能
  // 3. 如无差异化需求，可移除 showParallelView 字段，统一使用 isMultiVariant
  const showParallelView = false;

  // 🔧 P2优化：稳定 displayBlockIds 引用，避免不必要的重渲染
  // 🔧 P3修复：使用 Store 的 getDisplayBlockIds，它会按 firstChunkAt 排序
  // 确保刷新后思维链与工具调用保持交替顺序
  const prevDisplayBlockIdsRef = useRef<string[]>([]);
  const displayBlockIds = useMemo(() => {
    // 🔧 P3修复：使用 Store 的 getDisplayBlockIds 而不是本地简单函数
    // Store 版本会按 firstChunkAt/startedAt 排序，保持正确的时间顺序
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
  }, [store, messageId, message]);

  // 🔧 调试打点：追踪 displayBlockIds 计算
  useEffect(() => {
    if (isMultiVariant) {
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
    streamingCount,
    showParallelView,
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
