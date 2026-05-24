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
import UnifiedSourcePanel from './UnifiedSourcePanel';
import { extractSourcesFromMessageBlocks, extractSourcesFromSharedContext, hasSourcesInBlocks } from './sourceAdapter';
import { useMessageBlocks } from '../../hooks/useChatStore';

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
export const SourcePanelV2: React.FC<SourcePanelV2Props> = ({ store, messageId, blocks: propBlocks, sharedContext, className }) => {
  // ========== 🚀 P2 性能优化：细粒度订阅 ==========
  // 使用 useMessageBlocks 替代手动订阅整个 blocks Map
  // 只有当该消息的块内容变化时才触发重渲染
  
  // 🚀 细粒度订阅：只订阅该消息相关的块
  const subscribedBlocks = useMessageBlocks(store, messageId);
  
  // 优先使用传入的 blocks（避免重复订阅），否则使用订阅的数据
  const messageBlocks = propBlocks ?? subscribedBlocks;

  // 转换为 UnifiedSourceBundle
  // 优先使用 sharedContext（多变体模式），否则从 blocks 提取
  const sourceBundle = useMemo(() => {
    // 1. 优先从 sharedContext 提取（多变体消息）
    if (sharedContext) {
      return extractSourcesFromSharedContext(sharedContext);
    }
    
    // 2. 从 blocks 提取（单变体消息）
    if (!hasSourcesInBlocks(messageBlocks)) {
      return null;
    }
    return extractSourcesFromMessageBlocks(messageBlocks);
  }, [sharedContext, messageBlocks]);

  // ========== 渲染 ==========

  // 无来源时不渲染
  if (!sourceBundle) {
    return null;
  }

  return <UnifiedSourcePanel data={sourceBundle} className={className} />;
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
