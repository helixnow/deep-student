/**
 * Process-wide KB mutation gate.
 *
 * Mirrors `KB_MUTATION_LOCK` in `crates/dstu-vfs/src/lance_vector_store.rs`
 * (tokio `RwLock`, writer-preferring). Chat embedding deletes and the legacy KB
 * wide-table add/clear paths share this single lock, so a destructive clear
 * cannot interleave with an append/delete.
 */
export class KbMutationLock {
  private readers = 0;
  private writer = false;
  private waiting: Array<() => void> = [];

  private async acquire(exclusive: boolean): Promise<() => void> {
    while (this.writer || (exclusive && this.readers > 0) || (!exclusive && this.waiting.length > 0)) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    if (exclusive) this.writer = true;
    else this.readers += 1;
    return () => {
      if (exclusive) this.writer = false;
      else this.readers -= 1;
      const next = this.waiting.shift();
      if (next !== undefined) next();
    };
  }

  read<T>(fn: () => Promise<T>): Promise<T> {
    return this.acquire(false).then(async (release) => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  write<T>(fn: () => Promise<T>): Promise<T> {
    return this.acquire(true).then(async (release) => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }
}

export const KB_MUTATION_LOCK = new KbMutationLock();
