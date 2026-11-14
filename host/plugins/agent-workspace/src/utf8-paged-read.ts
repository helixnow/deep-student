import { asciiLower } from './runtime-paths.ts';
import { rustTrim } from '../../../platform/util/index.ts';
export { sha256Hex } from './runtime-paths.ts';

export const DEFAULT_READ_MAX_BYTES = 64 * 1024;
export const MAX_READ_MAX_BYTES = 1024 * 1024;
// dstu-agent-api/src/budget.rs:15; shared outer-budget implementation belongs to F1.
const DEFAULT_TOOL_RESULT_CHAR_BUDGET = 30_000;
export interface Utf8Page {
  content: string; offset: number; returned_bytes: number; next_offset: number; eof: boolean; truncated: boolean;
}
export function isContinuationByte(byte: number): boolean { return (byte & 0xc0) === 0x80; }
function field(args: unknown, key: string): unknown { return (args as Record<string, unknown> | null)?.[key]; }
function isU64(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 64; }
export function parseOffset(args: unknown): number {
  const value = field(args, 'offset');
  if (value === null || value === undefined) return 0;
  if (!isU64(value)) throw new Error('offset must be a non-negative integer');
  return value;
}
export function parseMaxBytes(args: unknown): number {
  const value = field(args, 'max_bytes');
  if (value === undefined) return DEFAULT_READ_MAX_BYTES;
  if (!isU64(value)) throw new Error('max_bytes must be a positive integer');
  if (value < 1 || value > MAX_READ_MAX_BYTES) throw new Error(`max_bytes must be between 1 and ${MAX_READ_MAX_BYTES}`);
  return value;
}
export function optionalExpectedHash(args: unknown): string | null {
  const value = field(args, 'expected_hash');
  return typeof value === 'string' && rustTrim(value) ? asciiLower(rustTrim(value)) : null;
}
export function checkExpectedHash(expected: string, actual: string): void {
  if (asciiLower(expected) !== asciiLower(actual)) throw new Error(`expected_hash 不匹配：当前 sha256 为 ${actual}。内容可能已变化，请从 offset=0 重新读取。`);
}
export function pageUtf8Text(text: string, offset: number, maxBytes: number): Utf8Page {
  const bytes = Buffer.from(text); const total = bytes.length;
  if (offset > total) throw new Error(`offset ${offset} exceeds content length ${total}`);
  if (offset === total) return { content: '', offset, returned_bytes: 0, next_offset: offset, eof: true, truncated: false };
  if (isContinuationByte(bytes[offset]!)) throw new Error(`offset ${offset} is not a UTF-8 character boundary`);
  let end = Math.min(offset + Math.max(maxBytes, 1), total);
  while (end > 0 && end < total && isContinuationByte(bytes[end]!)) end--;
  if (end <= offset) {
    end = offset + 1;
    while (end < total && isContinuationByte(bytes[end]!)) end++;
  }
  const content = bytes.subarray(offset, end).toString('utf8');
  const eof = end >= total;
  return { content, offset, returned_bytes: end - offset, next_offset: end, eof, truncated: !eof };
}
export function decodeUtf8Window(bytes: Uint8Array, moreRemains: boolean): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: moreRemains }); }
  catch { throw new Error('workspace_file_read currently supports UTF-8 text files only'); }
}
export function serializedCharLen(value: unknown): number { return [...JSON.stringify(value)].length; }
export function applyPagingFields(output: Record<string, unknown>, contentKey: string, content: string, offset: number, totalBytes: number): void {
  const returnedBytes = Buffer.byteLength(content); const nextOffset = offset + returnedBytes; const eof = nextOffset >= totalBytes;
  output[contentKey] = content; output.offset = offset; output.returned_bytes = returnedBytes; output.next_offset = nextOffset;
  output.eof = eof; output.truncated = !eof;
  if (Object.hasOwn(output, 'contentLength')) output.contentLength = returnedBytes;
  if (Object.hasOwn(output, 'contentTruncated')) output.contentTruncated = !eof;
}
export function fitPagedContentToBudget(output: Record<string, unknown>, contentKey: string, offset: number, totalBytes: number, budget: number): boolean {
  const original = output[contentKey];
  if (typeof original !== 'string') return serializedCharLen(output) <= budget;
  applyPagingFields(output, contentKey, original, offset, totalBytes);
  if (serializedCharLen(output) <= budget) return true;
  applyPagingFields(output, contentKey, '', offset, totalBytes);
  if (serializedCharLen(output) > budget) { applyPagingFields(output, contentKey, original, offset, totalBytes); return false; }
  const chars = [...original]; let best = 0; let low = 0; let high = chars.length;
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    applyPagingFields(output, contentKey, chars.slice(0, mid).join(''), offset, totalBytes);
    if (serializedCharLen(output) <= budget) {
      best = mid;
      if (mid === chars.length) break;
      low = mid + 1;
    } else if (mid === 0) { best = 0; break; }
    else high = mid - 1;
  }
  if (best === 0 && original !== '') { applyPagingFields(output, contentKey, original, offset, totalBytes); return false; }
  applyPagingFields(output, contentKey, chars.slice(0, best).join(''), offset, totalBytes);
  return true;
}
export function fitPagedReadToDefaultBudget(output: Record<string, unknown>, contentKey: string, offset: number, totalBytes: number): boolean {
  return fitPagedContentToBudget(output, contentKey, offset, totalBytes, DEFAULT_TOOL_RESULT_CHAR_BUDGET - 400);
}
