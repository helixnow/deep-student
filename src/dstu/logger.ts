/**
 * DSTU 日志接口
 *
 * 定义抽象的日志接口，解耦 DSTU 核心层与调试工具的依赖。
 *
 * 设计原则：
 * 1. 数据层（DSTU）不依赖 UI 层（DebugPanel）
 * 2. 使用依赖注入模式，支持可选的日志实现
 * 3. 提供默认的 noop 实现，不影响核心功能
 */

// ============================================================================
// 日志接口定义
// ============================================================================

/**
 * DSTU 日志器接口
 *
 * 提供统一的日志记录能力，可由外部实现注入。
 */
export interface DstuLogger {
  /**
   * 记录方法调用
   *
   * @param method 方法名（如 "create", "update"）
   * @param params 调用参数
   */
  call(method: string, params: unknown): void;

  /**
   * 记录成功结果
   *
   * @param method 方法名
   * @param result 返回结果
   * @param duration 执行时长（毫秒）
   */
  success(method: string, result: unknown, duration: number): void;

  /**
   * 记录错误
   *
   * @param method 方法名
   * @param message 错误消息
   * @param context 上下文信息（可选）
   */
  error(method: string, message: string, context?: unknown[]): void;
}

// ============================================================================
// 默认实现（Noop）
// ============================================================================

/**
 * 空日志实现（默认）
 *
 * 不执行任何操作，确保核心功能不受日志依赖影响。
 */
export const noopLogger: DstuLogger = {
  call: () => {
    // noop
  },
  success: () => {
    // noop
  },
  error: () => {
    // noop
  },
};

// ============================================================================
// 控制台日志实现
// ============================================================================

/**
 * 控制台日志实现
 *
 * 使用 console.log 输出日志，适合开发环境调试。
 */
export const consoleLogger: DstuLogger = {
  call: (method: string, params: unknown) => {
    console.log(`[DSTU:${method}] Call:`, params);
  },
  success: (method: string, result: unknown, duration: number) => {
    console.log(`[DSTU:${method}] Success (${duration}ms):`, result);
  },
  error: (method: string, message: string, context?: unknown[]) => {
    console.error(`[DSTU:${method}] Error:`, message, context);
  },
};

// ============================================================================
// 全局日志配置
// ============================================================================

/**
 * 全局 DSTU 日志实例
 *
 * 默认使用 noop 实现，可通过 setDstuLogger 设置自定义实现。
 */
let globalLogger: DstuLogger = noopLogger;

/**
 * 设置全局 DSTU 日志器
 *
 * @param logger 日志器实例
 *
 * @example
 * ```typescript
 * import { setDstuLogger, consoleLogger } from '@/dstu/logger';
 *
 * // 使用控制台日志
 * setDstuLogger(consoleLogger);
 *
 * // 或使用自定义实现
 * setDstuLogger({
 *   call: (method, params) => { ... },
 *   success: (method, result, duration) => { ... },
 *   error: (method, message, context) => { ... },
 * });
 * ```
 */
export function setDstuLogger(logger: DstuLogger): void {
  globalLogger = logger;
}

/**
 * 获取全局 DSTU 日志器
 *
 * @returns 当前的全局日志器实例
 */
export function getDstuLogger(): DstuLogger {
  return globalLogger;
}

/**
 * 重置为默认日志器（noop）
 */
export function resetDstuLogger(): void {
  globalLogger = noopLogger;
}

// ============================================================================
// 辅助工具：从 DstuDebugPlugin 创建 Logger
// ============================================================================

/**
 * DstuDebugPlugin 兼容接口
 *
 * 用于将现有的 DstuDebugPlugin 适配为 DstuLogger。
 */
export interface DstuDebugPluginLike {
  call(method: string, params: unknown): void;
  success(method: string, result: unknown, duration: number): void;
  error(method: string, message: string, context: unknown[]): void;
}

/**
 * 从 DstuDebugPlugin 创建 DstuLogger
 *
 * 适配器模式，将现有的调试插件转换为 Logger 接口。
 *
 * @param debugPlugin 调试插件实例
 * @returns DstuLogger 实例
 *
 * @example
 * ```typescript
 * import { dstuDebugLog } from '@/debug-panel/plugins/DstuDebugPlugin';
 * import { setDstuLogger, createLoggerFromDebugPlugin } from '@/dstu/logger';
 *
 * setDstuLogger(createLoggerFromDebugPlugin(dstuDebugLog));
 * ```
 */
export function createLoggerFromDebugPlugin(debugPlugin: DstuDebugPluginLike): DstuLogger {
  return {
    call: (method: string, params: unknown) => {
      debugPlugin.call(method, params);
    },
    success: (method: string, result: unknown, duration: number) => {
      debugPlugin.success(method, result, duration);
    },
    error: (method: string, message: string, context?: unknown[]) => {
      debugPlugin.error(method, message, context || []);
    },
  };
}
