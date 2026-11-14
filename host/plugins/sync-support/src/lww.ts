/**
 * LWW 比较：逐行移植 `sync/mod.rs:4612-4710`
 * （`canonical_lww_key` / `compare_lww_timestamps` / `timestamp_value_to_lww_string` /
 * `lww_device_pair`）。
 *
 * 这些工具在 Rust 中属于 `SyncManager`（L20）。L20 的 `sync` 目前只发布 HLC
 * 解析/构造，未发布 LWW 比较；`conflict_resolver.rs` 属本 lane 且必须用它，
 * 因此在此实现同一算法，并在报告中申请由 L20 的 `sync` 统一（接口需求）。
 */
import type { Json } from './json.ts';
import { parseFlexibleTimestampSqlite } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/portable.ts';

/** `hlc.rs:18-63` legacy HLC：`"<millis:015>-<counter:05>"`。 */
export interface ParsedHlc {
  millis: bigint;
  counter: number;
}

/** `Hlc::parse`：`splitn(2,'-')` + `u64::from_str` + `u16::from_str`（允许前导 `+`）。 */
export function parseHlc(value: string): ParsedHlc | null {
  const index = value.indexOf('-');
  if (index < 0) return null;
  const millisText = value.slice(0, index);
  const counterText = value.slice(index + 1);
  if (!/^\+?\d+$/u.test(millisText) || !/^\+?\d+$/u.test(counterText)) return null;
  const millis = BigInt(millisText.replace('+', ''));
  const counter = Number(counterText.replace('+', ''));
  if (millis > 0xffff_ffff_ffff_ffffn) return null;
  if (!Number.isSafeInteger(counter) || counter > 65_535) return null;
  return { millis, counter };
}

function clampMillis(millis: bigint): bigint {
  const MAX = 9_223_372_036_854_775_807n;
  return millis > MAX ? MAX : millis;
}

/** Rust `str` 的字节序比较（ASCII 设备/内容键等价）。 */
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

interface CanonicalLwwKey {
  millis: bigint;
  counter: number;
  device: string;
  tiebreaker: string;
}

function canonicalLwwKey(timestamp: string, deviceId: string, contentTiebreaker: string): CanonicalLwwKey {
  const hlc = parseHlc(timestamp);
  if (hlc !== null) {
    return {
      millis: clampMillis(hlc.millis),
      counter: hlc.counter,
      device: deviceId,
      tiebreaker: contentTiebreaker,
    };
  }
  const parsed = parseFlexibleTimestampSqlite(timestamp);
  if (parsed === null) {
    const MIN = -9_223_372_036_854_775_808n;
    return {
      millis: MIN,
      counter: 0,
      device: deviceId,
      tiebreaker: `${timestamp}|${contentTiebreaker}`,
    };
  }
  return {
    millis: BigInt(parsed.millis),
    counter: 0,
    device: deviceId,
    tiebreaker: contentTiebreaker,
  };
}

/**
 * `SyncManager::compare_lww_timestamps` → `std::cmp::Ordering`：
 * 返回 `-1`（Less）/ `0`（Equal）/ `1`（Greater）。
 */
export function compareLwwTimestamps(
  localTimestamp: string,
  localDeviceId: string,
  localContentTiebreaker: string,
  cloudTimestamp: string,
  cloudDeviceId: string,
  cloudContentTiebreaker: string,
): -1 | 0 | 1 {
  const local = canonicalLwwKey(localTimestamp, localDeviceId, localContentTiebreaker);
  const cloud = canonicalLwwKey(cloudTimestamp, cloudDeviceId, cloudContentTiebreaker);
  if (local.millis !== cloud.millis) return local.millis < cloud.millis ? -1 : 1;
  if (local.counter !== cloud.counter) return local.counter < cloud.counter ? -1 : 1;
  const device = compareText(local.device, cloud.device);
  if (device !== 0) return device < 0 ? -1 : 1;
  const tie = compareText(local.tiebreaker, cloud.tiebreaker);
  if (tie !== 0) return tie < 0 ? -1 : 1;
  return 0;
}

/** `SyncManager::timestamp_value_to_lww_string`：字符串或数字转字符串，其余 `null`。 */
export function timestampValueToLwwString(value: Json | undefined): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function nonEmpty(value: Json | undefined): string | null {
  return typeof value === 'string' && rustTrim(value) !== '' ? value : null;
}

/**
 * `SyncManager::lww_device_pair`：仅当双方写入者都可知时才用真实 device_id；
 * 任一未知则双方退化为相同的中性值（平局交给内容 tiebreaker）。
 */
export function lwwDevicePair(
  localData: Json,
  cloudData: Json | null | undefined,
  cloudDeviceHint: string | null | undefined,
): [string, string] {
  const local = isObject(localData) ? nonEmpty(localData.device_id) : null;
  const cloud =
    (typeof cloudDeviceHint === 'string' && rustTrim(cloudDeviceHint) !== '' ? cloudDeviceHint : null) ??
    (isObject(cloudData) ? nonEmpty(cloudData.device_id) : null);
  return local !== null && cloud !== null ? [local, cloud] : ['', ''];
}

function isObject(value: Json | null | undefined): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
