/**
 * ChatAnki 分段计数（progress.counts）类型化解析。
 *
 * 后端 patch 中的 counts 是弱类型 JSON；这里统一收紧成结构化对象，
 * 供 ankiCardsBlock 与 ChatAnkiProgressCompact 共用，消灭 `as any`。
 */

export interface AnkiCardsSegmentCounts {
  total?: number;
  pending?: number;
  processing?: number;
  streaming?: number;
  paused?: number;
  completed?: number;
  failed?: number;
  truncated?: number;
  cancelled?: number;
}

const COUNT_KEYS = [
  'total',
  'pending',
  'processing',
  'streaming',
  'paused',
  'completed',
  'failed',
  'truncated',
  'cancelled',
] as const;

export function parseAnkiSegmentCounts(counts: unknown): AnkiCardsSegmentCounts | null {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return null;
  const record = counts as Record<string, unknown>;
  const result: AnkiCardsSegmentCounts = {};
  for (const key of COUNT_KEYS) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = value;
    }
  }
  return result;
}
