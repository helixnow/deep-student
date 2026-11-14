/**
 * Memory search store — TS mirror of `MemoryService::{search,
 * search_with_rerank, search_unified_for_purpose, apply_time_decay,
 * trigger_immediate_index}`.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { MemorySearchResult } from '../api.ts';
import type { MemoryVfsDependencies } from '../repository/vfs.ts';
import {
  buildFolderPath, getFolderIdsRecursive, getNoteByResourceId, getNoteLocation, markIndexed,
  recordSearchHits,
} from '../repository/vfs.ts';
import type {
  RetrievalService, UnifiedRetrievalRequest, UnifiedRetrievalResponse, VfsIndexService,
} from '../../vfs-index/api.ts';
import type { MemoryConfig } from './config.ts';
import { f32 } from './f32.ts';
import { rerankShortCircuit } from './reranker.ts';
import {
  LOG_TARGET, TAG_ARCHIVED, TIME_DECAY_HALF_LIFE_DAYS, computeTagWeight, ctxGet, errorText,
  relativizeFolderPath,
} from './memory-utils.ts';

/** L12 cancellation-capable retrieval service (published entry point pending in main). */
interface CancellableRetrievalLike {
  search(request: UnifiedRetrievalRequest, signal: AbortSignal | null): Promise<UnifiedRetrievalResponse>;
}

function abortError(): Error {
  const error = new Error('memory search aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Rejects as soon as `signal` aborts. When the provider exposes the cancellable
 * entry point the same signal is passed down, so the owner can drop the actual
 * retrieval work; the race alone only stops the memory post-processing.
 */
function abortable<T>(operation: Promise<T>, signal: AbortSignal | null): Promise<T> {
  if (signal === null) return operation;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export interface SearchStoreHost {
  readonly hostContext: Context;
  readonly db: DatabaseHandle;
  readonly deps: MemoryVfsDependencies;
  readonly config: MemoryConfig;
  rootId(): string;
  isNoteInMemoryRoot(noteId: string, rootId: string): boolean;
  warn(message: string): void;
  warnOnce(key: string, message: string): void;
}

export class MemorySearchStore {
  private readonly host: SearchStoreHost;
  constructor(host: SearchStoreHost) { this.host = host; }

  /** Rust `MemoryService::search` (user retrieval purpose). */
  async search(query: string, topK: number,
    signal: AbortSignal | null = null): Promise<MemorySearchResult[]> {
    if (signal?.aborted) throw abortError();
    return this.searchForPurpose(query, topK, 'user_retrieval', signal);
  }

  /**
   * Rust `search_with_rerank`: the Host has no published reranker model API, so
   * `has_reranker_api()` is false and the deterministic short-circuit applies.
   */
  async searchWithRerank(query: string, topK: number,
    useQueryRewrite: boolean): Promise<MemorySearchResult[]> {
    if (this.host.config.isPrivacyMode()) {
      this.host.warn('[Memory] Privacy mode enabled, skipping search_with_rerank (no external API calls)');
      return [];
    }
    if (useQueryRewrite) {
      this.host.warnOnce('query-rewrite',
        '[Memory] Query rewrite skipped: L02 LLM completion API is not published, using the original query');
    }
    const results = await this.search(query, topK);
    const reranked = rerankShortCircuit(results, false) ?? results;
    return reranked.slice(0, topK);
  }

  /**
   * Rust `search_with_embedding_for_purpose`: a bare vector has no model/profile
   * fingerprint, so the embedding is deliberately ignored and the unified route
   * still selects lexical/vector spaces itself.
   */
  async searchWithEmbeddingForPurpose(query: string, _queryEmbedding: readonly number[],
    topK: number, purpose: 'user_retrieval' | 'internal_dedup'): Promise<MemorySearchResult[]> {
    return this.searchForPurpose(query, topK, purpose);
  }

  async searchWithEmbedding(query: string, queryEmbedding: readonly number[],
    topK: number): Promise<MemorySearchResult[]> {
    return this.searchWithEmbeddingForPurpose(query, queryEmbedding, topK, 'user_retrieval');
  }

  /** Rust `search_unified_for_purpose`: VFS lexical/vector routes, then memory post-processing. */
  async searchForPurpose(query: string, topK: number,
    purpose: 'user_retrieval' | 'internal_dedup',
    signal: AbortSignal | null = null): Promise<MemorySearchResult[]> {
    if (topK === 0) return [];
    if (signal?.aborted) throw abortError();
    if (this.host.config.isPrivacyMode()) {
      this.host.warn('[Memory] Privacy mode enabled, skipping unified retrieval');
      return [];
    }
    const rootId = this.host.rootId();
    const folderIds = getFolderIdsRecursive(this.host.db, rootId);
    if (folderIds.length === 0) return [];
    const rootPath = buildFolderPath(this.host.db, rootId);
    const retrieval = ctxGet(this.host.hostContext, 'retrieval') as RetrievalService | undefined;
    if (retrieval === undefined) throw new Error('retrieval is not available');
    const cancellable = ctxGet(this.host.hostContext, 'retrievalCancellable') as
      CancellableRetrievalLike | undefined;
    const retrievalK = Math.min(Number.MAX_SAFE_INTEGER, topK * 3);
    const request: UnifiedRetrievalRequest = {
      queryText: query, queryImageBase64: null, queryImageMediaType: null,
      queryModality: 'text', topK: retrievalK, folderIds, resourceIds: null,
      resourceTypes: ['note'],
    };
    const response = cancellable === undefined
      ? await abortable(retrieval.retrieve(request), signal)
      : await abortable(Promise.resolve().then(() => cancellable.search(request, signal)), signal);
    if (signal?.aborted) throw abortError();
    const bestRrf = response.result.hits[0]?.rrfScore ?? 0;
    const results: MemorySearchResult[] = [];
    const seen = new Set<string>();
    for (const fused of response.result.hits) {
      const note = getNoteByResourceId(this.host.db, fused.hit.identity.resourceId);
      if (note === undefined) continue;
      if (!this.host.isNoteInMemoryRoot(note.id, rootId)) continue;
      // Archived memories have their vectors purged asynchronously; filter any
      // stale hit so it cannot refresh `_last_hit` while still archived.
      if (note.tags.includes(TAG_ARCHIVED)) continue;
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      const folderPath = relativizeFolderPath(
        getNoteLocation(this.host.db, note.id)?.folderPath ?? '', rootPath);
      const retrievalScore = Number.isFinite(fused.rrfScore) && Number.isFinite(bestRrf)
        && bestRrf > 0 ? Math.min(1, Math.max(0, fused.rrfScore / bestRrf)) : 0;
      results.push({
        noteId: note.id, noteTitle: note.title, folderPath,
        chunkText: fused.hit.text,
        score: f32(retrievalScore * computeTagWeight(note.tags)),
        updatedAt: note.updatedAt,
      });
      // Keep the full retrieval candidate set: time decay must run before truncation.
      if (results.length >= retrievalK) break;
    }
    this.applyTimeDecay(results);
    const truncated = results.slice(0, topK);
    if (purpose === 'user_retrieval' && truncated.length > 0) {
      try { recordSearchHits(this.host.deps, this.host.db, truncated.map(result => result.noteId), Date.now()); }
      catch (error) { this.host.warn(`[Memory] Failed to record search hits: ${errorText(error)}`); }
    }
    return truncated;
  }

  /** Rust `apply_time_decay` (RFC3339 or numeric epoch strings). */
  private applyTimeDecay(results: MemorySearchResult[]): void {
    const nowMs = Date.now();
    for (const result of results) {
      let ageDays = 0;
      if (result.updatedAt !== null && result.updatedAt !== undefined) {
        const parsed = Date.parse(result.updatedAt);
        if (Number.isFinite(parsed)) {
          ageDays = Math.max(0, nowMs - parsed) / 86_400_000;
        } else {
          const numeric = Number(result.updatedAt);
          ageDays = Number.isFinite(numeric)
            ? Math.max(0, (nowMs - numeric) / (1000 * 86_400)) : 0;
        }
      }
      result.score = f32(result.score * Math.pow(0.5, ageDays / TIME_DECAY_HALF_LIFE_DAYS));
    }
    results.sort((a, b) => b.score - a.score);
  }

  /** Rust handlers' `trigger_immediate_index` (fire-and-forget, failures only warn). */
  async triggerImmediateIndex(resourceId: string): Promise<void> {
    const index = ctxGet(this.host.hostContext, 'vfsIndex') as VfsIndexService | undefined;
    if (index === undefined) {
      this.host.warn(`[Memory] vfsIndex is not available; immediate index for ${resourceId} skipped`);
      return;
    }
    try {
      const [chunkCount, dim] = await index.indexing.indexResource(resourceId, null, null);
      try { markIndexed(this.host.deps, this.host.db, resourceId, `mem_handler_${Date.now()}`); }
      catch (error) {
        this.host.warn(`[Memory] Failed to mark indexed after immediate indexing: ${errorText(error)}`);
      }
      this.host.hostContext.log.logger(LOG_TARGET).info(
        `[Memory] Immediate index completed for resource ${resourceId} (${chunkCount} chunks, dim=${dim})`);
    } catch (error) {
      this.host.warn(`[Memory] Immediate index failed for resource ${resourceId} (will retry in next batch): ${errorText(error)}`);
    }
  }
}
