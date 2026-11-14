/** `tokio::sync::Semaphore` subset: FIFO waiters, never closed; `acquire` resolves to an idempotent release. */
export class Semaphore {
  private readonly waiters: (() => void)[] = [];
  private permits: number;
  constructor(permits: number) { this.permits = permits; }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) this.permits--;
    else await new Promise<void>(resolve => this.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next !== undefined) next();
      else this.permits++;
    };
  }

  availablePermits(): number { return this.permits; }
}
