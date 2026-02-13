/**
 * Chat V2 - 操作守卫
 *
 * 守卫方法是纯函数，用于判断操作是否可执行。
 * 不产生副作用，只读取状态进行判断。
 */

import type { ChatStoreState } from './types';

// ============================================================================
// 守卫函数类型
// ============================================================================

/**
 * 守卫函数集合
 * 所有守卫方法都是纯函数，基于当前状态返回布尔值
 */
export interface Guards {
  /** 是否可以发送消息 */
  canSend: () => boolean;

  /** 是否可以编辑指定消息 */
  canEdit: (messageId: string) => boolean;

  /** 是否可以删除指定消息 */
  canDelete: (messageId: string) => boolean;

  /** 是否可以中断流式 */
  canAbort: () => boolean;

  /** 指定块是否被锁定 */
  isBlockLocked: (blockId: string) => boolean;

  /** 指定消息是否被锁定 */
  isMessageLocked: (messageId: string) => boolean;
}

// ============================================================================
// 守卫工厂函数
// ============================================================================

/**
 * 创建守卫方法
 * @param getState 获取当前状态的函数
 * @returns 守卫方法集合
 */
export function createGuards(getState: () => ChatStoreState): Guards {
  /**
   * 检查指定块是否被锁定（正在运行中）
   */
  const isBlockLocked = (blockId: string): boolean => {
    const state = getState();
    return state.activeBlockIds.has(blockId);
  };

  /**
   * 检查指定消息是否被锁定
   * 如果消息的任意块正在运行中，则消息被锁定
   */
  const isMessageLocked = (messageId: string): boolean => {
    const state = getState();
    const message = state.messageMap.get(messageId);
    if (!message) return false;

    // 检查消息的所有块是否有任一在活跃集合中
    return message.blockIds.some((blockId) => state.activeBlockIds.has(blockId));
  };

  /**
   * 检查是否可以发送消息
   * 只有在 idle 状态下才能发送
   */
  const canSend = (): boolean => {
    const state = getState();
    return state.sessionStatus === 'idle';
  };

  /**
   * 检查是否可以编辑指定消息
   * 🔧 P1修复：同时检查 sessionStatus 和消息锁定状态
   * - 在 streaming/aborting 状态下禁止编辑（即使消息未被锁定）
   * - 消息被锁定时也禁止编辑
   */
  const canEdit = (messageId: string): boolean => {
    const state = getState();
    // streaming/aborting 状态下禁止编辑，避免上下文不一致
    if (state.sessionStatus === 'streaming' || state.sessionStatus === 'aborting') {
      return false;
    }
    return !isMessageLocked(messageId);
  };

  /**
   * 检查是否可以删除指定消息
   * 🔧 P1修复：同时检查 sessionStatus 和消息锁定状态
   * - 在 streaming/aborting 状态下禁止删除（即使消息未被锁定）
   * - 消息被锁定时也禁止删除
   */
  const canDelete = (messageId: string): boolean => {
    const state = getState();
    // streaming/aborting 状态下禁止删除，避免上下文不一致
    if (state.sessionStatus === 'streaming' || state.sessionStatus === 'aborting') {
      return false;
    }
    return !isMessageLocked(messageId);
  };

  /**
   * 检查是否可以中断流式
   * 只有在 streaming 状态下才能中断
   */
  const canAbort = (): boolean => {
    const state = getState();
    return state.sessionStatus === 'streaming';
  };

  return {
    canSend,
    canEdit,
    canDelete,
    canAbort,
    isBlockLocked,
    isMessageLocked,
  };
}
