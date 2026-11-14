import { expect, it, vi } from 'vitest';
import type { BackendEvent } from '../../chat/api.ts';
import { retrievalHost, response, hit } from './retrieval-host.ts';
import { vlRerankSources, type RetrievalRerankerPort } from '../src/tools/retrieval-rerank.ts';

const call = (name: string, args: unknown = {}) => ({ id: 'call_retrieval', name, arguments: args });
it('expands session scope and excludes memory resources even when the memory route is disabled', async () => {
  let memoryRoot: string | null = null, memoryResource = '';
  const h = await retrievalHost({ search: async () => response([hit(memoryResource, .99), hit('res_doc', .9)]),
    memory: { getRootFolderId: () => memoryRoot, async compress() { throw new Error('Memory route must be disabled'); } } });
  try {
    const folder = await h.host.invoke('dstu_folder_create', { title: 'Course' }) as { id: string };
    const child = await h.host.invoke('dstu_folder_create', { title: 'Chapter', parentId: folder.id }) as { id: string };
    // Session scope is read through the chat owner's real chatRetrievalScope port (session_scope.rs).
    h.host.ctx.chatSession.createSession({ id: 'sess_retrieval', mode: 'chat', titleLocked: false, persistStatus: 'active',
      createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' });
    await h.host.invoke('chat_v2_set_rag_scope', { sessionId: 'sess_retrieval', folderIds: [folder.id] });
    memoryRoot = folder.id;
    const db = h.host.ctx.vfsDatabase.getConnSafe();
    const note = h.host.ctx.notes.repository.createNote({ title: 'Memory', content: 'remember', tags: [] }, db);
    memoryResource = note.resourceId;
    await h.host.invoke('dstu_folder_add_item', { folderId: child.id, itemType: 'note', itemId: note.id });
    const ctx = h.context(); ctx.memory_enabled = false;
    const result = await h.executor.execute(call('builtin-rag_search', { query: '  topic  ', folder_ids: ['fld_outside'], enable_reranking: false }), ctx);
    expect(result.success).toBe(true);
    expect(h.search).toHaveBeenCalledWith(expect.objectContaining({ queryText: 'topic', folderIds: [folder.id, child.id].sort() }), null);
    const output = result.output as { sources: Array<{ resourceId: string }> };
    expect(output.sources.map(source => source.resourceId)).toEqual(['res_doc']);
    expect(h.memorySearch).not.toHaveBeenCalled();
    const events = h.host.eventsNamed('chat_v2_event_sess_retrieval') as BackendEvent[];
    expect(events.map(event => [event.type, event.phase])).toEqual([['rag', 'start'], ['rag', 'end']]);
    expect(events[1]!.result).toMatchObject({ sources: output.sources, queryMode: 'text' });
  } finally { await h.dispose(); }
});
it('routes multimodal_search only to multimodal retrieval and preserves page-image source fields', async () => {
  const page = hit('res_page'); page.hit.blobHash = 'page_hash'; page.hit.identity.pageIndex = 2;
  page.hit.imageUrl = 'asset://page';
  const h = await retrievalHost({ searchMultimodal: async () => response([page]) });
  try {
    const result = await h.executor.execute(call('builtin-multimodal_search', { queryImageBase64: ' image ', queryMode: 'IMAGE', topK: 500 }), h.context());
    expect(result.success).toBe(true); expect(h.search).not.toHaveBeenCalled();
    expect(h.searchMultimodal).toHaveBeenCalledWith(expect.objectContaining({ queryModality: 'image', queryImageBase64: 'image', topK: 100 }), null);
    expect(result.output).toMatchObject({ sources: [expect.objectContaining({ blob_hash: 'page_hash', pageIndex: 2,
      citationTag: '[图片-1]', imageCitation: '![Page 3](asset://page)' })], rerank: { requested: true, applied: false } });
  } finally { await h.dispose(); }
});
it('applies take(top_k) before reranker index filtering and reports unusable results instead of changing ordering', async () => {
  const rerank = vi.fn(async () => [{ chunk: { id: 'invalid', document_id: '', chunk_index: 0, text: '', metadata: {} }, score: .9 },
    { chunk: { id: 'rerank-source-1', document_id: '', chunk_index: 1, text: '', metadata: {} }, score: .8 }]);
  const llm: RetrievalRerankerPort = {
    async getRerankerModelConfig() { return { id: 'rerank', enabled: true, isReranker: true, isMultimodal: false }; },
    async getVlRerankerModelConfig() { throw new Error('VL not configured'); }, callRerankerApi: rerank,
    async callMultimodalRerankerApi() { throw new Error('Unexpected VL rerank'); },
  };
  const h = await retrievalHost({ reranker: llm, search: async () => response([hit('res_first', .032), hit('res_second', .016)]) });
  try {
    const result = await h.executor.execute(call('rag_search', { query: 'q', top_k: 1 }), h.context());
    expect(result.success).toBe(true);
    expect(rerank).toHaveBeenCalledWith('q', [expect.objectContaining({ chunk: expect.objectContaining({ id: 'rerank-source-0', document_id: 'res_first' }) }),
      expect.objectContaining({ chunk: expect.objectContaining({ id: 'rerank-source-1' }) })], 'rerank');
    expect(result.output).toMatchObject({ rerank: { requested: true, applied: false },
      routeFailures: [{ routeId: 'rerank:text', error: 'text reranker returned no usable results' }],
      sources: [expect.objectContaining({ resourceId: 'res_first' })] });
  } finally { await h.dispose(); }
});
it('merges compressed memories into reserved slots and preserves stable reply-local citation identities', async () => {
  const memories = Array.from({ length: 4 }, (_, i) => ({ noteId: `note_mem_${i}`, noteTitle: `Memory ${i}`, folderPath: 'memory', chunkText: `Memory text ${i}`, score: .9 }));
  const h = await retrievalHost({ search: async () => response([hit('res_one'), hit('res_two'), hit('res_three')]), memorySearch: async () => memories,
    memory: { getRootFolderId: () => null, compress: async () => memories.map((row, i) => ({ ...row, noteId: i === 0 ? null : row.noteId,
      sourceNoteIds: i === 0 ? ['note_res_one'] : [] })) } });
  try {
    const first = await h.executor.execute(call('unified_search', { query: 'topic', top_k: 4, enable_reranking: false }), h.context());
    expect(first.success).toBe(true); expect(h.memorySearch).toHaveBeenCalledWith('topic', 3, null);
    const output = first.output as { count: number; sources: Record<string, unknown>[] };
    expect(output.count).toBe(4);
    expect(output.sources[0]).toMatchObject({ resourceId: 'res_two', citationTag: '[知识库-1]' });
    expect(output.sources[1]).toMatchObject({ noteId: null, sourceNoteIds: ['note_res_one'], citationTag: '[记忆-1]' });
    const second = await h.executor.execute(call('unified_search', { query: 'topic', top_k: 4, enable_reranking: false }), h.context());
    expect((second.output as typeof output).sources.map(s => s.citationTag)).toEqual(output.sources.map(s => s.citationTag));
  } finally { await h.dispose(); }
});
it('returns cancellation at the Rust retrieval await point without emitting end or persisting tool-call blocks', async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let providerCancelled = false;
  const h = await retrievalHost({ search: async (_request, signal) => { started(); return new Promise((resolve, reject) => {
    finish = resolve;
    signal?.addEventListener('abort', () => { providerCancelled = true; reject(new Error('Provider cancelled')); }, { once: true });
  }); } });
  try {
    const controller = new AbortController();
    const pending = h.executor.execute(call('rag_search', { query: 'q' }), h.context(controller.signal));
    await entered; controller.abort();
    const result = await pending;
    expect(result.success).toBe(false);
    expect(providerCancelled).toBe(true);
    expect(JSON.parse(result.error!).detail).toBe('Unified retrieval cancelled during execution');
    const events = h.host.eventsNamed('chat_v2_event_sess_retrieval') as BackendEvent[];
    expect(events.map(event => [event.type, event.phase])).toEqual([['rag', 'start'], ['rag', 'error']]);
    finish(response());
  } finally { await h.dispose(); }
});
it('web search uses the selected engine and emits the same numbered sources as its tool output', async () => {
  const h = await retrievalHost({ web: async () => ({ name: 'web_search', ok: true, citations: [
    { fileName: 'Web title', documentId: 'https://example.test', chunkText: 'web body', score: .75, chunkIndex: 0 },
  ] }) });
  try {
    h.host.ctx.settings.save('session.selected_search_engines', '  brave , google ');
    const result = await h.executor.execute(call('web_search', { query: '', top_k: 0 }), h.context());
    expect(result.success).toBe(true); expect(h.web).toHaveBeenCalledWith({ query: '', top_k: 0, engine: 'brave', site: null, time_range: null, start: null, force_engine: null }, expect.any(AbortSignal));
    const output = result.output as { sources: Record<string, unknown>[] };
    expect(output.sources[0]).toMatchObject({ citationTag: '[搜索-1]', typeIndex: 1, source_type: 'web_search', title: 'Web title' });
    const events = h.host.eventsNamed('chat_v2_event_sess_retrieval') as BackendEvent[];
    expect(events.map(e => [e.type, e.phase])).toEqual([['web_search', 'start'], ['web_search', 'end']]);
    expect(events[1]!.result).toMatchObject({ sources: output.sources });
  } finally { await h.dispose(); }
});

it('vlRerankSources loads candidate blobs asynchronously in order and honors AbortSignal', async () => {
  const h = await retrievalHost();
  try {
    const conn = h.host.ctx.vfsDatabase.getConnSafe();
    const blobsDir = h.host.ctx.vfsDatabase.blobsDir();
    const hashes: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const saved = h.host.ctx.vfsRepo.blobs.storeBlob(conn, blobsDir, Buffer.from(`img-${i}`), 'image/png');
      hashes.push(saved.hash);
    }
    let capturedDocs: Array<{ text?: string; image?: { data: string; media_type: string } }> = [];
    const reranker: RetrievalRerankerPort = {
      getRerankerModelConfig: async () => ({ id: 'r1', enabled: true, isReranker: true, isMultimodal: false }),
      getVlRerankerModelConfig: async () => ({ id: 'vl1', enabled: true, isReranker: true, isMultimodal: true }),
      callRerankerApi: async () => [],
      callMultimodalRerankerApi: async (_query, docs) => {
        capturedDocs = docs;
        return [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }];
      },
    };
    const candidates = [
      ...hashes.map((hash, i) => ({ title: `S${i}`, url: null, snippet: `snip-${i}`, score: 0.1 * i, metadata: { blobHash: hash } })),
      { title: 'Missing', url: null, snippet: 'fallback-only', score: 0.05, metadata: { blobHash: 'missing-hash' } },
    ];
    const outcome = await vlRerankSources('query', null, null, candidates, 2, reranker, h.host.ctx);
    expect(outcome.applied).toBe(true);
    expect(outcome.sources.map(s => s.title)).toEqual(['S2', 'S0']);
    expect(capturedDocs).toHaveLength(5);
    expect(capturedDocs[0]!.image?.data).toBe(Buffer.from('img-0').toString('base64'));
    expect(capturedDocs[3]!.image?.data).toBe(Buffer.from('img-3').toString('base64'));
    expect(capturedDocs[4]).toEqual({ text: 'fallback-only' });

    const controller = new AbortController();
    controller.abort();
    await expect(vlRerankSources('query', null, null, candidates, 2, reranker, h.host.ctx, controller.signal))
      .rejects.toThrow('VL rerank cancelled');
  } finally { await h.dispose(); }
});
