import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';
import { ragSearch, resolveMultimodalQuery } from '../src/search.ts';
import { VECTOR_UNAVAILABLE } from '../src/index-admin.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); }, 120_000);

const invoke = <T = unknown>(name: string, args: Record<string, unknown> = {}) =>
  vfs.host.invoke(name, args) as Promise<T>;

describe('vfs/handlers.rs search and Lance commands', { timeout: 120_000 }, () => {
  it('rag_search_accepts_legacy_false_cross_dimension_flag', async () => {
    const calls: unknown[] = [];
    const index = vfs.host.ctx.vfsIndex;
    const result = await ragSearch({ vectorAvailable: false, conn: () => vfs.storage.database('vfs'), log: vfs.host.ctx.logger,
      index: { ...index, fullSearch: { ...index.fullSearch!, async searchWithResourceInfo(query, params, rerank) {
        calls.push({ query, params, rerank }); return [];
      } } } }, { query: 'profile aware retrieval', enableCrossDimension: false, topK: 7 });
    expect(result.results).toEqual([]);
    expect(calls).toEqual([{ query: 'profile aware retrieval', params: { query: 'profile aware retrieval',
      folderIds: null, resourceIds: null, resourceTypes: null, modality: 'text', topK: 7 }, rerank: true }]);
  });
  it('vfs_search rejects blank queries and returns FTS rows', async () => {
    await expect(invoke('vfs_search', { params: { query: '   ' } }))
      .rejects.toBe('Query cannot be empty');
    expect(await invoke('vfs_search', { params: { query: '函数' } })).toEqual([]);
  });

  it('vfs_get_lance_stats and vfs_optimize_lance delegate to the Lance store', async () => {
    // 测试宿主未安装 F7 lance@1，L12 使用 VfsLanceDisabled：统计为空、优化为 0。
    expect(await invoke('vfs_get_lance_stats')).toEqual([]);
    expect(await invoke('vfs_get_lance_stats', { modality: 'multimodal' })).toEqual([]);
    expect(await invoke('vfs_optimize_lance')).toBe(0);
  });

  it('vfs_diagnose_lance_schema uses the published L12 capability', async () => {
    expect(await invoke('vfs_diagnose_lance_schema')).toEqual([]);
  });

  it('vfs_rag_search validates query and modality', async () => {
    await expect(invoke('vfs_rag_search', { input: { query: '  ' } }))
      .rejects.toBe('查询文本不能为空');
    await expect(invoke('vfs_rag_search', { input: { query: '函数', modality: 'image' } }))
      .rejects.toBe("modality 仅支持 'text' 或 'multimodal'");
  });

  it('vfs_inspect_retrieval_capabilities returns a capability snapshot', async () => {
    const snapshot = await invoke<Record<string, unknown>>('vfs_inspect_retrieval_capabilities');
    expect(snapshot).toHaveProperty('textEmbedding');
    expect(snapshot).toHaveProperty('multimodalEmbedding');
  });
});

describe('RF-W04-rag-search-rerank-flag', { timeout: 120_000 }, () => {
  const query = 'photosynthesis chlorophyll';
  const reranks: Array<{ query: string; ids: string[]; model: string }> = [];
  let rerankFails = false;

  async function rerankHost(): Promise<VfsHost> {
    await vfs.dispose();
    reranks.length = 0;
    rerankFails = false;
    vfs = await createVfsHost({ provide: {
      llm: { getModelAssignments: async () => ({ reranker_model_config_id: 'rr-model' }) },
      llmReranker: { async callRerankerApi(q: string, chunks: Array<{ chunk: { id: string } }>, model: string) {
        reranks.push({ query: q, ids: chunks.map(c => c.chunk.id), model });
        if (rerankFails) throw new Error('HTTP 503');
        return [...chunks].reverse().map((c, i) => ({ ...c, score: i === 0 ? 0.9 : 0.45 }));
      } },
    } });
    const db = vfs.storage.database('vfs');
    for (const [id, text] of [['res_rr_a', 'photosynthesis chlorophyll light'], ['res_rr_b', 'photosynthesis notes']] as const) {
      db.run(`INSERT INTO resources (id,hash,type,storage_mode,data,ref_count,created_at,updated_at,index_state,mm_index_state)
        VALUES (?1,?2,'note','inline',?3,0,1,1,'indexed','indexed')`, [id, `hash_${id}`, text]);
      db.run(`INSERT INTO vfs_index_units (id,resource_id,unit_index,text_content,text_required,mm_required,text_state,mm_state,created_at,updated_at)
        VALUES (?1,?2,0,?3,1,0,'indexed','disabled',1,1)`, [`unit_${id}`, id, text]);
    }
    // Seeded by the VFS init migration (V20260130__init.sql:684); no UI ever rewrites it.
    expect(db.pluck("SELECT value FROM vfs_indexing_config WHERE key = 'search.enable_reranking'")).toBe('false');
    return vfs;
  }

  const rag = (enableReranking: boolean) => vfs.host.invoke('vfs_rag_search',
    { input: { query, topK: 5, enableReranking } }) as Promise<{ results: Array<{ resourceId: string; score: number }> }>;

  it('RF-W04-rag-search-rerank-flag: enableReranking reranks without the stored search.enable_reranking switch', async () => {
    await rerankHost();
    const unranked = (await rag(false)).results;
    expect(unranked.map(r => r.resourceId)).toEqual(['res_rr_a', 'res_rr_b']);
    expect(reranks).toEqual([]);
    // Rust indexing.rs:5249-5251 also requires search.enable_reranking, so this request kept the RRF
    // order even though the caller asked for reranking.
    const ranked = (await rag(true)).results;
    expect(reranks).toEqual([{ query, ids: ['unit:unit_res_rr_a', 'unit:unit_res_rr_b'], model: 'rr-model' }]);
    expect(ranked.map(r => [r.resourceId, r.score])).toEqual([['res_rr_b', 0.9], ['res_rr_a', 0.45]]);
  });

  it('RF-W04-rag-search-rerank-flag: a failing reranker keeps the RRF order', async () => {
    await rerankHost();
    const unranked = (await rag(false)).results;
    rerankFails = true;
    const fallback = (await rag(true)).results;
    expect(reranks).toHaveLength(1);
    expect(fallback).toEqual(unranked);
  });
});

describe('vfs/handlers.rs multimodal commands', { timeout: 120_000 }, () => {
  it('multimodal_search_dto_accepts_legacy_query', () => {
    const input = { query: 'legacy text', topK: 7 };
    expect(resolveMultimodalQuery(input)).toMatchObject({ text: 'legacy text', image: null });
    expect(input.topK).toBe(7);
  });
  it('multimodal_search_dto_accepts_image_and_mixed_camel_case', () => {
    expect(resolveMultimodalQuery({ queryImageBase64: 'image-bytes', queryImageMediaType: 'image/jpeg', queryMode: 'image' }))
      .toMatchObject({ text: null, image: 'image-bytes', mediaType: 'image/jpeg' });
    expect(resolveMultimodalQuery({ query: 'legacy field remains accepted', queryText: 'preferred text',
      queryImageBase64: 'image-bytes', queryImageMediaType: 'image/webp', queryMode: 'mixed' }))
      .toMatchObject({ text: 'preferred text', image: 'image-bytes', mediaType: 'image/webp' });
  });
  it('multimodal_search_dto_rejects_mode_payload_mismatch', () => {
    expect(() => resolveMultimodalQuery({ queryText: 'text', queryMode: 'mixed' })).toThrow('queryImageBase64');
  });
  it('explicit text or image mode excludes the other payload after trimming', () => {
    expect(resolveMultimodalQuery({ queryText: '  text  ', queryImageBase64: ' bytes ', queryMode: 'text' }))
      .toMatchObject({ text: 'text', image: null });
    expect(resolveMultimodalQuery({ queryText: 'text', queryImageBase64: ' bytes ', queryMode: 'image' }))
      .toMatchObject({ text: null, image: 'bytes' });
  });
  it('vfs_multimodal_stats and vfs_multimodal_delete use the L12 service', async () => {
    expect(await invoke('vfs_multimodal_stats')).toEqual({ totalRecords: 0, dimensions: [] });
    expect(await invoke('vfs_multimodal_delete', { resourceId: 'res_missing' })).toBeNull();
  });

  it('vfs_multimodal_search resolves query modes like Rust', async () => {
    await expect(invoke('vfs_multimodal_search', { params: {} }))
      .rejects.toBe('text search requires queryText or query');
    await expect(invoke('vfs_multimodal_search', { params: { queryMode: 'image' } }))
      .rejects.toBe('image search requires queryImageBase64');
    await expect(invoke('vfs_multimodal_search', {
      params: { queryText: '函数', queryMode: 'mixed' },
    })).rejects.toBe('mixed search requires queryImageBase64');
    await expect(invoke('vfs_multimodal_search', {
      params: { queryImageBase64: 'AAAA', queryMode: 'mixed' },
    })).rejects.toBe('mixed search requires queryText or query');
  });

  it('vfs_multimodal_search returns flattened hits from the retrieval service', async () => {
    const results = await invoke<unknown[]>('vfs_multimodal_search', {
      params: { queryText: '函数', topK: 3 },
    });
    expect(Array.isArray(results)).toBe(true);
  });

  it('vfs_multimodal_search_detailed returns the unified response envelope', async () => {
    const response = await invoke<Record<string, unknown>>('vfs_multimodal_search_detailed', {
      params: { queryText: '函数', topK: 3 },
    });
    expect(response).toHaveProperty('capabilitySnapshot');
    expect(response).toHaveProperty('plan');
    expect(response).toHaveProperty('result');
  });

  it('vfs_multimodal_index rejects before indexing when vector support is absent', async () => {
    await expect(invoke('vfs_multimodal_index', {
      params: {
        resourceId: 'res_missing', resourceType: 'textbook', folderId: null,
        pages: [{ pageIndex: 0, textContent: 'x' }],
      },
    })).rejects.toBe(VECTOR_UNAVAILABLE);
    await expect(invoke('vfs_multimodal_index_resource', {
      sourceType: 'textbook', sourceId: 'tb_missing', folderId: null,
    })).rejects.toBe(VECTOR_UNAVAILABLE);
  });
});
