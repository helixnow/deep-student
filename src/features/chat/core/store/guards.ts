/**
 * Chat V2 - 操作守卫
 *
 * 守卫方法是纯函数，用于判断操作是否可执行。
 * 不产生副作用，只读取状态进行判断。
 */

import type { ChatStoreState } from './types';
import { QUEUE_HARD_CAP, readBlockingInteraction } from '../types/queue';

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

  /** 是否可以入队消息（队列未达上限且功能启用） */
  canEnqueue: (queueEnabled: boolean) => boolean;

  /** 是否可以执行队列等量交换（草稿与队尾互换，允许在上限处净零变更） */
  canEnqueueSwap: (queueEnabled: boolean) => boolean;

  /** 是否可以从队列出队（idle、非空、未在出队、无阻塞交互、无失败项） */
  canDequeue: () => boolean;

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

  /**
   * 检查是否可以入队消息
   * - 队列功能必须启用
   * - 队列长度未达硬上限
   */
  const canEnqueue = (queueEnabled: boolean): boolean => {
    if (!queueEnabled) return false;
    const state = getState();
    return state.queuedMessages.length < QUEUE_HARD_CAP;
  };

  /**
   * 检查是否可以执行队列等量交换（recall + draft 入队尾的净零变更）
   * - 队列功能必须启用
   * - 在上限处仍允许（length === HARD_CAP），但不能超过
   */
  const canEnqueueSwap = (queueEnabled: boolean): boolean => {
    if (!queueEnabled) return false;
    const state = getState();
    return state.queuedMessages.length <= QUEUE_HARD_CAP;
  };

  /**
   * 检查是否可以从队列出队
   * - sessionStatus 必须为 idle
   * - 队列非空
   * - 未在出队中
   * - 无待处理的阻塞交互
   * - 队列中无失败项（halt-on-failure）
   */
  const canDequeue = (): boolean => {
    const state = getState();
    if (state.sessionStatus !== 'idle') return false;
    if (state.queuedMessages.length === 0) return false;
    if (state.dequeuing) return false;
    if (readBlockingInteraction(state) !== null) return false;
    if (state.queuedMessages.some((m) => m.status === 'failed')) return false;
    return true;
  };

  return {
    canSend,
    canEdit,
    canDelete,
    canAbort,
    canEnqueue,
    canEnqueueSwap,
    canDequeue,
    isBlockLocked,
    isMessageLocked,
  };
}
