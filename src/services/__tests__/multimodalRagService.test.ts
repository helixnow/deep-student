import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  vfsInspectRetrievalCapabilities,
  vfsMultimodalSearch,
  vfsMultimodalSearchDetailed,
  vfsMultimodalStats,
} = vi.hoisted(() => ({
  vfsInspectRetrievalCapabilities: vi.fn(),
  vfsMultimodalSearch: vi.fn(),
  vfsMultimodalSearchDetailed: vi.fn(),
  vfsMultimodalStats: vi.fn(),
}));

vi.mock('@/api/vfsRagApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/vfsRagApi')>();
  return {
    ...actual,
    vfsMultimodalIndex: vi.fn(),
    vfsInspectRetrievalCapabilities,
    vfsMultimodalSearch,
    vfsMultimodalSearchDetailed,
    vfsMultimodalStats,
    vfsMultimodalDelete: vi.fn(),
    vfsMultimodalIndexResource: vi.fn(),
  };
});

import {
  getCapabilityStatus,
  retrieve,
  searchByImage,
  searchByTextAndImage,
} from '../multimodalRagService';

describe('multimodalRagService', () => {
  const capabilitySnapshot = (multimodalEmbedding: Record<string, unknown>) => ({
    textEmbedding: {},
    multimodalEmbedding: {
      configured: false,
      healthy: false,
      circuitOpen: false,
      protocolCompatible: true,
      indexCompatible: true,
      ...multimodalEmbedding,
    },
    textModel: {},
    multimodalModel: {},
    ocr: {},
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vfsMultimodalSearch.mockResolvedValue([]);
    vfsMultimodalStats.mockResolvedValue({ totalRecords: 0, dimensions: [] });
  });

  it('reports an unconfigured route without probing storage', async () => {
    vfsInspectRetrievalCapabilities.mockResolvedValue(capabilitySnapshot({}));

    await expect(getCapabilityStatus()).resolves.toMatchObject({
      probed: true,
      configured: false,
      available: false,
      reason: 'not_configured',
    });
    expect(vfsMultimodalStats).not.toHaveBeenCalled();
  });

  it('distinguishes a failed probe from an unavailable route and does not cache it', async () => {
    vfsInspectRetrievalCapabilities
      .mockRejectedValueOnce(new Error('temporary capability error'))
      .mockResolvedValueOnce(capabilitySnapshot({
        configured: true,
        healthy: true,
      }));

    // IPC 失败时不得伪装成"已配置但不可用"
    await expect(getCapabilityStatus()).resolves.toMatchObject({
      probed: false,
      configured: false,
      available: false,
      reason: 'probe_failed',
      error: 'temporary capability error',
    });
    await expect(getCapabilityStatus()).resolves.toMatchObject({
      probed: true,
      configured: true,
      available: true,
      reason: 'ready',
    });
    expect(vfsInspectRetrievalCapabilities).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an incompatible profile', { indexCompatible: false, reason: 'fingerprint mismatch' }],
    ['an open profile circuit', { circuitOpen: true, reason: 'profile circuit open' }],
  ])('reports %s as configured but unavailable', async (_label, routeState) => {
    vfsInspectRetrievalCapabilities.mockResolvedValue(capabilitySnapshot({
      configured: true,
      healthy: true,
      ...routeState,
    }));

    await expect(getCapabilityStatus()).resolves.toMatchObject({
      configured: true,
      available: false,
      reason: 'unavailable',
      error: routeState.reason,
    });
  });

  it('routes legacy text retrieval through the VFS DTO and maps results', async () => {
    vfsMultimodalSearch.mockResolvedValue([{
      embeddingId: 'emb-1',
      resourceId: 'res-1',
      resourceType: 'image',
      pageIndex: 2,
      textContent: 'diagram',
      blobHash: 'blob-1',
      folderId: 'folder-1',
      score: 0.9,
      retrievalProvenance: [],
    }]);

    await expect(retrieve('vector query', undefined, undefined, { topK: 4 }))
      .resolves.toEqual([{
        source_type: 'image',
        // 扁平路线后端不携带业务 sourceId：source_id 回退为 resource_id
        source_id: 'res-1',
        resource_id: 'res-1',
        embedding_id: 'emb-1',
        page_index: 2,
        text_content: 'diagram',
        blob_hash: 'blob-1',
        folder_id: 'folder-1',
        score: 0.9,
        source: 'multimodal_page',
        retrieval_provenance: [],
      }]);
    expect(vfsMultimodalSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: 'vector query',
      queryText: 'vector query',
      queryMode: 'text',
      topK: 4,
    }));
  });

  it('derives text_chunk source from provenance and drops malformed entries', async () => {
    const textRoute = {
      routeId: 'route-te',
      routeKind: 'text_embedding',
      modality: 'text',
      rawRank: 1,
      routeWeight: 1,
      rrfContribution: 0.5,
    };
    vfsMultimodalSearch.mockResolvedValue([{
      embeddingId: 'emb-2',
      resourceId: 'res-2',
      resourceType: 'textbook',
      pageIndex: 0,
      score: 0.5,
      // 后端为 serde_json::Value：混入非法元素时应被运行时守卫丢弃
      retrievalProvenance: [textRoute, { bogus: true }, 'garbage'],
    }]);

    const [mapped] = await retrieve('query');
    expect(mapped.source).toBe('text_chunk');
    expect(mapped.retrieval_provenance).toEqual([textRoute]);
  });

  it('treats non-array provenance as an empty list', async () => {
    vfsMultimodalSearch.mockResolvedValue([{
      embeddingId: 'emb-3',
      resourceId: 'res-3',
      resourceType: 'exam',
      pageIndex: 1,
      score: 0.4,
      retrievalProvenance: { unexpected: 'shape' },
    }]);

    const [mapped] = await retrieve('query');
    expect(mapped.retrieval_provenance).toEqual([]);
    expect(mapped.source).toBe('multimodal_page');
  });

  it('preserves image-only and mixed query payloads', async () => {
    await searchByImage('base64-image', 'image/jpeg');
    expect(vfsMultimodalSearch).toHaveBeenLastCalledWith(expect.objectContaining({
      query: '',
      queryImageBase64: 'base64-image',
      queryImageMediaType: 'image/jpeg',
      queryMode: 'image',
    }));

    await searchByTextAndImage('what is shown', 'base64-image', 'image/webp');
    expect(vfsMultimodalSearch).toHaveBeenLastCalledWith(expect.objectContaining({
      query: 'what is shown',
      queryText: 'what is shown',
      queryImageBase64: 'base64-image',
      queryImageMediaType: 'image/webp',
      queryMode: 'mixed',
    }));
  });
});
