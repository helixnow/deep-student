/**
 * Chat V2 - useStreamingSessions Hook
 *
 * 监听所有正在流式的会话（事件驱动，无轮询）
 */

import { useState, useEffect, useCallback } from 'react';
import { sessionManager } from '../core/session';
import type { SessionManagerEvent } from '../core/session/types';

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * 获取所有正在流式的会话 ID
 *
 * 使用 SessionManager 的 'streaming-change' 事件驱动更新，
 * 替代之前的 setInterval 轮询，减少不必要的渲染和计算开销。
 *
 * @returns 正在流式的会话 ID 列表
 */
export function useStreamingSessions(): string[] {
  const [sessions, setSessions] = useState<string[]>(() =>
    sessionManager.getActiveStreamingSessions()
  );

  useEffect(() => {
    // 初始化同步（处理 StrictMode 双重挂载等边界情况）
    setSessions(sessionManager.getActiveStreamingSessions());

    // 订阅事件驱动更新
    const unsubscribe = sessionManager.subscribe((event: SessionManagerEvent) => {
      if (
        event.type === 'streaming-change' ||
        event.type === 'session-destroyed' ||
        event.type === 'session-evicted'
      ) {
        setSessions(sessionManager.getActiveStreamingSessions());
      }
    });

    return unsubscribe;
  }, []);

  return sessions;
}

/**
 * 获取会话总数
 *
 * 使用 SessionManager 的会话生命周期事件驱动更新，
 * 替代之前的 setInterval 轮询。
 */
export function useSessionCount(): number {
  const [count, setCount] = useState(() => sessionManager.getSessionCount());

  useEffect(() => {
    setCount(sessionManager.getSessionCount());

    const unsubscribe = sessionManager.subscribe((event: SessionManagerEvent) => {
      if (
        event.type === 'session-created' ||
        event.type === 'session-destroyed' ||
        event.type === 'session-evicted'
      ) {
        setCount(sessionManager.getSessionCount());
      }
    });

    return unsubscribe;
  }, []);

  return count;
}

/**
 * 销毁会话 Hook
 */
export function useDestroySession(): (sessionId: string) => Promise<void> {
  return useCallback((sessionId: string) => {
    return sessionManager.destroy(sessionId);
  }, []);
}

/**
 * 销毁所有会话 Hook
 */
export function useDestroyAllSessions(): () => Promise<void> {
  return useCallback(() => {
    return sessionManager.destroyAll();
  }, []);
}
