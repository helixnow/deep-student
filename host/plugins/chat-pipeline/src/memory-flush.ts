/**
 * chat_v2/pipeline/compaction/memory_flush.rs — pure memory-flush helpers.
 */
import { rustTrim } from '../../../platform/util/index.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';

export const MEMORY_FLUSH_SEGMENT_MAX_CHARS = 12_000;

/** Stable segment ID: length-prefixed SHA-256 over every boundary component. */
export function buildMemoryFlushSegmentId(sessionId: string, previousCompactionId: string | null,
  startMessageId: string, endMessageIdExclusive: string, ordinal: number): string {
  const hasher = createHasherSync('SHA-256');
  for (const part of [
    'compaction-memory-flush-v1',
    sessionId,
    previousCompactionId ?? '',
    startMessageId,
    endMessageIdExclusive,
    String(ordinal),
  ]) {
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(utf8ByteLength(part)));
    hasher.update(length);
    hasher.update(part);
  }
  return `seg_${hasher.digestHex().slice(0, 32)}`;
}

/** str::split_inclusive: each unit keeps its trailing separator (last one may not have it). */
function splitInclusive(text: string, separator: string): string[] {
  const units: string[] = [];
  let index = 0;
  for (;;) {
    const found = text.indexOf(separator, index);
    if (found === -1) {
      if (index < text.length) units.push(text.slice(index));
      return units;
    }
    units.push(text.slice(index, found + separator.length));
    index = found + separator.length;
  }
}

/**
 * Keeps rendered message/tool blocks separated by blank lines intact whenever
 * possible; only an oversized single unit is split at a character boundary.
 */
export function splitMemoryFlushSegment(text: string): string[] {
  const trimmed = rustTrim(text);
  if (trimmed === '') return [];
  const chunks: string[] = [];
  let current = '';
  let currentChars = 0;

  for (const unit of splitInclusive(trimmed, '\n\n')) {
    const unitChars = [...unit].length;
    if (unitChars <= MEMORY_FLUSH_SEGMENT_MAX_CHARS) {
      if (currentChars > 0 && currentChars + unitChars > MEMORY_FLUSH_SEGMENT_MAX_CHARS) {
        chunks.push(current);
        current = '';
        currentChars = 0;
      }
      current += unit;
      currentChars += unitChars;
      continue;
    }

    if (current !== '') {
      chunks.push(current);
      current = '';
      currentChars = 0;
    }
    for (const ch of unit) {
      current += ch;
      currentChars += 1;
      if (currentChars === MEMORY_FLUSH_SEGMENT_MAX_CHARS) {
        chunks.push(current);
        current = '';
        currentChars = 0;
      }
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}
