/**
 * 共享数据治理许可的结构化失败面。
 *
 * Rust 的 `DataGovernanceOperationGuard` 失败是 `AppError`：
 * - 同进程 semaphore 已被占用 / 跨进程 advisory lock 被占用 → `Validation`；
 * - 锁目录、锁文件或账本写入失败 → `FileSystem`。
 *
 * Host 侧必须让消费方（L23 云同步写命令）能稳定区分这两类，而不能靠
 * `Error.message.startsWith(...)` 猜前缀。`OperationGuardError` 同时：
 * - 继承 kernel `CommandError`，保证 IPC invoke 正常 settle（不会 panic）；
 * - 把 `value` 暴露为 Rust 同形的 `AppError`（`error_type`/`message`/`details`），
 *   供 L23 直接按原契约传输；
 * - 提供稳定的 `reason`/`code`/`app_error`/`cause` 判别字段。
 *
 * L21 自己的 `error: string` 命令在 `stringErrorCommand` 出口把 message 转回字符串；
 * 这不是对结构化错误的降级，而是各命令按原契约映射。
 */
import { CommandError } from '../../../kernel/api.ts';
import { AppError, type AppErrorType } from '../../../platform/errors/api.ts';

/** 消费方唯一需要区分的许可失败原因。 */
export type OperationGuardFailureReason = 'busy' | 'lock_io';

/** 稳定错误码；跨 lane 消费方不得按 message 前缀猜分类。 */
export const OPERATION_GUARD_ERROR_CODES = {
  busy: 'E_DATA_GOVERNANCE_BUSY',
  lock_io: 'E_DATA_GOVERNANCE_LOCK_IO',
} as const;

export type OperationGuardErrorCode =
  typeof OPERATION_GUARD_ERROR_CODES[OperationGuardFailureReason];

const APP_ERROR_TYPE: Readonly<Record<OperationGuardFailureReason, AppErrorType>> = {
  busy: 'Validation',
  lock_io: 'FileSystem',
};

/** Rust `try_acquire` 忙锁 / 锁 IO 的公开可判别错误。 */
export class OperationGuardError extends CommandError {
  declare readonly value: AppError;
  readonly reason: OperationGuardFailureReason;
  readonly code: OperationGuardErrorCode;
  /** Rust 同形 `AppError`；与 `value` 是同一对象，便于直接传输或检查。 */
  readonly app_error: AppError;

  constructor(reason: OperationGuardFailureReason, message: string, cause?: unknown) {
    const appError = AppError.with_details(APP_ERROR_TYPE[reason], message, null);
    super(appError);
    // CommandError 的默认 message 是 JSON；保留 Rust Display 文本给日志与字符串命令。
    this.message = message;
    this.reason = reason;
    this.code = OPERATION_GUARD_ERROR_CODES[reason];
    this.app_error = appError;
    if (cause !== undefined) this.cause = cause;
  }

  toAppError(): AppError {
    return this.app_error;
  }
}

/** 同进程 semaphore 忙锁：Rust `AppError::validation`。 */
export class OperationBusyError extends OperationGuardError {
  /** 兼容旧消费方的布尔判别；新代码请用 `reason`/`code`。 */
  readonly operationBusy = true;

  constructor(message: string, cause?: unknown) {
    super('busy', message, cause);
  }
}

/** 跨进程锁已存在（Rust advisory lock busy）：同样是 `Validation`。 */
export class OperationLockBusyError extends OperationBusyError {}

/** 锁目录/文件/账本 IO 失败：Rust `AppError::file_system`。 */
export class OperationLockError extends OperationGuardError {
  constructor(message: string, cause?: unknown) {
    super('lock_io', message, cause);
  }
}

/** 跨模块/跨 realm 也可用的判别器；不依赖调用方 import 同一个类实例。 */
export function isOperationGuardError(error: unknown): error is OperationGuardError {
  if (error instanceof OperationGuardError) return true;
  if (!(error instanceof Error)) return false;
  const candidate = error as Partial<OperationGuardError>;
  if (candidate.reason !== 'busy' && candidate.reason !== 'lock_io') return false;
  if (typeof candidate.code !== 'string') return false;
  const appError = candidate.app_error;
  return typeof appError === 'object' && appError !== null
    && typeof (appError as { error_type?: unknown }).error_type === 'string'
    && typeof (appError as { message?: unknown }).message === 'string';
}
