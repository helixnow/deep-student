/**
 * Chat V2 - SessionManager Hooks
 *
 * 多会话管理相关的 Hooks 和工具函数。
 * 这是对 core/session 模块的便捷封装。
 *
 * @see 05-多会话管理.md
 */

import { useMemo, useCallback, useEffect, useState } from 'react';
import { useStore, type StoreApi } from 'zustand';
import {
  sessionManager,
  type CreateSessionOptions,
  type ISessionManager,
  type SessionManagerEvent,
  type SessionManagerListener,
  type ChatStoreApi,
} from '../core/session';
import type { ChatStore } from '../core/types';

// ============================================================================
// 常量
// ============================================================================

/** 默认最大会话数 */
export const MAX_SESSIONS = 10;

// ============================================================================
// 核心 Hooks
// ============================================================================

/**
 * 获取会话 Store 的状态（直接返回 ChatStore）
 *
 * 这是文档09中要求的便捷 Hook，直接返回 ChatStore 状态，
 * 适用于需要订阅整个 store 状态的场景。
 *
 * @param sessionId 会话 ID
 * @returns ChatStore 状态
 *
 * @example
 * ```tsx
 * function ChatComponent({ sessionId }: { sessionId: string }) {
 *   const store = useSessionStore(sessionId);
 *   return <div>{store.messageOrder.length} messages</div>;
 * }
 * ```
 *
 * @deprecated 会订阅整个 store：流式期间每次 chunk flush 都会触发消费组件
 *             重渲染，属于反模式。请改用 useSessionStoreSelector（带选择器）
 *             或 useChatSession + useChatStore 系列细粒度 hooks。
 *             保留仅为兼容既有调用方，请勿在新代码中使用。
 */
export function useSessionStore(sessionId: string): ChatStore {
  const storeApi = useMemo(
    () => sessionManager.getOrCreate(sessionId),
    [sessionId]
  );
  return useStore(storeApi);
}

/**
 * 获取会话 Store 的状态（带选择器，减少重渲染）
 *
 * @param sessionId 会话 ID
 * @param selector 状态选择器
 * @returns 选择的状态片段
 *
 * @example
 * ```tsx
 * function MessageCount({ sessionId }: { sessionId: string }) {
 *   const count = useSessionStoreSelector(
 *     sessionId,
 *     (s) => s.messageOrder.length
 *   );
 *   return <span>{count}</span>;
 * }
 * ```
 */
export function useSessionStoreSelector<T>(
  sessionId: string,
  selector: (state: ChatStore) => T
): T {
  const storeApi = useMemo(
    () => sessionManager.getOrCreate(sessionId),
    [sessionId]
  );
  return useStore(storeApi, selector);
}

/**
 * 获取会话 Store API（返回 StoreApi，适合高级用法）
 *
 * @param sessionId 会话 ID
 * @param options 创建选项
 * @returns StoreApi<ChatStore> 实例
 *
 * @example
 * ```tsx
 * function ChatContainer({ sessionId }: { sessionId: string }) {
 *   const storeApi = useSessionStoreApi(sessionId, { preload: true });
 *   const messageOrder = useStore(storeApi, (s) => s.messageOrder);
 *   // ...
 * }
 * ```
 */
export function useSessionStoreApi(
  sessionId: string,
  options?: CreateSessionOptions
): ChatStoreApi {
  return useMemo(
    () => sessionManager.getOrCreate(sessionId, options),
    [sessionId, options?.mode, options?.preload]
  );
}

// ============================================================================
// 会话生命周期 Hooks
// ============================================================================

/**
 * 管理会话生命周期，组件卸载时可选销毁会话
 *
 * @param sessionId 会话 ID
 * @param destroyOnUnmount 组件卸载时是否销毁会话（默认 false）
 * @returns StoreApi<ChatStore> 实例
 *
 * @example
 * ```tsx
 * // 组件卸载时销毁会话
 * function TemporaryChat({ sessionId }: { sessionId: string }) {
 *   const storeApi = useSessionWithLifecycle(sessionId, true);
 *   // 组件卸载时会话会被销毁
 * }
 * ```
 */
export function useSessionWithLifecycle(
  sessionId: string,
  destroyOnUnmount = false
): ChatStoreApi {
  const storeApi = useMemo(
    () => sessionManager.getOrCreate(sessionId),
    [sessionId]
  );

  useEffect(() => {
    return () => {
      if (destroyOnUnmount) {
        sessionManager.destroy(sessionId).catch((err) => {
          console.error('[SessionManager] Failed to destroy session on unmount:', err);
        });
      }
    };
  }, [sessionId, destroyOnUnmount]);

  return storeApi;
}

// ============================================================================
// 会话状态监听 Hooks
// ============================================================================

/**
 * 监听 SessionManager 事件
 *
 * @param listener 事件监听器
 *
 * @example
 * ```tsx
 * function SessionMonitor() {
 *   useSessionManagerEvents((event) => {
 *     if (event.type === 'session-created') {
 *       console.log('New session:', event.sessionId);
 *     }
 *   });
 *   return null;
 * }
 * ```
 */
export function useSessionManagerEvents(listener: SessionManagerListener): void {
  useEffect(() => {
    const unsubscribe = sessionManager.subscribe(listener);
    return unsubscribe;
  }, [listener]);
}

/**
 * 获取所有会话 ID 列表
 *
 * @param pollInterval 轮询间隔（毫秒），默认 1000
 * @returns 所有会话 ID 列表
 */
export function useAllSessionIds(pollInterval = 1000): string[] {
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    // 内容相同则保留旧引用，避免每次轮询都因新数组引用触发重渲染
    const syncIds = () => {
      setIds((prev) => {
        const next = sessionManager.getAllSessionIds();
        if (
          prev.length === next.length &&
          next.every((id, i) => id === prev[i])
        ) {
          return prev;
        }
        return next;
      });
    };

    syncIds();
    const interval = setInterval(syncIds, pollInterval);

    return () => clearInterval(interval);
  }, [pollInterval]);

  return ids;
}

/**
 * 检查指定会话是否正在流式
 *
 * @param sessionId 会话 ID
 * @returns 是否正在流式
 */
export function useIsSessionStreaming(sessionId: string): boolean {
  // 🔧 使用 peek：渲染期的推测性读取不应更新 LRU 顺序（get 会 touch，
  // 导致仅仅被列表渲染过的会话持续保鲜、干扰淘汰决策）
  const storeApi = sessionManager.peek(sessionId);
  const [isStreaming, setIsStreaming] = useState(
    (storeApi?.getState().sessionStatus === 'streaming') || false
  );

  useEffect(() => {
    if (!storeApi) {
      setIsStreaming(false);
      return;
    }

    // 初始状态
    setIsStreaming(storeApi.getState().sessionStatus === 'streaming');

    // 订阅变化（setState 值未变时 React 会自动 bail out，不产生重渲染）
    const unsubscribe = storeApi.subscribe((state) => {
      setIsStreaming(state.sessionStatus === 'streaming');
    });

    return unsubscribe;
  }, [sessionId, storeApi]);

  return isStreaming;
}

// ============================================================================
// 便捷操作 Hooks
// ============================================================================

/**
 * 批量销毁会话
 *
 * @returns 批量销毁函数
 */
export function useDestroyMultipleSessions(): (sessionIds: string[]) => Promise<void> {
  return useCallback(async (sessionIds: string[]) => {
    await Promise.all(sessionIds.map((id) => sessionManager.destroy(id)));
  }, []);
}

/**
 * 获取会话统计信息
 */
export interface SessionStats {
  /** 总会话数 */
  total: number;
  /** 正在流式的会话数 */
  streaming: number;
  /** 空闲会话数 */
  idle: number;
  /** 最大会话数限制 */
  maxSessions: number;
}

/**
 * 获取会话统计信息
 *
 * @param pollInterval 轮询间隔（毫秒），默认 1000
 * @returns 会话统计信息
 */
export function useSessionStats(pollInterval = 1000): SessionStats {
  const [stats, setStats] = useState<SessionStats>({
    total: 0,
    streaming: 0,
    idle: 0,
    maxSessions: MAX_SESSIONS,
  });

  useEffect(() => {
    const updateStats = () => {
      const total = sessionManager.getSessionCount();
      const streaming = sessionManager.getActiveStreamingSessions().length;
      const maxSessions = sessionManager.getMaxSessions();
      // 数值未变化时保留旧对象引用，避免每次轮询都触发重渲染
      setStats((prev) =>
        prev.total === total &&
        prev.streaming === streaming &&
        prev.maxSessions === maxSessions
          ? prev
          : {
              total,
              streaming,
              idle: total - streaming,
              maxSessions,
            }
      );
    };

    updateStats();
    const interval = setInterval(updateStats, pollInterval);

    return () => clearInterval(interval);
  }, [pollInterval]);

  return stats;
}

// ============================================================================
// Re-exports
// ============================================================================

// 从 core/session 重新导出，方便直接从 hooks 导入
export {
  sessionManager,
  type ISessionManager,
  type CreateSessionOptions,
  type SessionManagerEvent,
  type SessionManagerListener,
  type ChatStoreApi,
};
