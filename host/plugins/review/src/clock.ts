/**
 * 单一时刻读数：Rust 的 `Utc::now()` 同时给出毫秒时间戳与 chrono `to_rfc3339()` 文本，
 * 两者必须来自同一个时刻。chrono 的 `SecondsFormat::AutoSi` 小数位为 0/3/6/9 位。
 *
 * 实现使用 F4 平台模块 `host/platform/time`（chrono 0.4 兼容）。
 */
import { now, toRfc3339 } from '../../../platform/time/index.ts';

export interface UtcInstant {
  readonly nanos: bigint;
  /** `Utc::now().timestamp_millis()`。 */
  readonly ms: number;
  /** `Utc::now().to_rfc3339()`（AutoSi，UTC 偏移写作 `+00:00`）。 */
  readonly rfc: string;
}

export function utcNow(): UtcInstant {
  const instant = now();
  return { nanos: instant.epochNanos, ms: instant.millis, rfc: instant.rfc3339 };
}

/** Rust `(now + Duration::nanoseconds(delta)).to_rfc3339()`。 */
export function rfcNanosAfter(instant: UtcInstant, delta: bigint): string {
  return toRfc3339(instant.nanos + delta);
}
