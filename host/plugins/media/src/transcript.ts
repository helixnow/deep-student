import type { MediaSegmentRow } from '../api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';

export { rustTrim };

export function parseI64(value: string): bigint | null {
  if (!/^[+-]?[0-9]+$/.test(value)) return null;
  const result = BigInt(value);
  return result >= -(1n << 63n) && result < (1n << 63n) ? result : null;
}

export function formatTimestamp(ms: number): string {
  const total = Math.trunc(Math.max(ms, 0) / 1000);
  const h = Math.trunc(total / 3600);
  const m = Math.trunc((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function parseTimestamp(input: string): number | null {
  const nums = rustTrim(input).split(':').map(parseI64);
  if (nums.some(n => n === null)) return null;
  const n = nums as bigint[];
  let seconds: bigint;
  if (n.length === 2 && n[1]! < 60n) seconds = n[0]! * 60n + n[1]!;
  else if (n.length === 3 && n[1]! < 60n && n[2]! < 60n) seconds = n[0]! * 3600n + n[1]! * 60n + n[2]!;
  else return null;
  return Number(BigInt.asIntN(64, seconds * 1000n));
}

export function formatLine(startMs: number, text: string): string {
  const flat = text.split(/\p{White_Space}+/u).filter(Boolean).join(' ');
  return `[${formatTimestamp(startMs)}] ${flat}`;
}

export function buildTranscriptText(segments: readonly MediaSegmentRow[]): string {
  return segments.filter(s => s.status === 1 && rustTrim(s.text) !== '')
    .map(s => formatLine(s.start_ms, s.text)).join('\n');
}
