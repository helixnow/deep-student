import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import {
  vfsInspectRetrievalCapabilities,
  vfsMultimodalSearch,
  vfsMultimodalSearchDetailed,
} from '../vfsRagApi';

describe('vfsMultimodalSearch DTO', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue([]);
  });

  it('keeps legacy query while adding normalized text fields', async () => {
    await vfsMultimodalSearch({
      query: 'legacy query',
      topK: 3,
      resourceIds: ['resource-1'],
    });

    expect(invoke).toHaveBeenCalledWith('vfs_multimodal_search', {
      params: expect.objectContaining({
        query: 'legacy query',
        queryText: 'legacy query',
        queryMode: 'text',
        topK: 3,
        resourceIds: ['resource-1'],
      }),
    });
  });

  it('normalizes an image-only query without inventing text', async () => {
    await vfsMultimodalSearch({ queryImageBase64: 'image-data' });

    expect(invoke).toHaveBeenCalledWith('vfs_multimodal_search', {
      params: expect.objectContaining({
        query: '',
        queryText: '',
        queryImageBase64: 'image-data',
        queryImageMediaType: 'image/png',
        queryMode: 'image',
      }),
    });
  });

  it('rejects inconsistent or empty query payloads before IPC', async () => {
    await expect(vfsMultimodalSearch({})).rejects.toThrow('requires query text');
    await expect(vfsMultimodalSearch({ queryText: 'text', queryMode: 'mixed' }))
      .rejects.toThrow('requires queryImageBase64');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('exposes detailed route diagnostics and read-only capability inspection', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      capabilitySnapshot: {},
      plan: {},
      result: { hits: [], failures: [] },
      queryDerivations: [],
    });

    await vfsMultimodalSearchDetailed({ queryText: 'diagnose routes' });
    expect(invoke).toHaveBeenLastCalledWith('vfs_multimodal_search_detailed', {
      params: expect.objectContaining({
        query: 'diagnose routes',
        queryText: 'diagnose routes',
        queryMode: 'text',
      }),
    });

    vi.mocked(invoke).mockResolvedValueOnce({ multimodalEmbedding: {} });
    await vfsInspectRetrievalCapabilities();
    expect(invoke).toHaveBeenLastCalledWith('vfs_inspect_retrieval_capabilities');
  });
});
