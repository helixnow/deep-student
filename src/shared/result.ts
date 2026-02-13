/**
 * 统一错误处理 - Result 类型和 VfsError 类
 *
 * 提供类型安全的错误处理机制，替代 try-catch + 静默返回空值的模式。
 *
 * @module shared/result
 */

import i18next from 'i18next';

// ============================================================================
// Result 类型定义
// ============================================================================

/**
 * 成功结果
 *
 * 🔧 P3修复：添加 error?: never 使 TypeScript 能够正确进行类型收窄
 */
export interface Ok<T> {
  ok: true;
  value: T;
  error?: never;
}

/**
 * 失败结果
 *
 * 🔧 P3修复：添加 value?: never 使 TypeScript 能够正确进行类型收窄
 */
export interface Err<E> {
  ok: false;
  error: E;
  value?: never;
}

/**
 * Result 类型：表示可能成功或失败的操作结果
 *
 * @example
 * ```typescript
 * function divide(a: number, b: number): Result<number, string> {
 *   if (b === 0) {
 *     return err("除数不能为零");
 *   }
 *   return ok(a / b);
 * }
 *
 * const result = divide(10, 2);
 * if (result.ok) {
 *   console.log("结果:", result.value);
 * } else {
 *   console.error("错误:", result.error);
 * }
 * ```
 */
export type Result<T, E = VfsError> = Ok<T> | Err<E>;

// ============================================================================
// VfsError 错误码定义
// ============================================================================

/**
 * VFS 错误码
 */
export enum VfsErrorCode {
  /** 资源未找到 */
  NOT_FOUND = 'NOT_FOUND',
  /** 网络错误（后端不可达） */
  NETWORK = 'NETWORK',
  /** 数据解析错误（JSON 格式错误等） */
  PARSE = 'PARSE',
  /** 权限错误 */
  PERMISSION = 'PERMISSION',
  /** 验证错误（参数无效等） */
  VALIDATION = 'VALIDATION',
  /** 名称冲突（资源已存在） */
  CONFLICT = 'CONFLICT',
  /** 超时错误 */
  TIMEOUT = 'TIMEOUT',
  /** 容量超限（存储空间不足） */
  CAPACITY_EXCEEDED = 'CAPACITY_EXCEEDED',
  /** 状态无效（不允许的操作） */
  INVALID_STATE = 'INVALID_STATE',
  /** 依赖失败（关联资源操作失败） */
  DEPENDENCY_FAILED = 'DEPENDENCY_FAILED',
  /** 未知错误 */
  UNKNOWN = 'UNKNOWN',
}

/**
 * VFS 错误类
 *
 * 标准化的错误对象，包含错误码、消息和可恢复性标志。
 *
 * @example
 * ```typescript
 * const error = new VfsError(
 *   VfsErrorCode.NOT_FOUND,
 *   "资源 note_123 未找到",
 *   true,
 *   { sourceId: "note_123" }
 * );
 * ```
 */
export class VfsError extends Error {
  /** 错误码 */
  readonly code: VfsErrorCode;

  /** 是否可恢复（true = 可重试，false = 永久性错误） */
  readonly recoverable: boolean;

  /** 原始错误对象（如果有） */
  readonly cause?: unknown;

  /** 额外的错误上下文信息 */
  readonly context?: Record<string, unknown>;

  constructor(
    code: VfsErrorCode,
    message: string,
    recoverable = true,
    context?: Record<string, unknown>,
    cause?: unknown
  ) {
    super(message);
    this.name = 'VfsError';
    this.code = code;
    this.recoverable = recoverable;
    this.context = context;
    this.cause = cause;

    // 保持正确的原型链（TypeScript 继承 Error 的怪癖）
    Object.setPrototypeOf(this, VfsError.prototype);
  }

  /**
   * 将错误转换为用户友好的消息
   * 支持上下文变量插入（如文件名、资源ID等）
   */
  toUserMessage(): string {
    const contextInfo = this.context
      ? Object.entries(this.context)
          .filter(([_, v]) => typeof v === 'string' || typeof v === 'number')
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ')
      : '';

    const details = contextInfo ? ` (${contextInfo})` : '';

    switch (this.code) {
      case VfsErrorCode.NOT_FOUND:
        return i18next.t('common:vfsErrors.resourceNotFound', { details });
      case VfsErrorCode.NETWORK:
        return this.recoverable
          ? i18next.t('common:vfsErrors.networkFailed')
          : i18next.t('common:vfsErrors.networkFailedNeedsRestart');
      case VfsErrorCode.PARSE:
        return i18next.t('common:vfsErrors.dataFormatError', { details });
      case VfsErrorCode.PERMISSION:
        return i18next.t('common:vfsErrors.permissionDenied', { details });
      case VfsErrorCode.VALIDATION:
        return i18next.t('common:vfsErrors.invalidInput', { message: this.message });
      case VfsErrorCode.CONFLICT:
        return i18next.t('common:vfsErrors.nameConflict', { details });
      case VfsErrorCode.TIMEOUT:
        return i18next.t('common:vfsErrors.operationTimeout', { details });
      case VfsErrorCode.CAPACITY_EXCEEDED:
        return i18next.t('common:vfsErrors.storageInsufficient', { details });
      case VfsErrorCode.INVALID_STATE:
        return i18next.t('common:vfsErrors.invalidState', { message: this.message });
      case VfsErrorCode.DEPENDENCY_FAILED:
        return i18next.t('common:vfsErrors.dependencyFailed', { message: this.message, details });
      case VfsErrorCode.UNKNOWN:
      default:
        return i18next.t('common:vfsErrors.unknownError', { message: this.message, details });
    }
  }

  /**
   * 获取详细的技术错误信息（用于调试和日志）
   */
  toDetailedMessage(): string {
    const parts: string[] = [
      `[${this.code}] ${this.message}`,
    ];

    if (this.context && Object.keys(this.context).length > 0) {
      parts.push(`Context: ${JSON.stringify(this.context, null, 2)}`);
    }

    if (this.cause) {
      if (this.cause instanceof Error) {
        parts.push(`Caused by: ${this.cause.name}: ${this.cause.message}`);
        if (this.cause.stack) {
          parts.push(`Stack: ${this.cause.stack}`);
        }
      } else {
        parts.push(`Caused by: ${JSON.stringify(this.cause)}`);
      }
    }

    parts.push(`Recoverable: ${this.recoverable}`);

    return parts.join('\n');
  }

  /**
   * 转换为 JSON 对象（用于日志记录）
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      context: this.context,
      cause: this.cause instanceof Error ? {
        name: this.cause.name,
        message: this.cause.message,
      } : this.cause,
    };
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 创建成功结果
 *
 * @example
 * ```typescript
 * return ok({ data: "success" });
 * ```
 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/**
 * 创建失败结果
 *
 * @example
 * ```typescript
 * return err(new VfsError(VfsErrorCode.NOT_FOUND, "资源未找到"));
 * ```
 */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/**
 * 🔧 P3修复：类型守卫 - 判断 Result 是否成功
 *
 * 使用此函数可以让 TypeScript 正确推断类型
 *
 * @example
 * ```typescript
 * const result = await someAsyncOperation();
 * if (isOk(result)) {
 *   console.log(result.value); // TypeScript 知道这是 Ok<T>
 * } else {
 *   console.error(result.error); // TypeScript 知道这是 Err<E>
 * }
 * ```
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok === true;
}

/**
 * 🔧 P3修复：类型守卫 - 判断 Result 是否失败
 *
 * 使用此函数可以让 TypeScript 正确推断类型
 *
 * @example
 * ```typescript
 * const result = await someAsyncOperation();
 * if (isErr(result)) {
 *   console.error(result.error); // TypeScript 知道这是 Err<E>
 * }
 * ```
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.ok === false;
}

/**
 * 将任意错误转换为 VfsError
 *
 * 用于 catch 块中统一错误处理。
 *
 * @example
 * ```typescript
 * try {
 *   // ... 操作
 * } catch (e) {
 *   return err(toVfsError(e, "操作失败"));
 * }
 * ```
 */
/**
 * M-015: 根据错误消息关键字推断错误码和可恢复性
 *
 * 抽取为独立函数，供 Error 对象和字符串错误共用，
 * 避免 Tauri invoke 返回的纯字符串错误丢失分类。
 */
function classifyErrorMessage(rawMessage: string): { code: VfsErrorCode; recoverable: boolean } {
  const message = rawMessage.toLowerCase();

  // 注意：'invalid state' 必须在 'invalid' 之前匹配，否则会被 VALIDATION 吞掉
  if (message.includes('invalid state') || message.includes('状态无效') || message.includes('not allowed')) {
    return { code: VfsErrorCode.INVALID_STATE, recoverable: false };
  }

  if (message.includes('not found') || message.includes('未找到') || message.includes('not_found')) {
    return { code: VfsErrorCode.NOT_FOUND, recoverable: true };
  }

  if (message.includes('conflict') || message.includes('冲突') || message.includes('already exists') || message.includes('已存在')) {
    return { code: VfsErrorCode.CONFLICT, recoverable: true };
  }

  if (message.includes('timeout') || message.includes('超时') || message.includes('timed out')) {
    return { code: VfsErrorCode.TIMEOUT, recoverable: true };
  }

  if (message.includes('network') || message.includes('网络') || message.includes('connection')) {
    return { code: VfsErrorCode.NETWORK, recoverable: true };
  }

  if (message.includes('parse') || message.includes('json') || message.includes('解析') || message.includes('syntax')) {
    return { code: VfsErrorCode.PARSE, recoverable: false };
  }

  if (message.includes('permission') || message.includes('权限') || message.includes('forbidden') || message.includes('unauthorized')) {
    return { code: VfsErrorCode.PERMISSION, recoverable: false };
  }

  if (message.includes('invalid') || message.includes('validation') || message.includes('无效') || message.includes('bad request') || message.includes('invalid argument')) {
    return { code: VfsErrorCode.VALIDATION, recoverable: false };
  }

  if (message.includes('capacity') || message.includes('容量') || message.includes('quota') || message.includes('space') || message.includes('disk full') || message.includes('超出限制')) {
    return { code: VfsErrorCode.CAPACITY_EXCEEDED, recoverable: false };
  }

  if (message.includes('dependency') || message.includes('依赖') || message.includes('related')) {
    return { code: VfsErrorCode.DEPENDENCY_FAILED, recoverable: true };
  }

  return { code: VfsErrorCode.UNKNOWN, recoverable: true };
}

export function toVfsError(
  error: unknown,
  defaultMessage = i18next.t('common:vfsErrors.operationFailed'),
  context?: Record<string, unknown>
): VfsError {
  // 已经是 VfsError
  if (error instanceof VfsError) {
    return error;
  }

  // 标准 Error 对象
  if (error instanceof Error) {
    const { code, recoverable } = classifyErrorMessage(error.message);
    return new VfsError(code, error.message, recoverable, context, error);
  }

  // 字符串错误（Tauri invoke 返回的 Err(String) 会以字符串形式到达前端）
  // M-015: 对字符串也做关键字分类，避免后端结构化错误被误判为 UNKNOWN
  if (typeof error === 'string') {
    const { code, recoverable } = classifyErrorMessage(error);
    return new VfsError(code, error, recoverable, context);
  }

  // 对象错误（尝试提取 message 字段）
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String(error.message);
    const { code, recoverable } = classifyErrorMessage(message);
    return new VfsError(code, message, recoverable, context, error);
  }

  // 其他类型错误
  return new VfsError(VfsErrorCode.UNKNOWN, defaultMessage, true, context, error);
}

/**
 * 从 Result 中解包值，如果失败则使用默认值
 *
 * @example
 * ```typescript
 * const result = divide(10, 0);
 * const value = unwrapOr(result, 0); // 0
 * ```
 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  return result.ok ? result.value : defaultValue;
}

/**
 * 从 Result 中解包值，如果失败则抛出错误
 *
 * @example
 * ```typescript
 * const result = divide(10, 2);
 * const value = unwrap(result); // 5
 * ```
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

/**
 * 映射 Result 的成功值
 *
 * @example
 * ```typescript
 * const result = ok(5);
 * const doubled = map(result, x => x * 2); // ok(10)
 * ```
 */
export function map<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : err(result.error);
}

/**
 * 映射 Result 的错误值
 *
 * @example
 * ```typescript
 * const result = err("错误");
 * const mapped = mapErr(result, e => new VfsError(VfsErrorCode.UNKNOWN, e));
 * ```
 */
export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F
): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/**
 * 链式调用 Result（flatMap）
 *
 * @example
 * ```typescript
 * const result = ok(10);
 * const chained = andThen(result, x => divide(x, 2)); // ok(5)
 * ```
 */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> {
  return result.ok ? fn(result.value) : err(result.error);
}

// ============================================================================
// 错误上报和通知
// ============================================================================

/**
 * 错误统计接口（可选实现）
 */
export interface ErrorStats {
  /** 记录错误发生 */
  recordError(code: VfsErrorCode, context: string): void;
  /** 获取错误统计 */
  getStats(): Record<VfsErrorCode, number>;
}

/**
 * 错误上报选项
 */
export interface ReportErrorOptions {
  /** 是否显示用户通知（默认根据 error.recoverable 决定） */
  showNotification?: boolean;
  /** 是否记录到控制台（默认 true） */
  logToConsole?: boolean;
  /** 是否记录统计（默认 true） */
  recordStats?: boolean;
  /** 通知类型（默认 'error'） */
  notificationType?: 'error' | 'warning' | 'info';
}

let errorStatsInstance: ErrorStats | null = null;
let notificationHandler: ((type: string, message: string) => void) | null = null;

/**
 * 设置错误统计实例
 */
export function setErrorStats(stats: ErrorStats): void {
  errorStatsInstance = stats;
}

/**
 * 设置通知处理器
 * @param handler 通知处理函数，接收 (type, message) 参数
 */
export function setNotificationHandler(handler: (type: string, message: string) => void): void {
  notificationHandler = handler;
}

/**
 * 统一的错误上报函数
 *
 * 根据错误的特征决定是否显示用户通知、记录日志和统计。
 *
 * @param error VFS 错误对象
 * @param context 错误发生的上下文描述（如 "创建笔记"、"加载文件夹"）
 * @param options 上报选项
 *
 * @example
 * ```typescript
 * const result = await createNote(data);
 * if (!result.ok) {
 *   reportError(result.error, '创建笔记');
 *   return;
 * }
 * ```
 */
export function reportError(
  error: VfsError,
  context: string,
  options: ReportErrorOptions = {}
): void {
  const {
    showNotification = !error.recoverable, // 不可恢复的错误默认显示通知
    logToConsole = true,
    recordStats = true,
    notificationType = 'error',
  } = options;

  // 记录到控制台
  if (logToConsole) {
    const logLevel = error.recoverable ? 'warn' : 'error';
    console[logLevel](
      `[ErrorReport] ${context}:`,
      error.toDetailedMessage()
    );
  }

  // 记录统计
  if (recordStats && errorStatsInstance) {
    errorStatsInstance.recordError(error.code, context);
  }

  // 显示用户通知
  if (showNotification && notificationHandler) {
    const message = i18next.t('common:vfsErrors.contextFailedPattern', { context, detail: error.toUserMessage() });
    notificationHandler(notificationType, message);
  }
}

/**
 * 简单的错误统计实现（内存存储）
 */
export class SimpleErrorStats implements ErrorStats {
  private stats: Map<VfsErrorCode, number> = new Map();

  recordError(code: VfsErrorCode, context: string): void {
    const count = this.stats.get(code) || 0;
    this.stats.set(code, count + 1);
  }

  getStats(): Record<VfsErrorCode, number> {
    const result: Record<string, number> = {};
    this.stats.forEach((count, code) => {
      result[code] = count;
    });
    return result as Record<VfsErrorCode, number>;
  }

  reset(): void {
    this.stats.clear();
  }
}
