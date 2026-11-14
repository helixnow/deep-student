import type { HlcValue } from '../api.ts';

export const MAX_DRIFT_MS = 60_000;
export const MAX_HLC_MILLIS = (1n << 48n) - 1n;
export const MAX_HLC_COUNTER = 0xffff;

/** sync/hlc.rs:25-61. This is a legacy parser, not a writable clock. */
export class Hlc implements HlcValue {
  static readonly ZERO = new Hlc(0n, 0);
  readonly millis: bigint;
  readonly counter: number;

  constructor(millis: bigint, counter: number) {
    this.millis = millis;
    this.counter = counter;
  }

  toString(): string {
    return `${this.millis.toString().padStart(15, '0')}-${this.counter.toString().padStart(5, '0')}`;
  }

  static parse(value: string): Hlc | null {
    const match = /^(\+?[0-9]+)-(\+?[0-9]+)$/.exec(value);
    if (!match || match[0] !== value) return null;
    const millis = BigInt(match[1]!);
    const counter = BigInt(match[2]!);
    if (millis > 0xffffffffffffffffn || counter > 0xffffn) return null;
    return new Hlc(millis, Number(counter));
  }

  toU64(): bigint {
    if (this.millis < 0n || this.millis > MAX_HLC_MILLIS) throw new RangeError('HLC millis exceeds 48-bit range');
    return BigInt.asUintN(64, (this.millis << 16n) | BigInt(this.counter));
  }

  static fromU64(value: bigint): Hlc {
    return new Hlc(value >> 16n, Number(value & 0xffffn));
  }
}

/** Writable clock; the legacy parser intentionally retains its wider input range. */
export class HlcClock {
  private lastMillis = 0n;
  private lastCounter = 0;
  private initialized = false;

  constructor(initial: Hlc = Hlc.ZERO) {
    this.validate(initial.millis, initial.counter);
    this.commit(initial.millis, initial.counter);
    this.initialized = initial.millis !== 0n || initial.counter !== 0;
  }

  tick(wallClockMillis: bigint, monotonicDeltaMs?: bigint): Hlc {
    if (wallClockMillis < 0n || (monotonicDeltaMs !== undefined && monotonicDeltaMs < 0n)) {
      throw new RangeError('Clock time and monotonic delta must be non-negative');
    }
    let wall = wallClockMillis;
    if (this.initialized && monotonicDeltaMs !== undefined) {
      const ceiling = this.lastMillis + monotonicDeltaMs;
      if (wall > ceiling) wall = ceiling;
    }
    const nextMillis = wall > this.lastMillis ? wall : this.lastMillis;
    const nextCounter = nextMillis === this.lastMillis ? this.lastCounter + 1 : 0;
    return this.commit(nextMillis, nextCounter);
  }

  receive(remote: Hlc, wallClockMillis: bigint): {
    decision: 'absorb' | 'defer_skew'; localHlc: Hlc; preservedRemoteHlc: Hlc; driftMs: bigint;
  } {
    this.validate(remote.millis, remote.counter);
    if (wallClockMillis < 0n) throw new RangeError('Negative wall clock');
    const driftMs = remote.millis > wallClockMillis ? remote.millis - wallClockMillis : 0n;
    if (driftMs > BigInt(MAX_DRIFT_MS)) {
      return { decision: 'defer_skew', localHlc: new Hlc(this.lastMillis, this.lastCounter), preservedRemoteHlc: remote, driftMs };
    }
    return { decision: 'absorb', localHlc: this.forceAbsorb(remote, wallClockMillis), preservedRemoteHlc: remote, driftMs };
  }

  forceAbsorb(remote: Hlc, wallClockMillis: bigint): Hlc {
    this.validate(remote.millis, remote.counter);
    if (wallClockMillis < 0n) throw new RangeError('Negative wall clock');
    let nextMillis = wallClockMillis > this.lastMillis ? wallClockMillis : this.lastMillis;
    if (remote.millis > nextMillis) nextMillis = remote.millis;
    let nextCounter = 0;
    if (nextMillis === this.lastMillis) nextCounter = this.lastCounter;
    if (nextMillis === remote.millis) nextCounter = Math.max(nextCounter, remote.counter);
    return this.commit(nextMillis, nextCounter);
  }

  private validate(millis: bigint, counter: number): void {
    if (millis < 0n || millis > MAX_HLC_MILLIS || !Number.isInteger(counter) || counter < 0 || counter > MAX_HLC_COUNTER) {
      throw new RangeError('HLC exceeds 48-bit millis / 16-bit counter');
    }
  }

  private commit(millis: bigint, counter: number): Hlc {
    if (counter > MAX_HLC_COUNTER) { millis += 1n; counter = 0; }
    this.validate(millis, counter);
    this.lastMillis = millis;
    this.lastCounter = counter;
    this.initialized = true;
    return new Hlc(millis, counter);
  }
}
