/**
 * Bounded, session-owned, process-local translation result cache with explicit claims
 * (translation_executor.rs:607-822).
 */
import { charLength } from './policy.ts';
import { translationFailure, type Term } from './tool_args.ts';

export const TRANSLATION_RESULT_TTL_MS = 30 * 60 * 1_000;
export const TRANSLATION_RESULT_CACHE_MAX_ENTRIES = 16;
export const TRANSLATION_RESULT_CACHE_MAX_CHARS = 4_000_000;
export const STALE_CLAIM_REDEEM_AFTER_MS = 180 * 1_000;

export interface CachedTranslationMeta {
  formality?: string;
  domain?: string;
  terms: Term[];
  promptOverride?: string;
  /** True when only a prefix of the requested source was translated. */
  partial: boolean;
  completedSegments: number;
  segmentCount: number;
}

export function defaultCachedMeta(): CachedTranslationMeta {
  return { terms: [], partial: false, completedSegments: 0, segmentCount: 0 };
}

export interface CachedTranslation {
  resultId: string;
  ownerSessionId: string;
  source: string;
  translated: string;
  sourceLang: string;
  targetLang: string;
  insertedAtMs: number;
  charCount: number;
  claimed: boolean;
  claimedAtMs: number | null;
  meta: CachedTranslationMeta;
}

export interface InsertTranslation {
  ownerSessionId: string;
  source: string;
  translated: string;
  sourceLang: string;
  targetLang: string;
  meta: CachedTranslationMeta;
  nowMs: number;
}

export type ClaimOutcome =
  | { kind: 'claimed'; entry: CachedTranslation }
  /** The entry exists but a fresh claim is in flight (another save call). */
  | { kind: 'busy' }
  | { kind: 'not_found' };

function cloneEntry(entry: CachedTranslation): CachedTranslation {
  return structuredClone(entry);
}

export class TranslationResultCache {
  private entries: CachedTranslation[] = [];
  private charTotal = 0;
  readonly maxEntries: number;
  readonly maxTotalChars: number;
  readonly ttlMs: number;

  constructor(maxEntries: number, maxTotalChars: number, ttlMs: number) {
    this.maxEntries = maxEntries;
    this.maxTotalChars = maxTotalChars;
    this.ttlMs = ttlMs;
  }

  get totalChars(): number {
    return this.charTotal;
  }

  private pruneExpired(nowMs: number): void {
    while (this.entries.length > 0) {
      const front = this.entries[0]!;
      if (nowMs - front.insertedAtMs < this.ttlMs) break;
      this.evictOldest();
    }
  }

  private evictOldest(): void {
    const entry = this.entries.shift();
    if (entry !== undefined) this.charTotal = Math.max(0, this.charTotal - entry.charCount);
  }

  insertAt(input: InsertTranslation): string {
    this.pruneExpired(input.nowMs);
    const charCount = charLength(input.source) + charLength(input.translated);
    if (this.maxEntries === 0 || charCount > this.maxTotalChars) {
      throw translationFailure(
        'TRANSLATION_RESULT_TOO_LARGE',
        `The complete translation requires ${charCount} cached characters; capacity is ${this.maxTotalChars}.`,
        'Translate a smaller source range and save each result before continuing.',
        false,
      );
    }
    while (this.entries.length >= this.maxEntries || this.charTotal + charCount > this.maxTotalChars) {
      this.evictOldest();
    }
    const resultId = `translation_result_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
    this.entries.push({
      resultId,
      ownerSessionId: input.ownerSessionId,
      source: input.source,
      translated: input.translated,
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
      insertedAtMs: input.nowMs,
      charCount,
      claimed: false,
      claimedAtMs: null,
      meta: structuredClone(input.meta),
    });
    this.charTotal += charCount;
    return resultId;
  }

  /** Read-only lookup that ignores claim state. */
  peekAt(resultId: string, ownerSessionId: string, nowMs: number): CachedTranslation | undefined {
    this.pruneExpired(nowMs);
    const entry = this.entries.find(candidate =>
      candidate.resultId === resultId && candidate.ownerSessionId === ownerSessionId);
    return entry === undefined ? undefined : cloneEntry(entry);
  }

  claimAt(resultId: string, ownerSessionId: string, nowMs: number): ClaimOutcome {
    this.pruneExpired(nowMs);
    const entry = this.entries.find(candidate =>
      candidate.resultId === resultId && candidate.ownerSessionId === ownerSessionId);
    if (entry === undefined) return { kind: 'not_found' };
    if (entry.claimed) {
      const stale = entry.claimedAtMs === null || nowMs - entry.claimedAtMs >= STALE_CLAIM_REDEEM_AFTER_MS;
      if (!stale) return { kind: 'busy' };
    }
    entry.claimed = true;
    entry.claimedAtMs = nowMs;
    return { kind: 'claimed', entry: cloneEntry(entry) };
  }

  releaseClaim(resultId: string, ownerSessionId: string): boolean {
    const entry = this.entries.find(candidate =>
      candidate.resultId === resultId && candidate.ownerSessionId === ownerSessionId);
    if (entry === undefined) return false;
    const wasClaimed = entry.claimed;
    entry.claimed = false;
    entry.claimedAtMs = null;
    return wasClaimed;
  }

  remove(resultId: string, ownerSessionId: string): boolean {
    const index = this.entries.findIndex(candidate =>
      candidate.resultId === resultId && candidate.ownerSessionId === ownerSessionId);
    if (index < 0) return false;
    const [entry] = this.entries.splice(index, 1);
    if (entry === undefined) return false;
    this.charTotal = Math.max(0, this.charTotal - entry.charCount);
    return true;
  }
}

let translationResults = new TranslationResultCache(
  TRANSLATION_RESULT_CACHE_MAX_ENTRIES,
  TRANSLATION_RESULT_CACHE_MAX_CHARS,
  TRANSLATION_RESULT_TTL_MS,
);

export function withTranslationCache<T>(operation: (cache: TranslationResultCache) => T): T {
  return operation(translationResults);
}

/** Replace the process-wide cache (Rust test assigns the global `LazyLock`). */
export function replaceTranslationResultCache(cache: TranslationResultCache): void {
  translationResults = cache;
}