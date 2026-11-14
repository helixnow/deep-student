/**
 * pipeline/retrieval.rs — text truncation and RAG-source mapping helpers.
 */
import type { SourceInfo } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { RETRIEVAL_MIN_SCORE, RETRIEVAL_RELATIVE_THRESHOLD } from './constants.ts';

/** Log surface matching retrieval.rs / helpers.rs debug and info sites. */
export interface RetrievalLog {
  info(message: string): void;
  debug(message: string): void;
}
let retrievalLogger: RetrievalLog = { info() {}, debug() {} };
export function configureRetrievalLogger(logger: RetrievalLog): void {
  retrievalLogger = logger;
}

/** retrieval.rs `execute_retrievals`: tool-based mode performs no pre-call work. */
export function executeRetrievals(sessionId: string): void {
  retrievalLogger.info('[ChatV2::pipeline] Tool-based retrieval mode: skipping pre-call'
    + ` retrievals for session=${sessionId}`);
}

/** `char`-wise truncation with an ellipsis, never splitting a code point. */
export function truncateText(text: string, maxLen: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxLen) return text;
  return `${characters.slice(0, maxLen).join('')}...`;
}

/** helpers.rs `impl From<RagSourceInfo> for SourceInfo`. */
export interface RagSourceInfo {
  document_id: string;
  file_name: string;
  chunk_text: string;
  score: number;
  chunk_index: number;
}

export function sourceInfoFromRagSource(rag: RagSourceInfo): SourceInfo {
  return {
    title: rag.file_name,
    snippet: rag.chunk_text,
    score: rag.score,
    metadata: {
      documentId: rag.document_id,
      chunkIndex: rag.chunk_index,
    },
  };
}

/** `tools/web_search.rs::SearchInput` (camelCase wire shape). */
export interface SearchInput {
  query: string;
  topK: number;
  engine?: string | null;
  site?: string | null;
  timeRange?: string | null;
  start?: number | null;
  forceEngine?: boolean | null;
}


/**
 * helpers.rs `filter_retrieval_results`: absolute/relative threshold, stable
 * descending sort, top-1 fallback when everything is filtered out, then cap.
 * Scores are `f32` in Rust, so every comparison goes through `Math.fround`.
 */
export function filterRetrievalResults(sources: readonly SourceInfo[],
  minScore = RETRIEVAL_MIN_SCORE, relativeThreshold = RETRIEVAL_RELATIVE_THRESHOLD,
  maxResults = Number.MAX_SAFE_INTEGER): SourceInfo[] {
  if (sources.length === 0) return [];
  const f32Score = (source: SourceInfo): number => Math.fround(source.score ?? 0);
  let maxScore = 0;
  for (const source of sources) {
    if (source.score !== undefined && source.score !== null) {
      maxScore = Math.max(maxScore, f32Score(source));
    }
  }
  const dynamicThreshold = Math.max(Math.fround(minScore),
    Math.fround(Math.fround(maxScore) * Math.fround(relativeThreshold)));

  const beforeCount = sources.length;
  const sortedAll = [...sources].sort((a, b) => f32Score(b) - f32Score(a));
  const filtered = sources
    .filter(source => f32Score(source) >= dynamicThreshold)
    .sort((a, b) => f32Score(b) - f32Score(a));
  // All filtered out: keep top1 so a non-empty recall never becomes empty context.
  if (filtered.length === 0 && sortedAll.length > 0) filtered.push(sortedAll[0]!);
  filtered.length = Math.min(filtered.length, Math.max(0, Math.trunc(maxResults)));

  if (beforeCount !== filtered.length) {
    retrievalLogger.debug(`[ChatV2::pipeline] Filtered retrieval results: ${beforeCount}`
      + ` -> ${filtered.length} (threshold=${dynamicThreshold.toFixed(3)},`
      + ` max_score=${maxScore.toFixed(3)})`);
  }
  return filtered;
}
