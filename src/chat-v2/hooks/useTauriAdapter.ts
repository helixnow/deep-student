/**
 * Chat V2 - Tauri 适配器 Hook
 *
 * 封装 ChatV2TauriAdapter 的使用，通过 AdapterManager 管理生命周期。
 *
 * 🔧 多会话保活优化（2025-12-04）：
 * - 使用 AdapterManager 管理适配器，确保多会话同时保活
 * - 组件卸载时只减少引用计数，不 cleanup 适配器
 * - 适配器只在会话销毁时才被 cleanup
 * - 非聚焦会话的事件监听器保持活跃，流式不会中断
 *
 * 约束：
 * 1. 组件挂载时通过 AdapterManager 获取适配器
 * 2. 组件卸载时通过 AdapterManager 释放引用
 * 3. 返回适配器实例供组件使用
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { StoreApi } from 'zustand';
import { ChatV2TauriAdapter } from '../adapters/TauriAdapter';
import { adapterManager } from '../adapters/AdapterManager';
import type { ChatStore, AttachmentMeta } from '../core/types';
import { getErrorMessage } from '../../utils/errorUtils';
import { sessionSwitchPerf } from '../debug/sessionSwitchPerf';
import { debugLog } from '../../debug-panel/debugMasterSwitch';

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[ChatV2:useTauriAdapter]';
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// ============================================================================
// Hook 返回类型
// ============================================================================

export interface UseTauriAdapterResult {
  /** 适配器实例（setup 完成后可用） */
  adapter: ChatV2TauriAdapter | null;

  /** 是否正在初始化 */
  isLoading: boolean;

  /** 初始化错误 */
  error: string | null;

  /** 适配器是否已就绪 */
  isReady: boolean;

  /** 手动重新初始化 */
  reinitialize: () => Promise<void>;

  // ========== 便捷方法（文档要求） ==========

  /** 发送消息 */
  sendMessage: (content: string, attachments?: AttachmentMeta[]) => Promise<void>;

  /** 中断流式 */
  abortStream: () => Promise<void>;

  /** 加载会话 */
  loadSession: () => Promise<void>;

  /** 保存会话 */
  saveSession: () => Promise<void>;
}

// ============================================================================
// useTauriAdapter Hook
// ============================================================================

/**
 * Tauri 适配器 Hook
 *
 * 自动管理 ChatV2TauriAdapter 的生命周期：
 * - 组件挂载时创建适配器并调用 setup()
 * - 组件卸载时调用 cleanup()
 *
 * @param sessionId 会话 ID
 * @param store ChatStore 实例
 * @returns 适配器状态和实例
 *
 * @example
 * ```tsx
 * function ChatComponent({ sessionId }: { sessionId: string }) {
 *   const store = useChatSession(sessionId);
 *   const { adapter, isReady, error } = useTauriAdapter(sessionId, store);
 *
 *   if (!isReady) return <Loading />;
 *   if (error) return <Error message={error} />;
 *
 *   // 使用 adapter 调用后端方法
 *   const handleSend = async (content: string) => {
 *     await adapter?.sendMessage(content);
 *   };
 * }
 * ```
 */

// 🚀 性能优化：合并 state 减少重渲染次数
interface AdapterState {
  isLoading: boolean;
  error: string | null;
  isReady: boolean;
}

const INITIAL_STATE: AdapterState = {
  isLoading: true,
  error: null,
  isReady: false,
};

/**
 * 重载 1: 接受 StoreApi<ChatStore>（推荐）
 */
export function useTauriAdapter(
  sessionId: string,
  store: StoreApi<ChatStore> | null
): UseTauriAdapterResult;
/**
 * 重载 2: 接受 ChatStore（向后兼容）
 * @deprecated 请使用 StoreApi<ChatStore> 版本
 */
export function useTauriAdapter(
  sessionId: string,
  store: ChatStore | null
): UseTauriAdapterResult;
export function useTauriAdapter(
  sessionId: string,
  store: StoreApi<ChatStore> | ChatStore | null
): UseTauriAdapterResult {
  // 🚀 性能优化：使用单个 state 对象而不是多个独立 state
  // 这样可以将多次 setState 合并为一次，减少 ChatContainer 重渲染次数
  const [state, setState] = useState<AdapterState>(INITIAL_STATE);

  // 使用 ref 存储适配器实例
  const adapterRef = useRef<ChatV2TauriAdapter | null>(null);
  // 追踪当前 sessionId，用于检测变化
  const sessionIdRef = useRef<string>(sessionId);
  // 追踪是否已卸载
  const isMountedRef = useRef(true);

  /**
   * 获取 StoreApi
   */
  const getStoreApi = useCallback((): StoreApi<ChatStore> | null => {
    if (!store) return null;
    // 检查是否是 StoreApi（有 getState 方法）
    if (typeof (store as StoreApi<ChatStore>).getState === 'function') {
      return store as StoreApi<ChatStore>;
    }
    // 如果是 ChatStore 本身，无法使用 AdapterManager
    console.warn(LOG_PREFIX, 'Received ChatStore instead of StoreApi, AdapterManager requires StoreApi');
    return null;
  }, [store]);

  /**
   * 🔧 多会话保活：通过 AdapterManager 获取适配器
   */
  const initialize = useCallback(async () => {
    const storeApi = getStoreApi();
    if (!storeApi) {
      console.warn(LOG_PREFIX, 'StoreApi not available, skipping initialization');
      setState(prev => ({ ...prev, isLoading: false }));
      return;
    }

    // 📊 性能打点：开始追踪会话切换
    sessionSwitchPerf.startTrace(sessionId);

    // 📊 细粒度打点：adapter 状态变化 - 开始
    sessionSwitchPerf.mark('cc_adapter_state', { state: 'init_start' });
    // 🚀 性能优化：单次 setState 替代三次
    setState({ isLoading: true, error: null, isReady: false });

    // 🚀 性能优化：监听 store 的 isDataLoaded 变化，在数据就绪时立即设置 isReady
    // 这样可以避免等待 React 渲染阻塞的微任务队列（通常 300-500ms）
    let hasSetReadyEarly = false;
    let prevIsDataLoaded = storeApi.getState().isDataLoaded;
    const unsubscribeDataLoaded = storeApi.subscribe((state) => {
      const isDataLoaded = state.isDataLoaded;
      // 只在 isDataLoaded 从 false 变为 true 时触发
      if (isDataLoaded && !prevIsDataLoaded && !hasSetReadyEarly && isMountedRef.current) {
        hasSetReadyEarly = true;
        sessionSwitchPerf.mark('cc_adapter_state', { state: 'data_loaded_early' });
        console.log(LOG_PREFIX, `Data loaded early for ${sessionId}, setting isReady`);
        
        // 获取 adapter 引用（如果已创建）
        const entry = adapterManager.get(sessionId);
        if (entry) {
          adapterRef.current = entry.adapter;
          // 立即设置 isReady，不等待 getOrCreate 返回
          setState({ isLoading: false, error: null, isReady: true });
        }
      }
      prevIsDataLoaded = isDataLoaded;
    });

    try {
      // 🔧 使用 AdapterManager 获取或创建适配器
      // AdapterManager 会复用已存在的适配器，不会重复创建
      console.log(LOG_PREFIX, `Getting adapter for session: ${sessionId}`);
      const wasAlreadyReady = adapterManager.isReady(sessionId);
      
      // 📊 细粒度打点：await getOrCreate 前
      const getOrCreateStart = performance.now();
      sessionSwitchPerf.mark('cc_get_or_create_start', { wasAlreadyReady });
      
      const entry = await adapterManager.getOrCreate(sessionId, storeApi);
      
      // 取消订阅（如果还没取消）
      unsubscribeDataLoaded();
      
      // 📊 细粒度打点：await getOrCreate 后
      const getOrCreateMs = performance.now() - getOrCreateStart;
      sessionSwitchPerf.mark('cc_get_or_create_end', { 
        getOrCreateMs, 
        isReady: entry.isReady,
        refCount: entry.refCount,
        earlyReady: hasSetReadyEarly,
      });
      
      // 📊 性能打点：如果适配器已经 ready，表示缓存命中
      if (wasAlreadyReady && entry.isReady) {
        sessionSwitchPerf.mark('adapter_already_setup', { 
          fromCache: true,
          refCount: entry.refCount,
        });
        // 不结束追踪，等待 MessageList 的 first_render
      } else {
        sessionSwitchPerf.mark('cc_adapter_state', { 
          state: 'setup_done',
          wasAlreadyReady,
          isReady: entry.isReady,
          refCount: entry.refCount,
        });
      }
      
      // 检查组件是否已卸载
      if (!isMountedRef.current) {
        console.log(LOG_PREFIX, 'Component unmounted during setup, releasing...');
        adapterManager.release(sessionId);
        return;
      }

      adapterRef.current = entry.adapter;
      sessionIdRef.current = sessionId;

      // 🚀 性能优化：如果已经提前设置了 isReady，跳过重复的 setState
      if (!hasSetReadyEarly && isMountedRef.current) {
        sessionSwitchPerf.mark('cc_adapter_state', { state: 'init_done' });
        setState({
          isLoading: false,
          error: entry.error || null,
          isReady: entry.error ? false : entry.isReady,
        });
      } else if (isMountedRef.current) {
        sessionSwitchPerf.mark('cc_adapter_state', { state: 'init_done_skipped' });
      }

      console.log(LOG_PREFIX, `Adapter ready for session: ${sessionId}, isReady: ${entry.isReady}, earlyReady: ${hasSetReadyEarly}`);
    } catch (err: unknown) {
      // 取消订阅
      unsubscribeDataLoaded();
      
      const errorMsg = getErrorMessage(err);
      console.error(LOG_PREFIX, 'Setup failed:', errorMsg);
      
      if (isMountedRef.current) {
        // 🚀 性能优化：单次 setState
        sessionSwitchPerf.mark('cc_adapter_state', { state: 'init_done' });
        setState({ isLoading: false, error: errorMsg, isReady: false });
      }
    }
  }, [sessionId, getStoreApi]);

  /**
   * 手动重新初始化
   */
  const reinitialize = useCallback(async () => {
    console.log(LOG_PREFIX, 'Reinitializing adapter...');
    await initialize();
  }, [initialize]);

  // ========== 便捷方法（文档要求） ==========

  /**
   * 发送消息
   */
  const sendMessage = useCallback(
    async (content: string, attachments?: AttachmentMeta[]) => {
      if (!adapterRef.current) {
        console.warn(LOG_PREFIX, 'Adapter not ready, cannot send message');
        return;
      }
      await adapterRef.current.sendMessage(content, attachments);
    },
    []
  );

  /**
   * 中断流式
   */
  const abortStream = useCallback(async () => {
    if (!adapterRef.current) {
      console.warn(LOG_PREFIX, 'Adapter not ready, cannot abort stream');
      return;
    }
    await adapterRef.current.abortStream();
  }, []);

  /**
   * 加载会话
   */
  const loadSession = useCallback(async () => {
    if (!adapterRef.current) {
      console.warn(LOG_PREFIX, 'Adapter not ready, cannot load session');
      return;
    }
    await adapterRef.current.loadSession();
  }, []);

  /**
   * 保存会话
   */
  const saveSession = useCallback(async () => {
    if (!adapterRef.current) {
      console.warn(LOG_PREFIX, 'Adapter not ready, cannot save session');
      return;
    }
    await adapterRef.current.saveSession();
  }, []);

  // 初始化和清理
  // 🔧 修复：移除冗余的第二个 useEffect，避免 release/initialize 被调用两次
  // React 的 useEffect 在依赖变化时会先执行 cleanup，再执行新的 effect
  // 所以 sessionId 变化时，会自动：1) release(旧 sessionId) 2) initialize(新 sessionId)
  useEffect(() => {
    isMountedRef.current = true;
    sessionIdRef.current = sessionId;

    // 🚀 性能优化：缓存命中时使用同步路径，避免 await 让出控制权导致多次渲染
    const existingEntry = adapterManager.get(sessionId);
    if (existingEntry && existingEntry.isReady && !existingEntry.setupPromise && !existingEntry.error) {
      // 缓存命中且已就绪：同步设置状态，不调用异步的 initialize
      console.log(LOG_PREFIX, `Sync path: adapter already ready for ${sessionId}`);
      sessionSwitchPerf.startTrace(sessionId);
      sessionSwitchPerf.mark('cc_adapter_state', { state: 'sync_cache_hit' });
      
      existingEntry.refCount++;
      adapterRef.current = existingEntry.adapter;
      
      // 同步设置状态（只触发一次 setState）
      setState({ isLoading: false, error: null, isReady: true });
      
      sessionSwitchPerf.mark('adapter_already_setup', { fromCache: true, refCount: existingEntry.refCount, syncPath: true });
      sessionSwitchPerf.mark('cc_adapter_state', { state: 'sync_done' });
      return () => {
        isMountedRef.current = false;
        console.log(LOG_PREFIX, `Releasing adapter for session: ${sessionId}`);
        adapterManager.release(sessionId);
        adapterRef.current = null;
      };
    }

    // 异步初始化（新会话或需要等待 setup）
    initialize();

    // 🔧 多会话保活：组件卸载时只释放引用，不 cleanup 适配器
    // 适配器保持活跃，事件监听器继续工作
    return () => {
      isMountedRef.current = false;

      // 释放引用（不 cleanup）
      // 适配器只在会话销毁时才会被 cleanup
      console.log(LOG_PREFIX, `Releasing adapter for session: ${sessionId}`);
      adapterManager.release(sessionId);
      adapterRef.current = null;
    };
  }, [sessionId, store, initialize]);

  // 🚀 性能优化：使用 useMemo 稳定返回值，避免每次渲染创建新对象导致消费者重渲染
  return useMemo(
    () => ({
      adapter: adapterRef.current,
      isLoading: state.isLoading,
      error: state.error,
      isReady: state.isReady,
      reinitialize,
      // 便捷方法
      sendMessage,
      abortStream,
      loadSession,
      saveSession,
    }),
    [state.isLoading, state.error, state.isReady, reinitialize, sendMessage, abortStream, loadSession, saveSession]
  );
}

// ============================================================================
// 导出类型
// ============================================================================

export type { ChatV2TauriAdapter };
