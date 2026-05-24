/**
 * Chat V2 - 适配器管理器
 *
 * 管理所有 TauriAdapter 实例的生命周期，确保多会话同时保活。
 *
 * 🔧 解决的问题：
 * 原来 TauriAdapter 的生命周期绑定到 React 组件，会话切换时适配器被 cleanup，
 * 导致非聚焦会话的事件监听器被移除，流式中断。
 *
 * 新方案：
 * - AdapterManager 作为单例管理所有适配器
 * - 适配器只在会话销毁时才被 cleanup
 * - 会话切换时适配器保持活跃，事件监听器继续工作
 *
 * @see 05-多会话管理.md
 */

import type { StoreApi } from 'zustand';
import { ChatV2TauriAdapter } from './TauriAdapter';
import type { ChatStore } from '../core/types';
import { getErrorMessage } from '@/utils/errorUtils';
import { sessionSwitchPerf } from '../debug/sessionSwitchPerf';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[ChatV2:AdapterManager]';
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// ============================================================================
// 适配器状态
// ============================================================================

interface AdapterEntry {
  /** 适配器实例 */
  adapter: ChatV2TauriAdapter;
  /** 是否已 setup */
  isReady: boolean;
  /** setup 错误 */
  error: string | null;
  /** setup Promise（防止并发 setup） */
  setupPromise: Promise<void> | null;
  /** 引用计数（追踪有多少组件在使用） */
  refCount: number;
}

// ============================================================================
// AdapterManager 实现
// ============================================================================

/**
 * 适配器管理器
 *
 * 单例模式，管理所有 TauriAdapter 实例。
 *
 * 设计原则：
 * 1. 适配器生命周期与 SessionManager 中的 Store 对齐
 * 2. 适配器只在会话销毁时才被 cleanup
 * 3. 组件卸载时不 cleanup 适配器，只减少引用计数
 * 4. 支持并发 setup 请求（只执行一次）
 */
class AdapterManagerImpl {
  /** 适配器条目缓存 */
  private adapters = new Map<string, AdapterEntry>();

  /** 事件监听器 */
  private listeners = new Set<(event: AdapterManagerEvent) => void>();

  /**
   * 获取或创建适配器
   *
   * 如果适配器已存在且已 setup，直接返回。
   * 如果不存在，创建新适配器并 setup。
   * 如果正在 setup 中，等待 setup 完成。
   *
   * @param sessionId 会话 ID
   * @param store ChatStore 实例
   * @returns 适配器条目
   */
  async getOrCreate(
    sessionId: string,
    store: StoreApi<ChatStore>
  ): Promise<AdapterEntry> {
    // 📊 细粒度打点：进入 AdapterManager
    sessionSwitchPerf.mark('adapter_manager_enter');
    
    let entry = this.adapters.get(sessionId);

    if (entry) {
      // 📊 细粒度打点：找到现有适配器
      sessionSwitchPerf.mark('adapter_manager_found', { 
        refCount: entry.refCount,
        isReady: entry.isReady,
        hasSetupPromise: !!entry.setupPromise,
      });
      
      // 适配器已存在
      entry.refCount++;
      console.log(LOG_PREFIX, `Adapter exists for ${sessionId}, refCount: ${entry.refCount}`);

      // 如果正在 setup 中，等待完成
      if (entry.setupPromise) {
        console.log(LOG_PREFIX, `Waiting for setup: ${sessionId}`);
        // 📊 细粒度打点：等待其他 setup
        sessionSwitchPerf.mark('adapter_manager_wait_setup');
        await entry.setupPromise;
      }

      // 🔧 修复：如果之前 setup 失败，尝试重新 setup
      if (entry.error && !entry.isReady && !entry.setupPromise) {
        console.log(LOG_PREFIX, `Retrying setup for failed adapter: ${sessionId}`);
        entry.error = null;
        entry.setupPromise = this.setupAdapter(sessionId, entry);
        await entry.setupPromise;
      }

      // 📊 细粒度打点：退出 AdapterManager
      sessionSwitchPerf.mark('adapter_manager_exit', { 
        cached: true,
        refCount: entry.refCount,
        isReady: entry.isReady,
        hasSetupPromise: !!entry.setupPromise,
      });
      return entry;
    }

    // 📊 细粒度打点：创建新适配器
    sessionSwitchPerf.mark('adapter_manager_create');
    
    // 创建新适配器
    // 🔧 优化：传入 storeApi，使适配器能够获取最新状态，消除对 sessionManager 的依赖
    // 🔧 P31 诊断：详细记录 storeApi 传入情况
    const storeSnapshot = store.getState();
    console.log(LOG_PREFIX, `Creating adapter for ${sessionId}`, {
      storeType: typeof store,
      hasGetState: typeof store.getState === 'function',
      snapshotType: typeof storeSnapshot,
      snapshotMessageMapSize: storeSnapshot?.messageMap?.size,
    });
    
    // 🔧 P31 全局调试日志
    if ((window as any).__subagentFlowLog) {
      (window as any).__subagentFlowLog('AdapterManager', 'create_adapter', {
        sessionId,
        storeType: typeof store,
        hasGetState: typeof store.getState === 'function',
        isSubagent: sessionId.startsWith('agent_'),
      }, 'info');
    }
    
    const adapter = new ChatV2TauriAdapter(sessionId, storeSnapshot, store);
    
    // 🔧 P31 验证 adapter 的 storeApi 是否正确设置
    const adapterStoreApi = (adapter as any).storeApi;
    console.log(LOG_PREFIX, `Adapter created, storeApi check:`, {
      sessionId,
      hasStoreApi: !!adapterStoreApi,
      storeApiType: adapterStoreApi ? typeof adapterStoreApi : 'null',
      storeApiHasGetState: typeof adapterStoreApi?.getState === 'function',
    });
    
    if ((window as any).__subagentFlowLog) {
      (window as any).__subagentFlowLog('AdapterManager', 'adapter_created', {
        sessionId,
        hasStoreApi: !!adapterStoreApi,
        storeApiHasGetState: typeof adapterStoreApi?.getState === 'function',
      }, adapterStoreApi ? 'success' : 'error');
    }

    entry = {
      adapter,
      isReady: false,
      error: null,
      setupPromise: null,
      refCount: 1,
    };
    this.adapters.set(sessionId, entry);

    // 执行 setup
    entry.setupPromise = this.setupAdapter(sessionId, entry);
    await entry.setupPromise;

    // 📊 细粒度打点：退出 AdapterManager
    sessionSwitchPerf.mark('adapter_manager_exit', { 
      cached: false,
      refCount: entry.refCount,
      isReady: entry.isReady,
      hasSetupPromise: !!entry.setupPromise,
    });
    return entry;
  }

  /**
   * 执行适配器 setup
   */
  private async setupAdapter(sessionId: string, entry: AdapterEntry): Promise<void> {
    try {
      console.log(LOG_PREFIX, `Setting up adapter: ${sessionId}`);
      
      // 🚀 性能优化：设置数据恢复回调，在 restoreFromBackend 后立即标记 isReady
      // 这样可以避免等待 React 渲染阻塞微任务队列导致的延迟
      entry.adapter.onDataRestored = () => {
        if (!entry.isReady) {
          console.log(LOG_PREFIX, `Data restored, marking adapter ready early: ${sessionId}`);
          entry.isReady = true;
          entry.error = null;
          sessionSwitchPerf.mark('adapter_data_restored', { sessionId, earlyReady: true });
          this.emit({ type: 'adapter-ready', sessionId });
        }
      };
      
      await entry.adapter.setup();
      
      // 如果回调还没触发（可能是缓存命中或错误），在这里标记
      if (!entry.isReady) {
        entry.isReady = true;
        entry.error = null;
        console.log(LOG_PREFIX, `Adapter ready: ${sessionId}`);
        this.emit({ type: 'adapter-ready', sessionId });
      }
    } catch (err: unknown) {
      const errorMsg = getErrorMessage(err);
      console.error(LOG_PREFIX, `Setup failed for ${sessionId}:`, errorMsg);
      entry.isReady = false;
      entry.error = errorMsg;
      this.emit({ type: 'adapter-error', sessionId, error: errorMsg });
    } finally {
      entry.setupPromise = null;
      // 清理回调
      entry.adapter.onDataRestored = null;
    }
  }

  /**
   * 获取现有适配器（不创建）
   */
  get(sessionId: string): AdapterEntry | undefined {
    return this.adapters.get(sessionId);
  }

  /**
   * 检查适配器是否存在
   */
  has(sessionId: string): boolean {
    return this.adapters.has(sessionId);
  }

  /**
   * 🔧 P20 修复：等待事件监听器就绪
   * 
   * 子代理场景下必须调用此方法，确保监听器在发送消息之前就绪。
   * 正常会话不需要调用，因为用户交互天然提供了足够的等待时间。
   */
  async waitForListenersReady(sessionId: string): Promise<void> {
    const entry = this.adapters.get(sessionId);
    if (entry?.adapter) {
      await entry.adapter.waitForListenersReady();
    }
  }

  /**
   * 减少引用计数
   *
   * 组件卸载时调用，不会 cleanup 适配器。
   * 只有当 refCount 降到 0 且会话被销毁时才 cleanup。
   */
  release(sessionId: string): void {
    const entry = this.adapters.get(sessionId);
    if (!entry) return;

    entry.refCount = Math.max(0, entry.refCount - 1);
    console.log(LOG_PREFIX, `Released adapter: ${sessionId}, refCount: ${entry.refCount}`);

    // 注意：这里不 cleanup，适配器保持活跃
    // cleanup 只在 destroy() 中执行
  }

  /**
   * 销毁适配器
   *
   * 只有在会话被销毁时才调用此方法。
   * 会执行 cleanup 并从缓存中移除。
   */
  async destroy(sessionId: string): Promise<void> {
    const entry = this.adapters.get(sessionId);
    if (!entry) return;

    console.log(LOG_PREFIX, `Destroying adapter: ${sessionId}`);

    // 等待 setup 完成（如果正在进行）
    if (entry.setupPromise) {
      try {
        await entry.setupPromise;
      } catch {
        // 忽略 setup 错误
      }
    }

    // 执行 cleanup（现在是异步的，等待监听器就绪后清理）
    try {
      await entry.adapter.cleanup();
    } catch (err: unknown) {
      console.error(LOG_PREFIX, `Cleanup failed for ${sessionId}:`, getErrorMessage(err));
    }

    // 从缓存中移除
    this.adapters.delete(sessionId);
    this.emit({ type: 'adapter-destroyed', sessionId });
    console.log(LOG_PREFIX, `Adapter destroyed: ${sessionId}`);
  }

  /**
   * 销毁所有适配器
   */
  async destroyAll(): Promise<void> {
    const sessionIds = [...this.adapters.keys()];
    console.log(LOG_PREFIX, `Destroying all adapters: ${sessionIds.length}`);
    await Promise.all(sessionIds.map((id) => this.destroy(id)));
  }

  /**
   * 获取所有活跃的适配器 ID
   */
  getAllAdapterIds(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * 获取所有已就绪的适配器 ID
   */
  getReadyAdapterIds(): string[] {
    return [...this.adapters.entries()]
      .filter(([_, entry]) => entry.isReady)
      .map(([id]) => id);
  }

  /**
   * 获取适配器数量
   */
  getAdapterCount(): number {
    return this.adapters.size;
  }

  /**
   * 检查适配器是否已就绪
   */
  isReady(sessionId: string): boolean {
    const entry = this.adapters.get(sessionId);
    return entry?.isReady ?? false;
  }

  /**
   * 获取适配器状态（调试用）
   */
  getStatus(): {
    total: number;
    ready: number;
    error: number;
    adapters: Array<{
      sessionId: string;
      isReady: boolean;
      error: string | null;
      refCount: number;
    }>;
  } {
    const entries = [...this.adapters.entries()];
    return {
      total: entries.length,
      ready: entries.filter(([_, e]) => e.isReady).length,
      error: entries.filter(([_, e]) => e.error !== null).length,
      adapters: entries.map(([sessionId, entry]) => ({
        sessionId,
        isReady: entry.isReady,
        error: entry.error,
        refCount: entry.refCount,
      })),
    };
  }

  // ========== 事件系统 ==========

  /**
   * 订阅事件
   */
  subscribe(listener: (event: AdapterManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 发送事件
   */
  private emit(event: AdapterManagerEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (err: unknown) {
        console.error(LOG_PREFIX, 'Listener error:', err);
      }
    });
  }
}

// ============================================================================
// 事件类型
// ============================================================================

export type AdapterManagerEventType =
  | 'adapter-ready'
  | 'adapter-error'
  | 'adapter-destroyed';

export interface AdapterManagerEvent {
  type: AdapterManagerEventType;
  sessionId: string;
  error?: string;
}

// ============================================================================
// 单例导出
// ============================================================================

/**
 * AdapterManager 单例实例
 */
export const adapterManager = new AdapterManagerImpl();

/**
 * 获取 AdapterManager 实例
 * @deprecated 直接使用 adapterManager
 */
export function getAdapterManager(): AdapterManagerImpl {
  return adapterManager;
}

// ============================================================================
// 类型导出
// ============================================================================

export type { AdapterEntry };
