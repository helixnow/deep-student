import type { UnifiedRetrievalResponse } from '../../vfs-index/api.ts';
import type { HpiasRetrievalHit } from '../src/hpias-research.ts';

/** External retrieval response fixture; orchestration and event projection remain production code. */
export function retrievalResponse(hits: HpiasRetrievalHit[]): UnifiedRetrievalResponse {
  return {
    capabilitySnapshot: {} as UnifiedRetrievalResponse['capabilitySnapshot'],
    plan: { queryModality: 'text', topK: 8, routes: [], imageFallbackChain: [] },
    queryDerivations: [],
    result: { failures: [], hits: hits.map((hit, index) => ({
      hit: { identity: { resourceId: `res-${index}`, chunkIndex: 0, pageIndex: null, timeRange: null },
        embeddingId: '', text: hit.text, title: hit.title ?? null, resourceType: 'note', sourceId: hit.sourceId ?? null,
        folderId: null, blobHash: null, imageUrl: null, rawScore: null, metadata: {} },
      rrfScore: 1, provenance: [],
    })) },
  };
}
