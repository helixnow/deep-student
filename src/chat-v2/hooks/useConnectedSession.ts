/**
 * Chat V2 - useConnectedSession Hook
 *
 * 组合 useChatSession + useTauriAdapter，确保 Store 和后端连接同时建立。
 * 这是推荐的使用方式，避免忘记连接后端。
 */

import { useEffect, useState, useRef } from 'react';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../core/types';
import { useChatSession, type CreateSessionOptions } from './useChatSession';
import { useTauriAdapter, type UseTauriAdapterResult } from './useTauriAdapter';
import { sessionManager } from '../core/session';

// ============================================================================
// 返回类型
// ============================================================================

export interface UseConnectedSessionResult {
  /** Store 实例 */
  store: StoreApi<ChatStore>;
  /** 适配器状态 */
  adapter: UseTauriAdapterResult;
  /** 是否完全就绪（Store + Adapter） */
  isReady: boolean;
  /** 错误信息 */
  error: string | null;
  /** 会话是否被 SessionManager 淘汰（仅警告，不影响功能） */
  isEvicted: boolean;
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * 获取已连接后端的会话
 *
 * 自动处理：
 * 1. 创建/获取 Store
 * 2. 连接 TauriAdapter
 * 3. 管理生命周期
 *
 * @param sessionId 会话 ID
 * @param options 创建选项
 * @returns 完整的会话状态
 *
 * @example
 * ```tsx
 * function ChatPage({ sessionId }: { sessionId: string }) {
 *   const { store, isReady, error } = useConnectedSession(sessionId, { mode: 'chat' });
 *
 *   if (!isReady) return <Loading />;
 *   if (error) return <Error message={error} />;
 *
 *   return <ChatContainer sessionId={sessionId} />;
 * }
 * ```
 */
export function useConnectedSession(
  sessionId: string,
  options?: CreateSessionOptions
): UseConnectedSessionResult {
  // 1. 获取或创建 Store
  const store = useChatSession(sessionId, options);

  // 2. 连接 TauriAdapter
  const adapter = useTauriAdapter(sessionId, store);

  // 3. 监听会话淘汰事件（仅警告用途）
  const [isEvicted, setIsEvicted] = useState(false);

  useEffect(() => {
    const unsubscribe = sessionManager.subscribe((event) => {
      if (event.type === 'session-evicted' && event.sessionId === sessionId) {
        console.warn(
          `[useConnectedSession] Session ${sessionId} was evicted from SessionManager. ` +
          'The session is still functional but no longer tracked by LRU cache.'
        );
        setIsEvicted(true);
      }
    });

    return unsubscribe;
  }, [sessionId]);

  // 4. 计算完整就绪状态
  const isReady = adapter.isReady;
  const error = adapter.error;

  // 🚀 性能优化：使用 useRef 保持稳定的返回值引用
  // 只有当关键属性真正变化时才更新引用，避免因 adapter 对象变化导致消费者重渲染
  const resultRef = useRef<UseConnectedSessionResult | null>(null);
  
  // 检查关键属性是否变化
  const shouldUpdate = 
    resultRef.current === null ||
    resultRef.current.store !== store ||
    resultRef.current.isReady !== isReady ||
    resultRef.current.error !== error ||
    resultRef.current.isEvicted !== isEvicted;
  
  if (shouldUpdate) {
    resultRef.current = {
      store,
      adapter,
      isReady,
      error,
      isEvicted,
    };
  } else {
    // 更新 adapter 引用但保持外层对象引用不变
    // 这样消费者不会因为 adapter 对象变化而重渲染
    resultRef.current.adapter = adapter;
  }

  return resultRef.current;
}

export default useConnectedSession;
