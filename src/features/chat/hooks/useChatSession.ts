/**
 * Chat V2 - useChatSession Hook
 *
 * 获取或创建会话 Store
 */

import { useMemo } from 'react';
import type { StoreApi } from 'zustand';
import { sessionManager, type CreateSessionOptions } from '../core/session';
import type { ChatStore } from '../core/types';

// Re-export CreateSessionOptions for external use
export type { CreateSessionOptions } from '../core/session';

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * 获取或创建会话 Store
 *
 * @param sessionId 会话 ID
 * @param options 创建选项
 * @returns StoreApi<ChatStore> 实例
 *
 * 功能：
 * 1. 通过 SessionManager 获取或创建 Store
 * 2. 使用 useMemo 避免重复创建
 * 3. 支持预加载历史消息
 */
export function useChatSession(
  sessionId: string,
  options?: CreateSessionOptions
): StoreApi<ChatStore> {
  const store = useMemo(
    () => sessionManager.getOrCreate(sessionId, options),
    [sessionId, options?.mode, options?.preload]
  );

  return store;
}

/**
 * 仅获取会话 Store（不创建）
 *
 * @param sessionId 会话 ID
 * @returns Zustand StoreApi<ChatStore> 实例或 undefined
 */
export function useChatSessionIfExists(sessionId: string): StoreApi<ChatStore> | undefined {
  return useMemo(() => sessionManager.get(sessionId), [sessionId]);
}

/**
 * 检查会话是否存在
 *
 * @param sessionId 会话 ID
 * @returns 是否存在
 */
export function useHasSession(sessionId: string): boolean {
  return useMemo(() => sessionManager.has(sessionId), [sessionId]);
}
