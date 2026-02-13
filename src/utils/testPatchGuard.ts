/**
 * MonkeyPatch管理与自动还原工具
 * 用于在测试过程中安全地包装API调用，并确保测试结束后自动还原
 */

import { getErrorMessage } from './errorUtils';

// ==================== 类型定义 ====================

export type OriginalFunction<T extends (...args: any[]) => any> = T;
export type PatchedFunction<T extends (...args: any[]) => any> = (
  ...args: Parameters<T>
) => Promise<ReturnType<T>> | ReturnType<T>;

export interface PatchInfo<T extends (...args: any[]) => any> {
  target: any;
  property: string;
  original: OriginalFunction<T>;
  patched: PatchedFunction<T>;
}

// ==================== PatchGuard 类 ====================

export class PatchGuard {
  private patches: PatchInfo<any>[] = [];
  private eventListeners: Array<{ event: string; handler: (e: Event) => void }> = [];

  /**
   * 包装函数以添加日志和监控
   */
  patch<T extends (...args: any[]) => any>(
    target: any,
    property: string,
    onCall?: (args: Parameters<T>, result: ReturnType<T>, error?: Error) => void
  ): void {
    if (!(property in target)) {
      throw new Error(`Property ${property} does not exist on target`);
    }

    const original = target[property] as OriginalFunction<T>;
    if (typeof original !== 'function') {
      throw new Error(`Property ${property} is not a function`);
    }

    // 检查是否已经被patch过
    if (this.patches.some(p => p.target === target && p.property === property)) {
      console.warn(`[PatchGuard] ${property} is already patched, skipping`);
      return;
    }

    const patched = (async (...args: Parameters<T>) => {
      const startTime = Date.now();
      try {
        const result = await original.apply(target, args);
        const duration = Date.now() - startTime;
        if (onCall) {
          onCall(args, result as ReturnType<T>);
        }
        // eslint-disable-next-line no-console
        console.log(`[PatchGuard] ${property} called: duration=${duration}ms`);
        return result;
      } catch (error: unknown) {
        const duration = Date.now() - startTime;
        const err = error instanceof Error ? error : new Error(String(error));
        if (onCall) {
          onCall(args, undefined as any, err);
        }
        // eslint-disable-next-line no-console
        console.error(`[PatchGuard] ${property} failed: ${getErrorMessage(err)} (duration=${duration}ms)`);
        throw error;
      }
    }) as PatchedFunction<T>;

    target[property] = patched;
    this.patches.push({ target, property, original, patched });
  }

  /**
   * 还原所有patch
   */
  restoreAll(): void {
    for (const patch of this.patches) {
      try {
        patch.target[patch.property] = patch.original;
      } catch (error: unknown) {
        console.error(`[PatchGuard] Failed to restore ${patch.property}:`, error);
      }
    }
    this.patches = [];

    // 移除所有事件监听器
    for (const { event, handler } of this.eventListeners) {
      try {
        window.removeEventListener(event, handler);
      } catch (error: unknown) {
        console.error(`[PatchGuard] Failed to remove event listener ${event}:`, error);
      }
    }
    this.eventListeners = [];
  }

  /**
   * 还原特定patch
   */
  restore<T extends (...args: any[]) => any>(target: any, property: string): void {
    const index = this.patches.findIndex(p => p.target === target && p.property === property);
    if (index === -1) {
      console.warn(`[PatchGuard] No patch found for ${property}`);
      return;
    }

    const patch = this.patches[index];
    try {
      patch.target[patch.property] = patch.original;
      this.patches.splice(index, 1);
    } catch (error: unknown) {
      console.error(`[PatchGuard] Failed to restore ${property}:`, error);
    }
  }

  /**
   * 注册事件监听器（自动在restoreAll时清理）
   */
  addEventListener(event: string, handler: (e: Event) => void): void {
    window.addEventListener(event, handler);
    this.eventListeners.push({ event, handler });
  }

  /**
   * 获取当前所有patch信息
   */
  getPatches(): Array<{ target: string; property: string }> {
    return this.patches.map(p => ({
      target: p.target.constructor?.name || 'Unknown',
      property: p.property,
    }));
  }
}

// ==================== 导出单例 ====================

export const patchGuard = new PatchGuard();

