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
import { readBlockingInteraction } from '../core/types/queue';
import { getErrorMessage } from '@/utils/errorUtils';
import { sessionSwitchPerf } from '../debug/sessionSwitchPerf';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { isSubagentSessionId } from '../core/subagentSession';

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[ChatV2:AdapterManager]';
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// ============================================================================
// 子代理空闲逐出
// ============================================================================

/**
 * 子代理适配器空闲逐出延迟。
 *
 * 子代理会话（agent_ / subagent_ 前缀）由 WORKER_READY 预热创建，
 * 任务结束后 Adapter+Tauri 监听器若不回收会随工作区数量单调增长。
 * refCount 归零后挂 10 分钟延迟定时器，到期且无活跃流则 destroy；
 * re-acquire（getOrCreate）时取消定时器。主会话适配器不受影响。
 */
export const SUBAGENT_IDLE_EVICT_MS = 10 * 60 * 1000;

// ============================================================================
// 适配器状态
// ============================================================================

export interface AdapterEntry {
  /** 适配器实例 */
  adapter: ChatV2TauriAdapter;
  /** 是否已 setup */
  isReady: boolean;
  /** setup 错误 */
  error: string | null;
  /** setup Promise（防止并发 setup） */
  setupPromise: Promise<void> | null;
  /** 活跃 lease 数量；只能通过 acquire/release 改变 */
  readonly refCount: number;
  /** 对应 Store，用于空闲逐出前检查运行时状态 */
  store: StoreApi<ChatStore>;
  /** 当前实例代次；同一 sessionId 每次重新创建都会递增 */
  readonly generation: number;
}

declare const adapterLeaseBrand: unique symbol;

/**
 * 一次独立的适配器持有权。
 *
 * brand 使业务代码无法构造有效 lease；运行时还会校验对象身份和 generation。
 */
export interface AdapterLease {
  readonly sessionId: string;
  readonly generation: number;
  readonly [adapterLeaseBrand]: true;
}

export interface AdapterAcquisition {
  entry: AdapterEntry;
  lease: AdapterLease;
}

type AdapterRetirementReason = 'destroy' | 'destroy-all' | 'idle-eviction';

interface ManagedAdapterEntry extends AdapterEntry {
  readonly sessionId: string;
  refCount: number;
  setupAttempt: number;
  activeLeases: Set<AdapterLease>;
  retirementReason: AdapterRetirementReason | null;
  retirementPromise: Promise<AdapterRetirementReason>;
  retire: (reason: AdapterRetirementReason) => void;
}

export class AdapterAcquisitionCancelledError extends Error {
  constructor(
    readonly sessionId: string,
    readonly generation: number,
    readonly reason: Exclude<AdapterRetirementReason, 'idle-eviction'>
  ) {
    super(`Adapter acquisition cancelled for ${sessionId} (generation ${generation}, ${reason})`);
    this.name = 'AdapterAcquisitionCancelledError';
  }
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
 * 1. 主会话适配器生命周期与 SessionManager 中的 Store 对齐
 * 2. 子代理在无引用且空闲一段时间后可独立 cleanup
 * 3. 组件卸载时不 cleanup 适配器，只减少引用计数
 * 4. 支持并发 setup 请求（只执行一次）
 */
export class AdapterManagerImpl {
  /** 适配器条目缓存 */
  private adapters = new Map<string, ManagedAdapterEntry>();

  /** 为每个新实例分配单调递增代次 */
  private nextGeneration = 1;

  /** 已摘除、仍在异步 setup/cleanup 的条目 */
  private cleanupTasks = new Set<Promise<void>>();

  /** 允许同 generation 的重复 destroy 等待同一 cleanup，同时隔离迟到的旧 destroy。 */
  private cleanupTasksBySession = new Map<string, Map<number, Promise<void>>>();

  /** refCount 归零后的子代理空闲逐出定时器 */
  private subagentIdleEvictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
   * @returns 适配器条目及本次调用独享的 lease
   */
  async getOrCreate(
    sessionId: string,
    store: StoreApi<ChatStore>
  ): Promise<AdapterAcquisition> {
    this.cancelSubagentIdleEviction(sessionId);

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
      
      const lease = this.createLease(entry);
      const retryThroughAttempt = entry.setupAttempt;
      console.log(LOG_PREFIX, `Adapter exists for ${sessionId}, refCount: ${entry.refCount}`);

      const acquisition = await this.completeAcquisition(
        sessionId,
        store,
        entry,
        lease,
        retryThroughAttempt
      );

      // 📊 细粒度打点：退出 AdapterManager
      sessionSwitchPerf.mark('adapter_manager_exit', { 
        cached: true,
        refCount: entry.refCount,
        isReady: entry.isReady,
        hasSetupPromise: !!entry.setupPromise,
      });
      return acquisition;
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

    let retire!: (reason: AdapterRetirementReason) => void;
    const retirementPromise = new Promise<AdapterRetirementReason>((resolve) => {
      retire = resolve;
    });
    entry = {
      sessionId,
      adapter,
      isReady: false,
      error: null,
      setupPromise: null,
      refCount: 0,
      store,
      generation: this.nextGeneration++,
      setupAttempt: 0,
      activeLeases: new Set(),
      retirementReason: null,
      retirementPromise,
      retire,
    };
    this.adapters.set(sessionId, entry);
    const lease = this.createLease(entry);

    // 执行 setup
    this.startSetup(sessionId, entry);
    const acquisition = await this.completeAcquisition(
      sessionId,
      store,
      entry,
      lease,
      entry.setupAttempt
    );

    // 📊 细粒度打点：退出 AdapterManager
    sessionSwitchPerf.mark('adapter_manager_exit', { 
      cached: false,
      refCount: entry.refCount,
      isReady: entry.isReady,
      hasSetupPromise: !!entry.setupPromise,
    });
    return acquisition;
  }

  /**
   * 同步持有一个已存在的条目。调用方通常先检查 isReady，再走该路径，
   * 用于 React hook 首次 render 时避免额外的异步状态跳变。
   */
  acquireExisting(sessionId: string): AdapterAcquisition | undefined {
    const entry = this.adapters.get(sessionId);
    if (!entry || entry.retirementReason) return undefined;

    this.cancelSubagentIdleEviction(sessionId);
    return { entry, lease: this.createLease(entry) };
  }

  private createLease(entry: ManagedAdapterEntry): AdapterLease {
    const lease = Object.freeze({
      sessionId: entry.sessionId,
      generation: entry.generation,
    }) as AdapterLease;
    entry.activeLeases.add(lease);
    entry.refCount = entry.activeLeases.size;
    return lease;
  }

  private discardLease(entry: ManagedAdapterEntry, lease: AdapterLease): void {
    entry.activeLeases.delete(lease);
    entry.refCount = entry.activeLeases.size;
  }

  private async completeAcquisition(
    sessionId: string,
    store: StoreApi<ChatStore>,
    entry: ManagedAdapterEntry,
    lease: AdapterLease,
    retryThroughAttempt: number
  ): Promise<AdapterAcquisition> {
    try {
      while (this.adapters.get(sessionId) === entry && !entry.retirementReason) {
        const setupPromise = entry.setupPromise;
        if (setupPromise) {
          console.log(LOG_PREFIX, `Waiting for setup: ${sessionId}`);
          sessionSwitchPerf.mark('adapter_manager_wait_setup');
          await Promise.race([setupPromise, entry.retirementPromise]);
          continue;
        }

        if (
          entry.error &&
          !entry.isReady &&
          entry.setupAttempt <= retryThroughAttempt
        ) {
          console.log(LOG_PREFIX, `Retrying setup for failed adapter: ${sessionId}`);
          entry.error = null;
          this.startSetup(sessionId, entry);
          continue;
        }
        break;
      }
    } catch (err) {
      this.discardLease(entry, lease);
      throw err;
    }

    if (this.adapters.get(sessionId) !== entry || entry.retirementReason) {
      this.discardLease(entry, lease);
      if (entry.retirementReason === 'idle-eviction') {
        return this.getOrCreate(sessionId, store);
      }
      throw new AdapterAcquisitionCancelledError(
        sessionId,
        entry.generation,
        entry.retirementReason ?? 'destroy'
      );
    }

    return { entry, lease };
  }

  private startSetup(sessionId: string, entry: ManagedAdapterEntry): void {
    entry.setupAttempt += 1;
    entry.setupPromise = this.setupAdapter(sessionId, entry);
  }

  /**
   * 执行适配器 setup
   */
  private async setupAdapter(sessionId: string, entry: ManagedAdapterEntry): Promise<void> {
    try {
      console.log(LOG_PREFIX, `Setting up adapter: ${sessionId}`);
      
      // 🚀 性能优化：设置数据恢复回调，在 restoreFromBackend 后立即标记 isReady
      // 这样可以避免等待 React 渲染阻塞微任务队列导致的延迟
      entry.adapter.onDataRestored = () => {
        if (this.adapters.get(sessionId) !== entry) return;
        if (!entry.isReady) {
          console.log(LOG_PREFIX, `Data restored, marking adapter ready early: ${sessionId}`);
          entry.isReady = true;
          entry.error = null;
          sessionSwitchPerf.mark('adapter_data_restored', { sessionId, earlyReady: true });
          this.emit({ type: 'adapter-ready', sessionId });
        }
      };
      
      await entry.adapter.setup();

      if (this.adapters.get(sessionId) !== entry) return;
      
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
      if (this.adapters.get(sessionId) === entry) {
        this.emit({ type: 'adapter-error', sessionId, error: errorMsg });
      }
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
   * 组件卸载时调用。主会话保持活跃；子代理 refCount 降到 0 后
   * 启动延迟 cleanup，并在重新 acquire 时取消。
   */
  release(sessionId: string, lease: AdapterLease): boolean {
    const entry = this.adapters.get(sessionId);
    if (
      !entry ||
      lease.sessionId !== sessionId ||
      lease.generation !== entry.generation ||
      !entry.activeLeases.delete(lease)
    ) {
      return false;
    }

    entry.refCount = entry.activeLeases.size;
    console.log(LOG_PREFIX, `Released adapter: ${sessionId}, refCount: ${entry.refCount}`);

    if (entry.refCount === 0 && isSubagentSessionId(sessionId)) {
      this.scheduleSubagentIdleEviction(sessionId);
    }
    return true;
  }

  /**
   * 销毁适配器
   *
   * 只有在会话被销毁时才调用此方法。
   * expectedGeneration 防止旧生命周期的迟到销毁误删同 ID 新代。
   */
  destroy(sessionId: string, expectedGeneration: number): Promise<void> {
    this.cancelSubagentIdleEviction(sessionId);

    const entry = this.adapters.get(sessionId);
    if (!entry || entry.generation !== expectedGeneration) {
      return this.getCleanupTask(sessionId, expectedGeneration) ?? Promise.resolve();
    }

    console.log(LOG_PREFIX, `Destroying adapter: ${sessionId}`);
    this.detachEntry(sessionId, entry, 'destroy');
    return this.trackCleanup(sessionId, entry, false);
  }

  /**
   * 销毁所有适配器
   */
  async destroyAll(): Promise<void> {
    for (const sessionId of this.subagentIdleEvictionTimers.keys()) {
      this.cancelSubagentIdleEviction(sessionId);
    }
    const entries = [...this.adapters.entries()];
    console.log(LOG_PREFIX, `Destroying all adapters: ${entries.length}`);

    // 先同步摘除并取消全部 pending acquire，再开始任何 await。
    const startedTasks = entries.map(([sessionId, entry]) => {
      this.detachEntry(sessionId, entry, 'destroy-all');
      return this.trackCleanup(sessionId, entry, false);
    });
    await Promise.all([...this.cleanupTasks, ...startedTasks]);
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

  private cancelSubagentIdleEviction(sessionId: string): void {
    const timer = this.subagentIdleEvictionTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.subagentIdleEvictionTimers.delete(sessionId);
    }
  }

  private scheduleSubagentIdleEviction(sessionId: string): void {
    this.cancelSubagentIdleEviction(sessionId);

    const timer = setTimeout(() => {
      this.subagentIdleEvictionTimers.delete(sessionId);
      const entry = this.adapters.get(sessionId);
      if (!entry || entry.refCount > 0) return;

      const state = entry.store.getState();
      const isRuntimeBusy =
        state.sessionStatus !== 'idle' ||
        // 🔧 P0-3 读路径收敛：经 readBlockingInteraction 单一入口读取
        readBlockingInteraction(state) !== null ||
        state.activeBlockIds.size > 0;

      if (isRuntimeBusy) {
        this.scheduleSubagentIdleEviction(sessionId);
        return;
      }

      void this.evictIdleSubagent(sessionId, entry);
    }, SUBAGENT_IDLE_EVICT_MS);

    this.subagentIdleEvictionTimers.set(sessionId, timer);
  }

  private evictIdleSubagent(sessionId: string, entry: ManagedAdapterEntry): Promise<void> {
    if (this.adapters.get(sessionId) !== entry || entry.refCount > 0) {
      return Promise.resolve();
    }

    this.detachEntry(sessionId, entry, 'idle-eviction');
    return this.trackCleanup(sessionId, entry, true);
  }

  private detachEntry(
    sessionId: string,
    entry: ManagedAdapterEntry,
    reason: AdapterRetirementReason
  ): void {
    if (this.adapters.get(sessionId) !== entry) return;

    this.adapters.delete(sessionId);
    entry.retirementReason = reason;
    entry.activeLeases.clear();
    entry.refCount = 0;
    entry.retire(reason);
    this.emit({ type: 'adapter-destroyed', sessionId });
  }

  private trackCleanup(
    sessionId: string,
    entry: ManagedAdapterEntry,
    idle: boolean
  ): Promise<void> {
    const task = this.cleanupDetachedEntry(sessionId, entry, idle);
    this.cleanupTasks.add(task);
    let sessionTasks = this.cleanupTasksBySession.get(sessionId);
    if (!sessionTasks) {
      sessionTasks = new Map();
      this.cleanupTasksBySession.set(sessionId, sessionTasks);
    }
    sessionTasks.set(entry.generation, task);
    void task.finally(() => {
      this.cleanupTasks.delete(task);
      const currentSessionTasks = this.cleanupTasksBySession.get(sessionId);
      if (currentSessionTasks?.get(entry.generation) === task) {
        currentSessionTasks.delete(entry.generation);
        if (currentSessionTasks.size === 0) {
          this.cleanupTasksBySession.delete(sessionId);
        }
      }
    });
    return task;
  }

  private getCleanupTask(
    sessionId: string,
    generation: number
  ): Promise<void> | undefined {
    return this.cleanupTasksBySession.get(sessionId)?.get(generation);
  }

  private async cleanupDetachedEntry(
    sessionId: string,
    entry: ManagedAdapterEntry,
    idle: boolean
  ): Promise<void> {
    // cleanup 自身会先推进 setup generation，使正在注册的监听失效。
    // Manager 若先等待 setup，永久 pending 的监听注册会让显式销毁永不完成。
    try {
      await entry.adapter.cleanup();
    } catch (err: unknown) {
      console.error(
        LOG_PREFIX,
        `${idle ? 'Idle cleanup' : 'Cleanup'} failed for ${sessionId}:`,
        getErrorMessage(err)
      );
    }
    console.log(
      LOG_PREFIX,
      idle
        ? `Idle subagent adapter destroyed: ${sessionId}`
        : `Adapter destroyed: ${sessionId}`
    );
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
