import { Hlc } from './hlc.ts';
import { parseFlexibleTimestampMillis } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';
export { parseFlexibleTimestampMillis } from '../../../platform/time/index.ts';

/** sync/mod.rs:84-93 threshold shift between second and millisecond values. */
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** sync/mod.rs:71-95, including the SQLite and integer-millisecond formats. */
export function parseFlexibleTimestamp(value: string): Date | null {
  const millis = parseFlexibleTimestampMillis(value);
  return millis === null ? null : new Date(millis);
}

export interface LwwKey {
  readonly millis: bigint;
  readonly counter: number;
  readonly deviceId: string;
  readonly tiebreaker: string;
}

/** sync/mod.rs:4626-4655. */
export function canonicalLwwKey(timestamp: string, deviceId: string, contentTiebreaker: string): LwwKey {
  const hlc = Hlc.parse(timestamp);
  if (hlc) {
    return {
      millis: hlc.millis > I64_MAX ? I64_MAX : hlc.millis,
      counter: hlc.counter,
      deviceId,
      tiebreaker: contentTiebreaker,
    };
  }
  const parsed = parseFlexibleTimestampMillis(timestamp);
  return {
    millis: parsed === null ? I64_MIN : BigInt(parsed),
    counter: 0,
    deviceId,
    tiebreaker: parsed === null ? `${timestamp}|${contentTiebreaker}` : contentTiebreaker,
  };
}

/** sync/mod.rs:4657-4670. Returns -1, 0 or 1. */
export function compareLwwTimestamps(
  localTimestamp: string, localDeviceId: string, localContentTiebreaker: string,
  cloudTimestamp: string, cloudDeviceId: string, cloudContentTiebreaker: string,
): number {
  const local = canonicalLwwKey(localTimestamp, localDeviceId, localContentTiebreaker);
  const cloud = canonicalLwwKey(cloudTimestamp, cloudDeviceId, cloudContentTiebreaker);
  if (local.millis !== cloud.millis) return local.millis < cloud.millis ? -1 : 1;
  if (local.counter !== cloud.counter) return local.counter < cloud.counter ? -1 : 1;
  const device = compareUtf8(local.deviceId, cloud.deviceId);
  if (device !== 0) return device;
  return Math.sign(compareUtf8(local.tiebreaker, cloud.tiebreaker));
}

/** sync/mod.rs:4605-4609: neutral device components keep ties symmetric. */
export function compareTimestamps(local: string, cloud: string): number {
  return compareLwwTimestamps(local, '', '', cloud, '', '');
}

/** sync/mod.rs:4672-4678. */
export function timestampValueToLwwString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function dataDeviceId(data: unknown): string | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>).device_id;
  return typeof value === 'string' && rustTrim(value) !== '' ? value : null;
}

/** sync/mod.rs:4688-4709. Never uses evaluator-side constants. */
export function lwwDevicePair(
  localData: unknown,
  cloudData: unknown,
  cloudDeviceHint: string | null | undefined,
): [string, string] {
  const local = dataDeviceId(localData);
  const cloud = cloudDeviceHint && rustTrim(cloudDeviceHint) !== '' ? cloudDeviceHint : dataDeviceId(cloudData);
  return local !== null && cloud !== null ? [local, cloud] : ['', ''];
}

/** sync/mod.rs:4711-4716. */
export function lwwTimestampMillis(timestamp: string): bigint | null {
  const hlc = Hlc.parse(timestamp);
  if (hlc) return hlc.millis > I64_MAX ? null : hlc.millis;
  const parsed = parseFlexibleTimestampMillis(timestamp);
  return parsed === null ? null : BigInt(parsed);
}
