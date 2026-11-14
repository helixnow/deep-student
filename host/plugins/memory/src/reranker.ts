/**
 * Memory reranker early-return logic — TS mirror of
 * `dstu-memory/src/memory/reranker.rs`.
 *
 * The API rerank call needs an LLM reranker model that the Host does not yet
 * publish; only the deterministic short-circuit branch is portable.
 */
export interface RerankResult {
  noteId: string;
  noteTitle: string;
  folderPath: string;
  chunkText: string;
  score: number;
  updatedAt?: string | null;
}

/**
 * Rust `MemoryReranker::rerank` flat branch: empty results or no reranker API
 * pass through unchanged. Returns `null` when the API path would be required.
 */
export function rerankShortCircuit(results: readonly RerankResult[],
  hasApi: boolean): RerankResult[] | null {
  if (results.length === 0 || !hasApi) return [...results];
  return null;
}
