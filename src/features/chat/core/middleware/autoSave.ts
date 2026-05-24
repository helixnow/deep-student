/**
 * Chat V2 - 自动保存中间件
 *
 * 提供节流保存和强制立即保存功能。
 *
 * 约束：
 * 1. 节流保存：500ms 内最多保存一次
 * 2. 流式结束时调用 forceImmediateSave
 * 3. 保存操作不应阻塞 UI
 */

import i18next from 'i18next';
import type { ChatStore } from '../types';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import {
  AUTO_SAVE_THROTTLE_MS,
  STREAMING_BLOCK_SAVE_THROTTLE_MS,
  STREAMING_BLOCK_EXPIRY_MS,
  STREAMING_BLOCK_CLEANUP_INTERVAL_MS,
  SAVE_FAILURE_NOTIFICATION_THROTTLE_MS,
} from '../constants';

export interface AutoSaveMiddleware {
  scheduleAutoSave(store: ChatStore): void;
  forceImmediateSave(store: ChatStore): Promise<void>;
  cancelPendingSave(sessionId: string): void;
  hasPendingSave(sessionId: string): boolean;
  cleanup(sessionId: string): void;
}

export interface AutoSaveConfig {
  throttleMs: number;
  debug: boolean;
}

const DEFAULT_CONFIG: AutoSaveConfig = {
  throttleMs: AUTO_SAVE_THROTTLE_MS,
  debug: false,
};

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// ============================================================================
// 实现
// ============================================================================

/**
 * 自动保存中间件实现
 */
class AutoSaveMiddlewareImpl implements AutoSaveMiddleware {
  private config: AutoSaveConfig;
  private pendingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private lastSaveTimes: Map<string, number> = new Map();
  private savingPromises: Map<string, Promise<void>> = new Map();

  constructor(config: Partial<AutoSaveConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 调度节流保存
   */
  scheduleAutoSave(store: ChatStore): void {
    const sessionId = store.sessionId;
    const now = Date.now();
    const lastSaveTime = this.lastSaveTimes.get(sessionId) ?? 0;
    const timeSinceLastSave = now - lastSaveTime;

    // 如果距离上次保存不足 throttleMs，设置延迟保存
    if (timeSinceLastSave < this.config.throttleMs) {
      // 取消之前的待执行保存
      this.cancelPendingSave(sessionId);

      // 计算需要延迟的时间
      const delay = this.config.throttleMs - timeSinceLastSave;

      if (this.config.debug) {
        console.log(
          `[AutoSave] Scheduling save for session ${sessionId} in ${delay}ms`
        );
      }

      const timer = setTimeout(() => {
        this.pendingTimers.delete(sessionId);
        this.executeSave(store);
      }, delay);

      this.pendingTimers.set(sessionId, timer);
    } else {
      // 立即执行保存
      this.executeSave(store);
    }
  }

  /**
   * 强制立即保存
   */
  async forceImmediateSave(store: ChatStore): Promise<void> {
    const sessionId = store.sessionId;

    // 取消待执行的保存
    this.cancelPendingSave(sessionId);

    if (this.config.debug) {
      console.log(`[AutoSave] Force immediate save for session ${sessionId}`);
    }

    // 等待正在进行的保存完成
    const existingPromise = this.savingPromises.get(sessionId);
    if (existingPromise) {
      await existingPromise;
    }

    // 执行保存
    await this.executeSaveAsync(store);
  }

  /**
   * 取消待执行的保存
   */
  cancelPendingSave(sessionId: string): void {
    const timer = this.pendingTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimers.delete(sessionId);

      if (this.config.debug) {
        console.log(`[AutoSave] Cancelled pending save for session ${sessionId}`);
      }
    }
  }

  /**
   * 检查是否有待执行的保存
   */
  hasPendingSave(sessionId: string): boolean {
    return this.pendingTimers.has(sessionId);
  }

  /**
   * 执行保存（同步调用，不等待）
   */
  private executeSave(store: ChatStore): void {
    const sessionId = store.sessionId;

    // 如果正在保存，跳过
    if (this.savingPromises.has(sessionId)) {
      if (this.config.debug) {
        console.log(`[AutoSave] Save already in progress for session ${sessionId}`);
      }
      return;
    }

    // 更新最后保存时间
    this.lastSaveTimes.set(sessionId, Date.now());

    // 异步执行保存，支持失败重试（最多1次）
    const attemptSave = async (retryCount = 0): Promise<void> => {
      try {
        await store.saveSession();
      } catch (error) {
        if (retryCount < 1) {
          console.warn(`[AutoSave] Save failed for session ${sessionId}, retrying in 2s...`, error);
          await new Promise(resolve => setTimeout(resolve, 2000));
          return attemptSave(retryCount + 1);
        }
        console.error(`[AutoSave] Save failed after retry for session ${sessionId}:`, error);
        const now = Date.now();
        const lastNotifyKey = `autoSave_lastNotify_${sessionId}`;
        const lastNotify = (this as any)[lastNotifyKey] || 0;
        if (now - lastNotify > SAVE_FAILURE_NOTIFICATION_THROTTLE_MS) {
          (this as any)[lastNotifyKey] = now;
          showGlobalNotification('warning', i18next.t('chatV2:error.saveFailedDesc'));
        }
      }
    };
    const savePromise = attemptSave()
      .finally(() => {
        this.savingPromises.delete(sessionId);
      });

    this.savingPromises.set(sessionId, savePromise);

    if (this.config.debug) {
      console.log(`[AutoSave] Executing save for session ${sessionId}`);
    }
  }

  /**
   * 执行保存（异步，等待完成）
   */
  private async executeSaveAsync(store: ChatStore): Promise<void> {
    const sessionId = store.sessionId;

    // 更新最后保存时间
    this.lastSaveTimes.set(sessionId, Date.now());

    const savePromise = store.saveSession().finally(() => {
      this.savingPromises.delete(sessionId);
    });

    this.savingPromises.set(sessionId, savePromise);

    await savePromise;

    if (this.config.debug) {
      console.log(`[AutoSave] Save completed for session ${sessionId}`);
    }
  }

  /**
   * 清理会话相关的状态
   */
  cleanup(sessionId: string): void {
    this.cancelPendingSave(sessionId);
    this.lastSaveTimes.delete(sessionId);
    this.savingPromises.delete(sessionId);
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<AutoSaveConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// ============================================================================
// 单例导出
// ============================================================================

/**
 * 自动保存中间件单例
 */
export const autoSave: AutoSaveMiddleware = new AutoSaveMiddlewareImpl();

/**
 * 创建自动保存中间件实例（用于测试）
 */
export function createAutoSaveMiddleware(
  config?: Partial<AutoSaveConfig>
): AutoSaveMiddleware & { cleanup: (sessionId: string) => void; updateConfig: (config: Partial<AutoSaveConfig>) => void } {
  return new AutoSaveMiddlewareImpl(config);
}

// ============================================================================
// 流式块防闪退保存
// ============================================================================

/**
 * 流式块保存器
 * 用于在流式过程中定期保存块内容到后端，防止闪退丢失
 */
export interface StreamingBlockSaver {
  /**
   * 调度流式块保存（防抖 5 秒）
   * @param blockId 块 ID
   * @param messageId 消息 ID
   * @param blockType 块类型
   * @param content 块内容（增量）
   * @param sessionId 可选，会话 ID（用于多会话并发清理）
   */
  scheduleBlockSave(
    blockId: string,
    messageId: string,
    blockType: string,
    content: string,
    sessionId?: string
  ): void;

  /**
   * 清理会话相关状态
   */
  cleanup(sessionId: string): void;

  /**
   * 销毁单例，清理定时器和所有待保存数据
   * 用于热重载或测试清理
   */
  destroy(): void;
}

/**
 * 流式块保存回调类型
 */
export type StreamingBlockSaveCallback = (
  blockId: string,
  messageId: string,
  blockType: string,
  content: string,
  sessionId?: string
) => Promise<void>;

/**
 * 流式块保存器实现
 *
 * 🔧 关键设计：自己累积 chunk 内容
 * 因为 chunkBuffer 使用 16ms 窗口延迟更新 store，
 * 所以不能从 store.blocks 读取内容（会滞后）。
 * 改为在这里累积所有 chunk，确保保存最新内容。
 */
class StreamingBlockSaverImpl implements StreamingBlockSaver {
  private pendingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private saveCallback: StreamingBlockSaveCallback | null = null;
  private throttleMs = STREAMING_BLOCK_SAVE_THROTTLE_MS;

  private accumulatedContent: Map<string, {
    sessionId: string;
    messageId: string;
    blockType: string;
    content: string;
    lastActivityTime: number;
  }> = new Map();

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanupTimer();
  }

  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredEntries();
    }, STREAMING_BLOCK_CLEANUP_INTERVAL_MS);
  }

  private cleanupExpiredEntries(): void {
    const now = Date.now();
    const expiredBlockIds: string[] = [];

    for (const [blockId, data] of this.accumulatedContent) {
      if (now - data.lastActivityTime > STREAMING_BLOCK_EXPIRY_MS) {
        expiredBlockIds.push(blockId);
      }
    }

    for (const blockId of expiredBlockIds) {
      const timer = this.pendingTimers.get(blockId);
      if (timer) {
        clearTimeout(timer);
        this.pendingTimers.delete(blockId);
      }
      this.accumulatedContent.delete(blockId);
    }
  }

  /**
   * 设置保存回调
   */
  setSaveCallback(callback: StreamingBlockSaveCallback | null): void {
    this.saveCallback = callback;
    console.log('[StreamingBlockSaver] Save callback', callback ? 'set' : 'cleared');
  }

  /**
   * 调度流式块保存
   * @param blockId 块 ID
   * @param messageId 消息 ID
   * @param blockType 块类型
   * @param chunk 当前 chunk（增量内容），会被累积
   * @param sessionId 可选，会话 ID（用于多会话并发清理）
   */
  scheduleBlockSave(
    blockId: string,
    messageId: string,
    blockType: string,
    chunk: string,
    sessionId?: string
  ): void {
    if (!this.saveCallback) {
      return;
    }

    // 🔧 累积 chunk 内容
    const now = Date.now();
    const existing = this.accumulatedContent.get(blockId);
    if (existing) {
      existing.content += chunk;
      existing.lastActivityTime = now;
      // 🔧 更新 sessionId（如果之前没有）
      if (sessionId && !existing.sessionId) {
        existing.sessionId = sessionId;
      }
    } else {
      this.accumulatedContent.set(blockId, {
        sessionId: sessionId || '', // 🔧 存储会话 ID
        messageId,
        blockType,
        content: chunk,
        lastActivityTime: now,
      });
    }

    // 取消之前的定时器
    const existingTimer = this.pendingTimers.get(blockId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // 设置新的防抖定时器
    const timer = setTimeout(() => {
      this.pendingTimers.delete(blockId);
      this.executeSave(blockId);
    }, this.throttleMs);

    this.pendingTimers.set(blockId, timer);
  }

  /**
   * 执行保存
   */
  private executeSave(blockId: string): void {
    if (!this.saveCallback) {
      return;
    }

    const data = this.accumulatedContent.get(blockId);
    if (!data) {
      return;
    }

    this.saveCallback(
      blockId,
      data.messageId,
      data.blockType,
      data.content,
      data.sessionId || undefined
    ).catch((error) => {
      console.error('[StreamingBlockSaver] Save failed:', blockId, error);
    });
  }

  /**
   * 清理指定会话的状态
   *
   * 🔧 P2修复：只清理指定 sessionId 的数据，支持多会话并发
   *
   * @param sessionId 要清理的会话 ID
   */
  cleanup(sessionId: string): void {
    const blockIdsToClean: string[] = [];

    // 🔧 只收集属于指定会话的块
    for (const [blockId, data] of this.accumulatedContent) {
      if (data.sessionId === sessionId) {
        blockIdsToClean.push(blockId);
      }
    }

    // 清理收集到的块
    for (const blockId of blockIdsToClean) {
      // 取消待执行的定时器
      const timer = this.pendingTimers.get(blockId);
      if (timer) {
        clearTimeout(timer);
        this.pendingTimers.delete(blockId);
      }
      // 删除数据
      this.accumulatedContent.delete(blockId);
    }

    if (blockIdsToClean.length > 0) {
      console.log(`[StreamingBlockSaver] Cleaned up ${blockIdsToClean.length} blocks for session ${sessionId}`);
    }
  }

  /**
   * 销毁单例，清理定时器和所有待保存数据
   * 用于热重载或测试清理
   */
  destroy(): void {
    // 清理周期性清理定时器
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // 取消所有待执行的保存定时器
    for (const [blockId, timer] of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();

    // 清空累积内容
    this.accumulatedContent.clear();

    // 清除回调
    this.saveCallback = null;

    console.log('[StreamingBlockSaver] Destroyed and cleaned up');
  }
}

/**
 * 流式块保存器单例
 */
export const streamingBlockSaver = new StreamingBlockSaverImpl() as StreamingBlockSaver & {
  setSaveCallback: (callback: StreamingBlockSaveCallback | null) => void;
  destroy: () => void;
};
