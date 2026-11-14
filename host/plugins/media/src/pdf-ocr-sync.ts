/** `tokio::sync` analogues used by the PDF OCR session pipeline: watch, bounded mpsc, Semaphore, JoinSet. */

/** Minimal `tokio::sync::watch` channel of booleans. */
export class BoolWatch {
  private current: boolean;
  private waiters: Array<() => void> = [];
  constructor(initial = false) { this.current = initial; }
  get value(): boolean { return this.current; }
  send(value: boolean): void {
    this.current = value;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
  changed(): Promise<void> {
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }
}

/** Bounded mpsc channel: `send` waits for capacity, `recv` resolves null once closed and empty. */
export class BoundedChannel<T> {
  private items: T[] = [];
  private closedFlag = false;
  private receiverClosed = false;
  private recvWaiters: Array<() => void> = [];
  private sendWaiters: Array<() => void> = [];
  private readonly capacity: number;
  constructor(capacity: number) { this.capacity = capacity; }
  private wakeAll(list: Array<() => void>): void { for (const wake of list.splice(0)) wake(); }
  /** false when the receiver is gone (Rust `send` Err). */
  async send(item: T): Promise<boolean> {
    for (;;) {
      if (this.receiverClosed) return false;
      if (this.items.length < this.capacity) {
        this.items.push(item);
        this.wakeAll(this.recvWaiters);
        return true;
      }
      await new Promise<void>((resolve) => { this.sendWaiters.push(resolve); });
    }
  }
  /** All senders dropped. */
  close(): void { this.closedFlag = true; this.wakeAll(this.recvWaiters); }
  /** Receiver dropped. */
  closeReceiver(): void { this.receiverClosed = true; this.items = []; this.wakeAll(this.sendWaiters); }
  tryRecv(): T | undefined {
    const item = this.items.shift();
    if (item !== undefined) this.wakeAll(this.sendWaiters);
    return item;
  }
  get isClosed(): boolean { return this.closedFlag; }
  /** `timeout(ms, rx.recv())` without losing an item to an abandoned receive. */
  async recvTimeout(ms: number, sleep: (ms: number) => Promise<void>): Promise<T | null | 'timeout'> {
    const item = this.tryRecv();
    if (item !== undefined) return item;
    if (this.closedFlag) return null;
    await Promise.race([new Promise<void>((resolve) => { this.recvWaiters.push(resolve); }), sleep(ms)]);
    const next = this.tryRecv();
    if (next !== undefined) return next;
    return this.closedFlag ? null : 'timeout';
  }
  async recv(): Promise<T | null> {
    for (;;) {
      const item = this.tryRecv();
      if (item !== undefined) return item;
      if (this.closedFlag) return null;
      await new Promise<void>((resolve) => { this.recvWaiters.push(resolve); });
    }
  }
}

export class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];
  constructor(permits: number) { this.permits = permits; }
  async acquire(): Promise<() => void> {
    if (this.permits > 0) this.permits -= 1;
    else await new Promise<void>((resolve) => { this.waiters.push(resolve); });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next !== undefined) next();
      else this.permits += 1;
    };
  }
}

/** JoinSet retains completed tasks until join_next, including tasks that failed before draining. */
export class OcrTaskSet {
  private readonly running = new Set<Promise<void>>();
  private readonly finished: Array<{ error: unknown } | null> = [];

  add(task: Promise<void>, release: () => void): void {
    // OCR business errors have already taken ocrTask's Retrying/PageFailed branch. Only an
    // exception escaping that body is a task failure; observe it immediately to avoid a rejection leak.
    const settled = task.then(
      () => { this.finished.push(null); },
      (error: unknown) => { this.finished.push({ error }); },
    ).finally(() => { release(); this.running.delete(settled); });
    this.running.add(settled);
  }

  get size(): number { return this.running.size + this.finished.length; }

  async drain(log?: { error(message: string): void }, cancelled = false): Promise<void> {
    for (;;) {
      for (const result of this.finished.splice(0)) {
        if (result !== null && log !== undefined) {
          log.error(`[PdfOcrService] OCR task panicked: ${messageOf(result.error)}`);
        }
      }
      // The caller marks in-flight bodies aborted before this drain. Completed errors survive
      // abort_all; cancelled tasks don't log a panic or wait for the external OCR provider.
      if (cancelled || this.running.size === 0) return;
      await Promise.race(this.running);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
