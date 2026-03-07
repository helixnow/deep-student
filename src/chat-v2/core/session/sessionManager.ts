/**
 * Chat V2 - SessionManager 实现
 *
 * 管理多个 ChatStore 实例，提供 LRU 缓存和生命周期管理。
 * 单例模式，全局唯一实例。
 */

import type { StoreApi } from 'zustand';
import type { ChatStore } from '../types';
import { createChatStore } from '../store/createChatStore';
import { autoSave } from '../middleware/autoSave';
import { chunkBuffer } from '../middleware/chunkBuffer';
import {
  clearProcessedEventIds,
  clearBridgeState,
  clearEventContext,
} from '../middleware/eventBridge';
import { clearVariantDebounceTimersForSession } from '../store/variantActions';
import { adapterManager } from '../../adapters/AdapterManager';
import type {
  ISessionManager,
  CreateSessionOptions,
  SessionManagerEvent,
  SessionManagerListener,
  SessionMeta,
} from './types';
import { sessionSwitchPerf } from '../../debug/sessionSwitchPerf';

// ============================================================================
// SessionManager 实现
// ============================================================================

class SessionManagerImpl implements ISessionManager {
  /** 会话 Store 缓存 */
  private sessions = new Map<string, StoreApi<ChatStore>>();

  /** 会话元数据 */
  private sessionMeta = new Map<string, SessionMeta>();

  /** LRU 顺序（从旧到新） */
  private lruOrder: string[] = [];

  /** 最大缓存数 */
  private maxSessions = 10;

  /** 事件监听器 */
  private listeners = new Set<SessionManagerListener>();

  /** 流式状态订阅取消函数 */
  private streamingUnsubscribers = new Map<string, () => void>();

  /**
   * [FIX-LRU-EVICTION] Sessions with save-before-eviction in progress.
   *
   * Trade-off: We keep evictLRU() synchronous (getOrCreate is called inside
   * React useMemo and cannot become async) but defer cache deletion until the
   * autoSave promise settles. While a session is in this set it is still in
   * `this.sessions` (so the store is reachable) but is excluded from LRU
   * candidate selection and from the "effective size" calculation. If the user
   * navigates back to a pending-eviction session before save finishes, the
   * eviction is cancelled and the session stays in cache.
   */
  private pendingEvictions = new Set<string>();

  /** [FIX-P1-26] Current active session ID */
  private currentSessionId: string | null = null;

  // ========== 会话管理 ==========

  /**
   * 获取或创建会话 Store
   */
  getOrCreate(
    sessionId: string,
    options?: CreateSessionOptions
  ): StoreApi<ChatStore> {
    // 📊 性能打点：记录 store_get_or_create 阶段
    sessionSwitchPerf.mark('store_get_or_create', {
      currentSize: this.sessions.size,
      maxSize: this.maxSessions,
    });

    // 1. 已存在则返回并更新 LRU
    if (this.sessions.has(sessionId)) {
      // [FIX-LRU-EVICTION] Cancel pending eviction if user navigates back
      if (this.pendingEvictions.has(sessionId)) {
        this.pendingEvictions.delete(sessionId);
        console.log(`[SessionManager] Cancelled pending eviction for re-accessed session: ${sessionId}`);
      }
      this.touch(sessionId);
      // 📊 性能打点：缓存命中
      sessionSwitchPerf.mark('store_get_or_create', {
        cacheHit: true,
        sessionId,
        currentSize: this.sessions.size,
      });
      return this.sessions.get(sessionId)!;
    }
    
    // 📊 性能打点：缓存未命中
    sessionSwitchPerf.mark('store_get_or_create', {
      cacheHit: false,
      sessionId,
      currentSize: this.sessions.size,
    });

    // 2. 检查是否需要淘汰
    // [FIX-LRU-EVICTION] Use effective size: pending evictions are already
    // "logically freed" even though they are still in the Map until save completes.
    const effectiveSize = this.sessions.size - this.pendingEvictions.size;
    if (effectiveSize >= this.maxSessions) {
      this.evictLRU();
    }

    // 3. 创建新 Store
    const store = createChatStore(sessionId);
    this.sessions.set(sessionId, store);

    // 4. 记录元数据
    const meta: SessionMeta = {
      sessionId,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      mode: options?.mode ?? 'chat',
    };
    this.sessionMeta.set(sessionId, meta);

    // 5. 更新 LRU
    this.lruOrder.push(sessionId);

    // 6. 订阅流式状态变化
    this.subscribeToStreamingState(sessionId, store);

    // 7. 发送事件
    this.emit({ type: 'session-created', sessionId });

    // 8. 可选：预加载历史
    if (options?.preload) {
      store.getState().loadSession(sessionId).catch((err) => {
        console.error(`[SessionManager] Failed to preload session ${sessionId}:`, err);
      });
    }

    // 保存 initConfig 到元数据，供 TauriAdapter 使用
    if (options?.mode && options.initConfig) {
      meta.pendingInitConfig = options.initConfig;
      console.log(`[SessionManager] Saved pending initConfig for session ${sessionId}`);
    }

    return store;
  }

  /**
   * 仅获取会话 Store（不创建）
   */
  get(sessionId: string): StoreApi<ChatStore> | undefined {
    const store = this.sessions.get(sessionId);
    if (store) {
      this.touch(sessionId);
    }
    return store;
  }

  /**
   * 检查会话是否存在
   */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * 销毁会话
   * 
   * 销毁前会确保数据被保存，防止数据丢失。
   * [FIX-MULTI-SESSION] 同步销毁 AdapterManager 中的适配器
   */
  async destroy(sessionId: string): Promise<void> {
    // [FIX-RACE] Cancel pending eviction to prevent double cleanup:
    // If finalizeEviction runs after destroy has already cleaned up,
    // it would attempt to delete/cleanup resources a second time.
    this.pendingEvictions.delete(sessionId);

    const store = this.sessions.get(sessionId);
    if (!store) return;

    const state = store.getState();

    // 如果正在流式，先中断
    if (state.sessionStatus === 'streaming') {
      await state.abortStream();
    }

    // [FIX-P1] Flush and cleanup chunkBuffer for current session
    // Ensure all data is persisted, then release buffer resources
    chunkBuffer.flushAndCleanupSession(sessionId);
    
    // 执行最终保存（会等待任何正在进行的保存完成）
    try {
      await autoSave.forceImmediateSave(store.getState());
    } catch (error: unknown) {
      console.error(`[SessionManager] Final save failed for session ${sessionId}:`, error);
      // 继续销毁流程，但记录错误
    }

    // [FIX-P3] Cleanup all auto-save related state
    autoSave.cleanup(sessionId);

    // [FIX-P1] Cleanup event-related state to prevent memory leaks
    clearProcessedEventIds(sessionId);
    clearBridgeState(sessionId);
    clearEventContext(sessionId);

    // [FIX-P1-2026-01-11] Cleanup variant debounce timers (scoped to this session)
    clearVariantDebounceTimersForSession(sessionId);

    // 🆕 渐进披露：清理已加载的 Skills 状态（destroy 时也清理，避免内存泄漏）
    try {
      // 使用动态 import 避免循环依赖
      import('../../skills/progressiveDisclosure').then(({ clearSessionSkills }) => {
        clearSessionSkills(sessionId);
      });
    } catch (err: unknown) {
      console.error(`[SessionManager] Failed to clear skills for session ${sessionId}:`, err);
    }

    // [FIX-MULTI-SESSION] Destroy adapter (remove event listeners)
    // Only cleanup adapter when session is destroyed
    await adapterManager.destroy(sessionId);

    // 取消流式状态订阅
    const unsubscribe = this.streamingUnsubscribers.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      this.streamingUnsubscribers.delete(sessionId);
    }

    // 从 Map 和 LRU 中移除
    this.sessions.delete(sessionId);
    this.sessionMeta.delete(sessionId);
    this.lruOrder = this.lruOrder.filter((id) => id !== sessionId);

    // 发送事件
    this.emit({ type: 'session-destroyed', sessionId });
  }

  /**
   * 销毁所有会话
   */
  async destroyAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.destroy(id)));
  }

  // ========== Current Session Management ==========

  /**
   * [FIX-P1-26] Set current active session ID
   * Called by UI layer when switching sessions
   */
  setCurrentSessionId(sessionId: string | null): void {
    this.currentSessionId = sessionId;
    console.log('[SessionManager] setCurrentSessionId:', sessionId);
  }

  /**
   * [FIX-P1-26] Get current active session ID
   * Used to determine which session to inject context into
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  // ========== 状态查询 ==========

  /**
   * 获取所有正在流式的会话 ID
   */
  getActiveStreamingSessions(): string[] {
    return [...this.sessions.entries()]
      .filter(([_, store]) => store.getState().sessionStatus === 'streaming')
      .map(([id]) => id);
  }

  /**
   * 获取当前缓存的会话数量
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * 获取所有会话 ID
   */
  getAllSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * 获取会话元数据（内部使用）
   */
  getSessionMeta(sessionId: string): SessionMeta | undefined {
    return this.sessionMeta.get(sessionId);
  }

  /**
   * 清除待执行的初始化配置（TauriAdapter 调用）
   */
  clearPendingInitConfig(sessionId: string): void {
    const meta = this.sessionMeta.get(sessionId);
    if (meta) {
      delete meta.pendingInitConfig;
    }
  }

  // ========== LRU 管理 ==========

  /**
   * 更新 LRU 顺序
   */
  touch(sessionId: string): void {
    // 移到末尾（最新）
    this.lruOrder = this.lruOrder.filter((id) => id !== sessionId);
    this.lruOrder.push(sessionId);

    // 更新元数据
    const meta = this.sessionMeta.get(sessionId);
    if (meta) {
      meta.lastAccessedAt = Date.now();
    }
  }

  /**
   * 设置最大缓存数
   */
  setMaxSessions(max: number): void {
    this.maxSessions = max;
    // [FIX-LRU-EVICTION] Use effective size (pending evictions are already logically freed).
    // Break if evictLRU returns false (no evictable candidate) to avoid infinite loop.
    while (this.sessions.size - this.pendingEvictions.size > this.maxSessions) {
      if (!this.evictLRU()) break;
    }
  }

  /**
   * 获取最大缓存数
   */
  getMaxSessions(): number {
    return this.maxSessions;
  }

  // ========== 事件订阅 ==========

  /**
   * 订阅会话变化事件
   */
  subscribe(listener: SessionManagerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ========== 私有方法 ==========

  /**
   * 淘汰最久未使用的会话（非 streaming、非 pending eviction）
   *
   * [FIX-LRU-EVICTION] This method stays synchronous (callers like getOrCreate
   * are used inside React useMemo). Instead of deleting the session immediately,
   * we mark it as "pending eviction" and wait for the autoSave promise to settle
   * before removing from cache. This prevents data loss when the save is slow or
   * fails — the session remains accessible in cache until we know the save
   * succeeded (or failed with an error log).
   *
   * @returns true if an eviction was initiated, false if no candidate found
   */
  private evictLRU(): boolean {
    // 找到最久未使用且非 streaming、非 pending eviction 的会话
    for (const sessionId of this.lruOrder) {
      const store = this.sessions.get(sessionId);
      const state = store?.getState();
      const hasInFlightBlocks = !!state && (
        state.activeBlockIds.size > 0 ||
        Array.from(state.blocks.values()).some((block) => block.status === 'running' || block.status === 'pending')
      );
      if (
        store &&
        state.sessionStatus !== 'streaming' &&
        !hasInFlightBlocks &&
        !this.pendingEvictions.has(sessionId)
      ) {
        console.log(`[SessionManager] Evicting LRU session: ${sessionId}`);

        // Mark as pending — prevents re-selection and adjusts effective size
        this.pendingEvictions.add(sessionId);

        // Flush chunk buffer synchronously so all buffered data is available for save
        chunkBuffer.flushAndCleanupSession(sessionId);

        // Save data, then finalize eviction (cleanup + cache removal)
        autoSave
          .forceImmediateSave(store.getState())
          .then(() => {
            this.finalizeEviction(sessionId);
          })
          .catch((error) => {
            console.error(
              `[SessionManager] Save failed during eviction for session ${sessionId}, finalizing anyway to prevent cache growth:`,
              error
            );
            // 即使保存失败也完成淘汰，防止 sessions Map 无上限增长
            this.finalizeEviction(sessionId);
          });

        return true;
      }
    }

    // 如果所有会话都在 streaming 或 pending eviction，警告但不淘汰
    console.warn(
      '[SessionManager] All sessions are streaming or pending eviction, cannot evict'
    );
    return false;
  }

  /**
   * [FIX-LRU-EVICTION] Complete the eviction after save settles.
   *
   * If the user navigated back to this session while save was in flight,
   * `pendingEvictions` will no longer contain the ID and we skip cleanup
   * (the save still ran — good for data safety — but the session stays in cache).
   */
  private finalizeEviction(sessionId: string): void {
    // Eviction was cancelled (session re-accessed via getOrCreate) — keep it
    if (!this.pendingEvictions.has(sessionId)) {
      console.log(
        `[SessionManager] Eviction cancelled for re-accessed session: ${sessionId}, skipping cleanup`
      );
      return;
    }

    this.pendingEvictions.delete(sessionId);

    // Cleanup auto-save state
    autoSave.cleanup(sessionId);

    // Cleanup event-related state to prevent memory leaks
    clearProcessedEventIds(sessionId);
    clearBridgeState(sessionId);
    clearEventContext(sessionId);

    // Cleanup variant debounce timers (scoped to this session)
    clearVariantDebounceTimersForSession(sessionId);

    // 渐进披露：清理已加载的 Skills 状态
    try {
      import('../../skills/progressiveDisclosure').then(({ clearSessionSkills }) => {
        clearSessionSkills(sessionId);
      });
    } catch (err: unknown) {
      console.error(
        `[SessionManager] Failed to clear skills for session ${sessionId}:`,
        err
      );
    }

    // Destroy adapter with retry on failure
    const destroyAdapterWithRetry = async (retries = 2) => {
      for (let i = 0; i <= retries; i++) {
        try {
          await adapterManager.destroy(sessionId);
          return;
        } catch (err: unknown) {
          if (i === retries) {
            console.error(
              `[SessionManager] Adapter cleanup failed after ${retries + 1} attempts for ${sessionId}:`,
              err
            );
          } else {
            console.warn(
              `[SessionManager] Adapter cleanup attempt ${i + 1} failed for ${sessionId}, retrying...`
            );
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      }
    };
    destroyAdapterWithRetry();

    // 取消流式状态订阅
    const unsubscribe = this.streamingUnsubscribers.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      this.streamingUnsubscribers.delete(sessionId);
    }

    // 从缓存移除
    this.sessions.delete(sessionId);
    this.sessionMeta.delete(sessionId);
    this.lruOrder = this.lruOrder.filter((id) => id !== sessionId);

    // 发送事件
    this.emit({ type: 'session-evicted', sessionId });
  }

  /**
   * 订阅会话的流式状态变化
   */
  private subscribeToStreamingState(
    sessionId: string,
    store: StoreApi<ChatStore>
  ): void {
    let prevStreaming = store.getState().sessionStatus === 'streaming';

    const unsubscribe = store.subscribe((state) => {
      const isStreaming = state.sessionStatus === 'streaming';
      if (isStreaming !== prevStreaming) {
        prevStreaming = isStreaming;
        this.emit({
          type: 'streaming-change',
          sessionId,
          isStreaming,
        });
      }
    });

    this.streamingUnsubscribers.set(sessionId, unsubscribe);
  }

  /**
   * 发送事件给所有监听器
   */
  private emit(event: SessionManagerEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (err: unknown) {
        console.error('[SessionManager] Listener error:', err);
      }
    });
  }
}

// ============================================================================
// 单例导出
// ============================================================================

/**
 * SessionManager 单例实例
 */
export const sessionManager: ISessionManager = new SessionManagerImpl();

/**
 * 获取 SessionManager 实例
 * @deprecated 直接使用 sessionManager
 */
export function getSessionManager(): ISessionManager {
  return sessionManager;
}

// ============================================================================
// 🆕 P1防闪退：紧急保存函数注册
// ============================================================================

/**
 * 紧急保存所有活跃会话
 * 
 * 在 beforeunload/visibilitychange 时由 main.tsx 调用。
 * 使用同步方式触发保存（因为 beforeunload 不支持异步）。
 */
function emergencySaveAllSessions(): void {
  const activeSessions = sessionManager.getAllSessionIds();
  
  console.log(`[SessionManager] 🆘 Emergency save triggered for ${activeSessions.length} sessions`);
  
  for (const sessionId of activeSessions) {
    try {
      // 同步 flush chunkBuffer 确保流式数据写入 store
      try {
        chunkBuffer.flushSession(sessionId);
      } catch {
        // chunkBuffer flush 失败不阻塞保存
      }
      const store = sessionManager.get(sessionId);
      if (store) {
        autoSave.forceImmediateSave(store.getState()).catch((err) => {
          console.warn(`[SessionManager] Emergency save failed for ${sessionId}:`, err);
        });
      }
    } catch (err: unknown) {
      console.warn(`[SessionManager] Emergency save error for ${sessionId}:`, err);
    }
  }
}

// 注册到 window 对象，供 main.tsx 调用
if (typeof window !== 'undefined') {
  (window as any).__CHAT_V2_EMERGENCY_SAVE__ = {
    emergencySave: emergencySaveAllSessions,
  };
}
