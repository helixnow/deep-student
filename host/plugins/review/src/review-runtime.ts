/**
 * `FsrsReviewService` 的共享运行环境：mistakes 库、日志与事务包装。
 *
 * 拆分自 `review.ts`，供调度动作、统计、记忆状态等子模块复用；事务错误的
 * 映射与 Rust `AppError::database` 保持一致。
 */
import type { DatabaseHandle, SyncTransaction } from '../../../platform/storage/api.ts';
import { appError, errorText } from './errors.ts';

export class ReviewRuntime {
  readonly db: DatabaseHandle;
  readonly warn: (message: string) => void;
  readonly info: (message: string) => void;
  readonly debug: (message: string) => void;

  constructor(
    db: DatabaseHandle,
    warn: (message: string) => void,
    info: (message: string) => void,
    debug: (message: string) => void,
  ) {
    this.db = db;
    this.warn = warn;
    this.info = info;
    this.debug = debug;
  }

  tx<T>(behavior: 'immediate' | 'deferred', fn: (tx: SyncTransaction) => T): T {
    try {
      return this.db.transaction(fn, { behavior });
    } catch (error) {
      if (error instanceof Error && 'value' in error) throw error;
      throw appError('Database', errorText(error));
    }
  }
}
