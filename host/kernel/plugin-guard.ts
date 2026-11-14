/**
 * Rust: src/plugins/ilink_bot/guard.rs. Sliding window is per peer and keeps the same
 * boundary rule as Rust (`elapsed > 60s` evicts, exactly 60s still counts).
 */
export function isBoundUser(boundUserId: string, peerId: string): boolean {
  return boundUserId.length > 0 && boundUserId === peerId;
}

export class RateLimiter {
  private readonly perMin: number | bigint;
  private readonly windows = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(perMin: number | bigint, now: () => number = () => performance.now()) {
    this.perMin = typeof perMin === 'bigint' ? (perMin < 1n ? 1n : perMin) : Math.max(1, Math.trunc(perMin));
    this.now = now;
  }

  checkAndRecord(peerId: string): boolean {
    const now = this.now();
    const queue = this.windows.get(peerId) ?? [];
    let first = 0;
    while (first < queue.length && now - queue[first]! > 60_000) first++;
    if (first > 0) queue.splice(0, first);
    if (queue.length >= this.perMin) {
      this.windows.set(peerId, queue);
      return false;
    }
    queue.push(now);
    this.windows.set(peerId, queue);
    return true;
  }
}
