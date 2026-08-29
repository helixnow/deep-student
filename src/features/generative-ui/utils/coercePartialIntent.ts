/**
 * 从半截 / 损坏 JSON 尽量抽出已闭合的合法 blocks。
 */

import {
  extractClosedBlockObjectSlices,
  sanitizeGenerativeJsonBuffer,
} from '../parser';
import { recoverGenerativeBlocks, recoverGenerativeUIIntent } from '../schema';
import type { GenerativeUIIntent } from '../types';
import {
  MAX_GENERATIVE_UI_STREAM_CHARS,
  STREAM_BUFFER_CAPPED_WARNING,
  isStreamBufferOverCap,
} from './streamBufferGuard';

export interface CoercePartialIntentResult {
  intent: GenerativeUIIntent | null;
  dropped: number;
  truncated: boolean;
  warnings: string[];
}

function isCompleteJson(sanitized: string): boolean {
  try {
    JSON.parse(sanitized);
    return true;
  } catch {
    return false;
  }
}

function parseVersionHint(sanitized: string): NonNullable<GenerativeUIIntent['version']> {
  return /"version"\s*:\s*"1\.1"/.test(sanitized) ? '1.1' : '1';
}

/**
 * 从半截 JSON 抽出已闭合 blocks：丢弃非法块，保留合法块。
 * `truncated` 在 JSON 未闭合或超过 32 块上限时为 true。
 */
export function coercePartialIntent(
  raw: string,
  maxChars: number = MAX_GENERATIVE_UI_STREAM_CHARS,
): CoercePartialIntentResult {
  const empty: CoercePartialIntentResult = {
    intent: null,
    dropped: 0,
    truncated: false,
    warnings: [],
  };
  if (!raw) return empty;
  if (isStreamBufferOverCap(raw.length, maxChars)) {
    return {
      intent: null,
      dropped: 0,
      truncated: true,
      warnings: [STREAM_BUFFER_CAPPED_WARNING],
    };
  }
  if (!raw.trim()) return empty;

  const sanitized = sanitizeGenerativeJsonBuffer(raw);
  if (!sanitized) return empty;

  try {
    const parsed = JSON.parse(sanitized);
    const recovered = recoverGenerativeUIIntent(parsed);
    if (recovered) {
      return {
        intent: recovered.intent,
        dropped: recovered.dropped,
        truncated: recovered.truncated,
        warnings: recovered.warnings,
      };
    }
  } catch {
    // incomplete / malformed — fall through to closed-slice recovery
  }

  const slices = extractClosedBlockObjectSlices(raw);
  const objects: unknown[] = [];
  let sliceDropped = 0;
  for (const slice of slices) {
    try {
      objects.push(JSON.parse(slice));
    } catch {
      sliceDropped += 1;
    }
  }

  const recovered = recoverGenerativeBlocks(objects);
  const incomplete = !isCompleteJson(sanitized);
  const truncated = recovered.truncated || incomplete;
  const dropped = recovered.dropped + sliceDropped;

  if (recovered.blocks.length === 0 && dropped === 0) {
    return {
      intent: null,
      dropped: 0,
      truncated: incomplete && sanitized.includes('{'),
      warnings: recovered.warnings,
    };
  }

  return {
    intent: {
      version: parseVersionHint(sanitized),
      blocks: recovered.blocks,
    },
    dropped,
    truncated,
    warnings: recovered.warnings,
  };
}
