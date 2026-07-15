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

vi.mock('@/api/vfsRagApi', () => ({
  vfsMultimodalIndex: vi.fn(),
  vfsInspectRetrievalCapabilities,
  vfsMultimodalSearch,
  vfsMultimodalSearchDetailed,
  vfsMultimodalStats,
  vfsMultimodalDelete: vi.fn(),
  vfsMultimodalIndexResource: vi.fn(),
}));

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

    await expect(getCapabilityStatus()).resolves.toEqual({
      configured: false,
      available: false,
      reason: 'not_configured',
    });
    expect(vfsMultimodalStats).not.toHaveBeenCalled();
  });

  it('does not cache a transient unavailable result', async () => {
    vfsInspectRetrievalCapabilities
      .mockRejectedValueOnce(new Error('temporary capability error'))
      .mockResolvedValueOnce(capabilitySnapshot({
        configured: true,
        healthy: true,
      }));

    await expect(getCapabilityStatus()).resolves.toMatchObject({
      configured: true,
      available: false,
      reason: 'unavailable',
      error: 'temporary capability error',
    });
    await expect(getCapabilityStatus()).resolves.toMatchObject({
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
      score: 0.9,
      retrievalProvenance: [],
    }]);

    await expect(retrieve('vector query', undefined, undefined, { final_top_k: 4 }))
      .resolves.toEqual([{
        source_type: 'image',
        source_id: 'res-1',
        page_index: 2,
        text_content: 'diagram',
        blob_hash: 'blob-1',
        score: 0.9,
        source: 'multimodal_page',
      }]);
    expect(vfsMultimodalSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: 'vector query',
      queryText: 'vector query',
      queryMode: 'text',
      topK: 4,
    }));
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
