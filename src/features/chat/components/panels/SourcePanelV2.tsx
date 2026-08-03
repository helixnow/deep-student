/**
 * Chat V2 - SourcePanelV2
 *
 * V2 封装组件，从 Store 订阅消息块数据，
 * 使用 sourceAdapter 转换为 UnifiedSourceBundle，
 * 然后渲染 UnifiedSourcePanel 纯展示组件。
 *
 * 遵循 SSOT 原则：UI 只订阅 Store，不直接修改状态
 */

import React, { useMemo } from 'react';
import { type StoreApi } from 'zustand';
import type { ChatStore } from '../../core/types/store';
import type { Block } from '../../core/types/block';
import type { SharedContext } from '../../core/types/message';
import type { UnifiedSourceBundle } from './sourceTypes';
import UnifiedSourcePanel from './UnifiedSourcePanel';
import {
  extractSourcesFromMessageBlocks,
  extractSourcesFromSharedContext,
  extractRetrievalErrors,
  hasActiveRetrievalInBlocks,
  hasSourcesInBlocks,
} from './sourceAdapter';
import { useMessageBlocks } from '../../hooks/useChatStore';
import { useStableSourceBlocks } from './useStableSourceBlocks';

/** 检索中但尚无来源时使用的空 bundle（保持引用稳定，避免面板重复重置状态） */
const EMPTY_BUNDLE: UnifiedSourceBundle = { total: 0, groups: [] };

// ============================================================================
// Props 定义
// ============================================================================

export interface SourcePanelV2Props {
  /**
   * V2 Store 实例
   * 由父组件（如 ChatHostV2）传入
   */
  store: StoreApi<ChatStore>;

  /**
   * 消息 ID
   * 用于从 Store 获取该消息关联的块
   */
  messageId: string;

  /**
   * 可选：直接传入已订阅的块数组
   * 如果提供，则跳过 Store 订阅，避免重复订阅
   * 这是性能优化选项，适用于父组件已订阅块的场景
   */
  blocks?: Block[];

  /**
   * 可选：只统计这些块的来源（多变体场景）
   * 不提供时使用整条消息的全部块。
   * P0-3 修复：变体卡片内的来源面板必须按 variant.blockIds 过滤，
   * 否则会把其他变体的引用来源串进当前卡片。
   */
  blockIds?: string[];

  /**
   * 可选：共享上下文（多变体消息使用）
   * 如果提供，优先从 sharedContext 提取来源
   * 适用于多变体模式，所有变体共享相同的检索结果
   */
  sharedContext?: SharedContext;

  /**
   * 额外的 CSS 类名
   */
  className?: string;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * SourcePanelV2 - V2 来源面板封装组件
 *
 * 职责：
 * 1. 从 Store 订阅指定消息的块数据，或从 sharedContext 提取来源
 * 2. 调用适配器将数据转换为 UnifiedSourceBundle
 * 3. 渲染 UnifiedSourcePanel 纯展示组件
 *
 * 特性：
 * - 细粒度订阅：只订阅相关块，避免不必要的重渲染
 * - 数据转换缓存：使用 useMemo 避免重复计算
 * - 空值处理：无来源时返回 null
 * - 多变体支持：优先使用 sharedContext（如果提供）
 */
export const SourcePanelV2: React.FC<SourcePanelV2Props> = ({ store, messageId, blocks: propBlocks, blockIds, sharedContext, className }) => {
  // ========== 🚀 P2 性能优化：细粒度订阅 ==========
  // 使用 useMessageBlocks 替代手动订阅整个 blocks Map
  // 只有当该消息的块内容变化时才触发重渲染
  
  // 🚀 细粒度订阅：只订阅该消息相关的块
  const subscribedBlocks = useMessageBlocks(store, messageId);
  
  // 优先使用传入的 blocks（避免重复订阅），否则使用订阅的数据
  const allMessageBlocks = propBlocks ?? subscribedBlocks;

  // P0-3: 提供 blockIds 时只保留对应的块（多变体：限定当前变体的来源）
  const messageBlocks = useMemo(
    () => (blockIds ? allMessageBlocks.filter((block) => blockIds.includes(block.id)) : allMessageBlocks),
    [allMessageBlocks, blockIds]
  );

  // 流式期间 content 块每次 flush 都让 messageBlocks 换新引用；
  // 折叠为"仅来源相关块"的稳定数组，来源未变时 bundle 保持同一引用，
  // 避免每 flush 重算 + 下游面板因 data 身份变化重置用户交互状态
  const sourceBlocks = useStableSourceBlocks(messageBlocks);

  // 检索进行中（pending/running 的知识检索块）→ 驱动面板"正在检索"内联态
  const isRetrieving = useMemo(() => hasActiveRetrievalInBlocks(sourceBlocks), [sourceBlocks]);

  // 转换为 UnifiedSourceBundle
  // 优先使用 sharedContext（多变体模式），否则从 blocks 提取
  const sourceBundle = useMemo(() => {
    // 1. 优先从 sharedContext 提取（多变体消息）；检索失败信息仍从 blocks 提取
    if (sharedContext) {
      const bundle = extractSourcesFromSharedContext(sharedContext);
      const errors = extractRetrievalErrors(sourceBlocks);
      if (!bundle) {
        return errors.length > 0 ? { total: 0, groups: [], errors } : null;
      }
      return errors.length > 0 ? { ...bundle, errors } : bundle;
    }

    // 2. 从 blocks 提取（单变体消息；内部已附带检索错误信息）
    return extractSourcesFromMessageBlocks(sourceBlocks);
  }, [sharedContext, sourceBlocks]);

  // ========== 渲染 ==========

  // 无来源、无检索中时不渲染
  if (!sourceBundle && !isRetrieving) {
    return null;
  }

  return (
    <UnifiedSourcePanel
      data={sourceBundle ?? EMPTY_BUNDLE}
      messageId={messageId}
      isRetrieving={isRetrieving}
      className={className}
    />
  );
};

// ============================================================================
// 便捷 Hook（可选，用于自定义场景）
// ============================================================================

/**
 * useMessageSources - 获取消息的来源数据
 *
 * 🚀 P2 性能优化：使用 useMessageBlocks 细粒度订阅
 * 用于需要直接访问来源数据而不渲染面板的场景
 *
 * @param store - V2 Store 实例
 * @param messageId - 消息 ID
 * @returns UnifiedSourceBundle 或 null
 */
export function useMessageSources(store: StoreApi<ChatStore>, messageId: string) {
  // 🚀 细粒度订阅：只订阅该消息相关的块
  const blocks = useMessageBlocks(store, messageId);

  return useMemo(() => {
    if (blocks.length === 0) {
      return null;
    }

    if (!hasSourcesInBlocks(blocks)) {
      return null;
    }

    return extractSourcesFromMessageBlocks(blocks);
  }, [blocks]);
}

/**
 * useHasMessageSources - 检查消息是否有来源（轻量级）
 *
 * 🚀 P2 性能优化：使用 useMessageBlocks 细粒度订阅
 *
 * @param store - V2 Store 实例
 * @param messageId - 消息 ID
 * @returns 是否有来源
 */
export function useHasMessageSources(store: StoreApi<ChatStore>, messageId: string): boolean {
  // 🚀 细粒度订阅：只订阅该消息相关的块
  const blocks = useMessageBlocks(store, messageId);

  return useMemo(() => {
    if (blocks.length === 0) {
      return false;
    }

    return hasSourcesInBlocks(blocks);
  }, [blocks]);
}

export default SourcePanelV2;
