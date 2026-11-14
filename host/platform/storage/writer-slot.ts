/**
 * 每库一个的写者槽（可移植：只依赖 `errors.ts`，桌面 better-sqlite3 与移动端 SQLite WASM 共用）。
 */
import { StorageError } from './errors.ts';

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

/** FIFO 互斥量，支持 AbortSignal 取消等待。 */
export class WriterSlot {
  private held = false;
  private readonly queue: Waiter[] = [];

  get isHeld(): boolean {
    return this.held;
  }

  get pending(): number {
    return this.queue.length;
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(abortError(signal));
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, onAbort: undefined };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.held = false;
      return;
    }
    if (next.signal !== undefined && next.onAbort !== undefined) {
      next.signal.removeEventListener('abort', next.onAbort);
    }
    next.resolve();
  }
}

export function abortError(signal: AbortSignal): StorageError {
  return new StorageError('ABORTED', 'Transaction aborted', { cause: signal.reason });
}
