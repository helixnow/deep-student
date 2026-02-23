/**
 * 并发控制工具
 *
 * 提供轻量级的并发限制功能，避免同时执行过多异步任务。
 * 适用于需要控制并发数量的场景，如批量网络请求、资源加载等。
 *
 * ★ 新增功能（HIGH-008修复）：
 * - AdaptiveConcurrencyLimiter: 自适应并发控制
 * - withTimeout: 超时控制包装器
 */

import { VfsError, VfsErrorCode, ok, err, type Result } from '@/shared/result';

/**
 * 创建并发限制器
 *
 * @param concurrency 最大并发数
 * @returns 限制器函数，用于包装异步任务
 *
 * @example
 * ```typescript
 * const limit = pLimit(5);
 *
 * // 包装多个异步任务
 * const results = await Promise.all([
 *   limit(() => fetchData(1)),
 *   limit(() => fetchData(2)),
 *   limit(() => fetchData(3)),
 *   // ... 更多任务
 * ]);
 * ```
 */
export function pLimit(concurrency: number) {
  if (concurrency < 1) {
    throw new Error('Concurrency must be at least 1');
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active--;
    if (queue.length > 0) {
      const resolve = queue.shift()!;
      resolve();
    }
  };

  const run = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    // 等待获取执行槽位
    if (active >= concurrency) {
      await new Promise<void>(resolve => {
        queue.push(resolve);
      });
    }

    active++;

    try {
      return await fn();
    } finally {
      next();
    }
  };

  return run;
}

/**
 * 并发执行多个异步任务
 *
 * 类似于 Promise.all，但限制同时执行的任务数量。
 *
 * @param tasks 任务数组（返回 Promise 的函数）
 * @param concurrency 最大并发数
 * @returns 所有任务的结果数组
 *
 * @example
 * ```typescript
 * const urls = ['url1', 'url2', 'url3', ...];
 * const results = await pAll(
 *   urls.map(url => () => fetch(url)),
 *   5 // 最多同时执行 5 个请求
 * );
 * ```
 */
export async function pAll<T>(
  tasks: Array<() => Promise<T> | T>,
  concurrency: number
): Promise<T[]> {
  const limit = pLimit(concurrency);
  return Promise.all(tasks.map(task => limit(task)));
}

/**
 * 并发执行多个异步任务（带错误处理）
 *
 * 与 pAll 类似，但单个任务失败不会导致整体失败。
 * 返回的数组中，成功的任务返回 { success: true, value }，
 * 失败的任务返回 { success: false, error }。
 *
 * @param tasks 任务数组
 * @param concurrency 最大并发数
 * @returns 结果数组，包含成功和失败的任务
 *
 * @example
 * ```typescript
 * const results = await pAllSettled(
 *   urls.map(url => () => fetch(url)),
 *   5
 * );
 *
 * results.forEach((result, index) => {
 *   if (result.success) {
 *     console.log(`Task ${index} succeeded:`, result.value);
 *   } else {
 *     console.error(`Task ${index} failed:`, result.error);
 *   }
 * });
 * ```
 */
export async function pAllSettled<T>(
  tasks: Array<() => Promise<T> | T>,
  concurrency: number
): Promise<Array<
  | { success: true; value: T }
  | { success: false; error: unknown }
>> {
  const limit = pLimit(concurrency);

  return Promise.all(
    tasks.map(task =>
      limit(async () => {
        try {
          const value = await task();
          return { success: true as const, value };
        } catch (error: unknown) {
          return { success: false as const, error };
        }
      })
    )
  );
}

/**
 * 批量处理数组，支持并发控制
 *
 * 对数组中的每个元素执行异步处理函数，限制并发数量。
 *
 * @param items 要处理的数组
 * @param mapper 处理函数
 * @param concurrency 最大并发数
 * @returns 处理结果数组
 *
 * @example
 * ```typescript
 * const ids = [1, 2, 3, 4, 5];
 * const users = await pMap(
 *   ids,
 *   async id => fetchUser(id),
 *   3 // 最多同时处理 3 个
 * );
 * ```
 */
export async function pMap<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R> | R,
  concurrency: number
): Promise<R[]> {
  const limit = pLimit(concurrency);
  return Promise.all(
    items.map((item, index) => limit(() => mapper(item, index)))
  );
}

// ============================================================================
// 超时控制（MEDIUM-003修复）
// ============================================================================

/**
 * 为 Promise 添加超时控制
 *
 * @param promise 原始 Promise
 * @param timeoutMs 超时时间（毫秒）
 * @param errorMessage 超时错误消息（可选）
 * @returns 带超时的 Result
 *
 * @example
 * ```typescript
 * const result = await withTimeout(
 *   fetchData(),
 *   5000,
 *   '数据加载'
 * );
 *
 * if (!result.ok && result.error.code === VfsErrorCode.TIMEOUT) {
 *   console.log('操作超时');
 * }
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = 'Operation'
): Promise<Result<T, VfsError>> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new VfsError(
          VfsErrorCode.TIMEOUT,
          `${errorMessage} timed out (${timeoutMs}ms)`,
          true,
          { timeoutMs }
        )
      );
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return ok(result);
  } catch (error: unknown) {
    clearTimeout(timeoutId!);
    if (error instanceof VfsError) {
      return err(error);
    }
    return err(
      new VfsError(
        VfsErrorCode.UNKNOWN,
        error instanceof Error ? error.message : String(error),
        true,
        { originalError: error }
      )
    );
  }
}

// ============================================================================
// 自适应并发控制（HIGH-008修复）
// ============================================================================

/**
 * 性能统计数据
 */
interface PerformanceStats {
  /** 平均响应时间（毫秒） */
  avgResponseTime: number;
  /** 成功次数 */
  successCount: number;
  /** 失败次数 */
  failureCount: number;
  /** 最近的响应时间样本 */
  recentSamples: number[];
}

/**
 * 自适应并发控制器配置
 */
export interface AdaptiveConcurrencyConfig {
  /** 最小并发数（默认 1） */
  minConcurrency?: number;
  /** 最大并发数（默认 10） */
  maxConcurrency?: number;
  /** 初始并发数（默认 3） */
  initialConcurrency?: number;
  /** 目标响应时间（毫秒，默认 1000） */
  targetResponseTime?: number;
  /** 调整阈值（默认 0.2，即 20%） */
  adjustmentThreshold?: number;
  /** 样本窗口大小（默认 10） */
  sampleWindowSize?: number;
  /** 调整间隔（次数，默认 5） */
  adjustmentInterval?: number;
}

/**
 * 自适应并发控制器
 *
 * 根据历史响应时间自动调整并发数：
 * - 响应时间快 → 增加并发
 * - 响应时间慢 → 降低并发
 *
 * @example
 * ```typescript
 * const limiter = new AdaptiveConcurrencyLimiter({
 *   minConcurrency: 2,
 *   maxConcurrency: 10,
 *   targetResponseTime: 500,
 * });
 *
 * const results = await Promise.all(
 *   tasks.map(task => limiter.run(() => task()))
 * );
 *
 * console.log('当前并发数:', limiter.getCurrentConcurrency());
 * console.log('性能统计:', limiter.getStats());
 * ```
 */
export class AdaptiveConcurrencyLimiter {
  private minConcurrency: number;
  private maxConcurrency: number;
  private currentConcurrency: number;
  private targetResponseTime: number;
  private adjustmentThreshold: number;
  private sampleWindowSize: number;
  private adjustmentInterval: number;

  private stats: PerformanceStats = {
    avgResponseTime: 0,
    successCount: 0,
    failureCount: 0,
    recentSamples: [],
  };

  private activeTasks = 0;
  private taskQueue: Array<() => void> = [];
  private operationCount = 0;
  private recentSuccessCount = 0;
  private recentFailureCount = 0;

  constructor(config: AdaptiveConcurrencyConfig = {}) {
    this.minConcurrency = config.minConcurrency ?? 1;
    this.maxConcurrency = config.maxConcurrency ?? 10;
    this.currentConcurrency = config.initialConcurrency ?? 3;
    this.targetResponseTime = config.targetResponseTime ?? 1000;
    this.adjustmentThreshold = config.adjustmentThreshold ?? 0.2;
    this.sampleWindowSize = config.sampleWindowSize ?? 10;
    this.adjustmentInterval = config.adjustmentInterval ?? 5;

    // 验证配置
    if (this.minConcurrency < 1) {
      throw new Error('minConcurrency must be at least 1');
    }
    if (this.maxConcurrency < this.minConcurrency) {
      throw new Error('maxConcurrency must be >= minConcurrency');
    }
    if (this.currentConcurrency < this.minConcurrency || this.currentConcurrency > this.maxConcurrency) {
      this.currentConcurrency = Math.max(this.minConcurrency, Math.min(this.maxConcurrency, this.currentConcurrency));
    }
  }

  /**
   * 执行任务（带并发控制）
   *
   * @param task 要执行的任务
   * @returns 任务执行结果
   */
  async run<T>(task: () => Promise<T> | T): Promise<T> {
    // 等待获取执行槽位
    if (this.activeTasks >= this.currentConcurrency) {
      await new Promise<void>(resolve => {
        this.taskQueue.push(resolve);
      });
    }

    this.activeTasks++;
    const startTime = performance.now();

    try {
      const result = await task();
      const duration = performance.now() - startTime;

      // 记录成功
      this.recordSuccess(duration);

      return result;
    } catch (error: unknown) {
      const duration = performance.now() - startTime;

      // 记录失败
      this.recordFailure(duration);

      throw error;
    } finally {
      this.activeTasks--;
      this.processQueue();
    }
  }

  private recordSuccess(duration: number): void {
    this.stats.successCount++;
    this.recentSuccessCount++;
    this.addSample(duration);
    this.maybeAdjustConcurrency();
  }

  private recordFailure(_duration: number): void {
    this.stats.failureCount++;
    this.recentFailureCount++;
    // 不将失败任务的 duration 加入样本——快速失败的短 duration 会误导延迟判断
    this.maybeAdjustConcurrency();
  }

  /**
   * 添加响应时间样本
   */
  private addSample(duration: number): void {
    this.stats.recentSamples.push(duration);

    // 保持样本窗口大小
    if (this.stats.recentSamples.length > this.sampleWindowSize) {
      this.stats.recentSamples.shift();
    }

    // 更新平均响应时间
    if (this.stats.recentSamples.length > 0) {
      const sum = this.stats.recentSamples.reduce((a, b) => a + b, 0);
      this.stats.avgResponseTime = sum / this.stats.recentSamples.length;
    }
  }

  private maybeAdjustConcurrency(): void {
    this.operationCount++;

    if (this.operationCount % this.adjustmentInterval !== 0) {
      return;
    }

    const recentTotal = this.recentSuccessCount + this.recentFailureCount;
    const recentFailureRate = recentTotal > 0 ? this.recentFailureCount / recentTotal : 0;

    // 高失败率：乘性减少，防止故障放大
    if (recentFailureRate > 0.5 && this.currentConcurrency > this.minConcurrency) {
      const prev = this.currentConcurrency;
      this.currentConcurrency = Math.max(
        Math.ceil(this.currentConcurrency * 0.5),
        this.minConcurrency
      );
      console.log(
        `[AdaptiveConcurrency] 高失败率乘性降低: ${prev} → ${this.currentConcurrency}`,
        `(失败率: ${(recentFailureRate * 100).toFixed(0)}%)`
      );
      this.recentSuccessCount = 0;
      this.recentFailureCount = 0;
      return;
    }

    // 样本不足时不做延迟调整
    if (this.stats.recentSamples.length < Math.min(5, this.sampleWindowSize)) {
      this.recentSuccessCount = 0;
      this.recentFailureCount = 0;
      return;
    }

    const avgTime = this.stats.avgResponseTime;
    const target = this.targetResponseTime;
    const threshold = this.adjustmentThreshold;

    if (avgTime < target * (1 - threshold) && this.currentConcurrency < this.maxConcurrency && recentFailureRate < 0.1) {
      this.currentConcurrency = Math.min(
        this.currentConcurrency + 1,
        this.maxConcurrency
      );
      console.log(
        `[AdaptiveConcurrency] 增加并发: ${this.currentConcurrency - 1} → ${this.currentConcurrency}`,
        `(平均响应时间: ${avgTime.toFixed(0)}ms, 目标: ${target}ms, 失败率: ${(recentFailureRate * 100).toFixed(0)}%)`
      );
    } else if (avgTime > target * (1 + threshold) && this.currentConcurrency > this.minConcurrency) {
      const prev = this.currentConcurrency;
      this.currentConcurrency = Math.max(
        Math.ceil(this.currentConcurrency * 0.5),
        this.minConcurrency
      );
      console.log(
        `[AdaptiveConcurrency] 乘性降低并发: ${prev} → ${this.currentConcurrency}`,
        `(平均响应时间: ${avgTime.toFixed(0)}ms, 目标: ${target}ms)`
      );
    }

    this.recentSuccessCount = 0;
    this.recentFailureCount = 0;
  }

  /**
   * 处理队列中的任务
   */
  private processQueue(): void {
    if (this.taskQueue.length > 0 && this.activeTasks < this.currentConcurrency) {
      const resolve = this.taskQueue.shift();
      if (resolve) {
        resolve();
      }
    }
  }

  /**
   * 获取当前并发数
   */
  getCurrentConcurrency(): number {
    return this.currentConcurrency;
  }

  /**
   * 获取活跃任务数
   */
  getActiveTasks(): number {
    return this.activeTasks;
  }

  /**
   * 获取队列长度
   */
  getQueueLength(): number {
    return this.taskQueue.length;
  }

  /**
   * 获取性能统计
   */
  getStats(): PerformanceStats & { currentConcurrency: number } {
    return {
      ...this.stats,
      currentConcurrency: this.currentConcurrency,
    };
  }

  /**
   * 重置统计数据（保留当前并发数）
   */
  resetStats(): void {
    this.stats = {
      avgResponseTime: 0,
      successCount: 0,
      failureCount: 0,
      recentSamples: [],
    };
    this.operationCount = 0;
  }

  /**
   * 手动设置并发数（用于测试或特殊场景）
   */
  setConcurrency(concurrency: number): void {
    const bounded = Math.max(
      this.minConcurrency,
      Math.min(concurrency, this.maxConcurrency)
    );
    console.log(`[AdaptiveConcurrency] 手动设置并发: ${this.currentConcurrency} → ${bounded}`);
    this.currentConcurrency = bounded;
  }
}
