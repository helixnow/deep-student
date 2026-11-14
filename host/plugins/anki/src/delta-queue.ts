/** 增量文本队列：`onDelta` 同步入队，消费协程异步切卡/入库。 */
export class DeltaQueue {
  private readonly values: string[] = [];
  private readonly waiting: Array<(result: IteratorResult<string, undefined>) => void> = [];
  private closed = false;

  push(value: string): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter !== undefined) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting.push(resolve as (result: IteratorResult<string, undefined>) => void);
        });
      },
    };
  }
}
