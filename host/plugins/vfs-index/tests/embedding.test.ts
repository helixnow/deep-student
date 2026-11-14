import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { chunksToLanceRows, MODALITY_TEXT, VfsEmbeddingService } from '../src/embedding.ts';
import type { ChunkWithEmbedding, EmbeddingRuntime, TextChunk } from '../api.ts';

it('test_modality_support', () => { expect(MODALITY_TEXT).toBe('text'); });
it('test_chunks_to_lance_rows', () => {
  const chunks: ChunkWithEmbedding[] = [
    { chunk: { index: 0, text: 'Hello world', start_pos: 0, end_pos: 11, page_index: 0, source_id: 'test_source' }, embedding: [.1, .2, .3].map(Math.fround) },
    { chunk: { index: 1, text: 'Second chunk', start_pos: 12, end_pos: 24, page_index: 1, source_id: 'test_source' }, embedding: [.4, .5, .6].map(Math.fround) },
  ];
  const rows = chunksToLanceRows(chunks, 'resource_123', 'unit_123', 'note', 'folder_456', 'profile_123', 7);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.resource_id).toBe('resource_123'); expect(rows[0]!.unit_id).toBe('unit_123');
  expect(rows[0]!.index_profile_id).toBe('profile_123'); expect(rows[0]!.generation).toBe(7);
  expect(rows[0]!.resource_type).toBe('note'); expect(rows[0]!.folder_id).toBe('folder_456');
  expect(rows[0]!.chunk_index).toBe(0); expect(rows[0]!.text).toBe('Hello world');
  expect(rows[0]!.embedding).toEqual([.1, .2, .3].map(Math.fround));
  expect(rows[1]!.chunk_index).toBe(1); expect(rows[1]!.text).toBe('Second chunk');
  expect(rows.every(r => /^emb_[A-Za-z0-9_-]{10}$/.test(r.embedding_id))).toBe(true);
  expect(rows[0]!.created_at).toBe(rows[1]!.created_at);
  expect(JSON.parse(rows[0]!.metadata_json!)).toEqual({ page_index: 0, source_id: 'test_source' });
});
it('preserves batch retries, ordering, count checks and model reassignment rejection', async () => {
  let model = 'old';
  const call = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue([[.1, .2]]);
  const runtime: EmbeddingRuntime = {
    getEmbeddingModelConfig: async () => ({ id: 'model', model }),
    modelFingerprintForConfig: c => `fp-${c.model}`,
    callEmbeddingApi: call,
  };
  const host = await createTestHost({ provide: { embeddingRuntime: runtime } });
  vi.useFakeTimers();
  try {
    const service = new VfsEmbeddingService(host.ctx.get('embeddingRuntime') as EmbeddingRuntime, 1);
    const chunk: TextChunk = { index: 0, text: 'text', start_pos: 0, end_pos: 4, page_index: null, source_id: null };
    const progress: number[][] = [];
    const pending = service.generateEmbeddingsForChunks([chunk, { ...chunk, index: 1 }], (done, total) => progress.push([done, total]));
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(call).toHaveBeenCalledTimes(3); expect(result.embedding_dim).toBe(2);
    expect(progress).toEqual([[1, 2], [2, 2]]);
    model = 'new';
    await expect(service.ensureModelAssignmentUnchanged('model', 'old', 'fp-old')).rejects.toThrow('Text embedding assignment changed while the batch was running: model/old -> model/new');
    call.mockResolvedValueOnce([]);
    await expect(service.generateEmbeddingsBatch(['x'])).rejects.toThrow('嵌入数量不匹配: expected 1, got 0');
  } finally { vi.useRealTimers(); await host.dispose(); }
});

it('aborts backoff sleep and remaining batches immediately when AbortSignal fires', async () => {
  const call = vi.fn().mockRejectedValue(new Error('temporary error'));
  const runtime: EmbeddingRuntime = {
    getEmbeddingModelConfig: async () => ({ id: 'model', model: 'm1' }),
    modelFingerprintForConfig: () => 'fp-m1',
    callEmbeddingApi: call,
  };
  const service = new VfsEmbeddingService(runtime, 1);
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = service.generateEmbeddingsBatch(['a', 'b', 'c'], controller.signal);
  setTimeout(() => controller.abort(), 30);
  await expect(pending).rejects.toThrow('Embedding generation cancelled');
  expect(Date.now() - startedAt).toBeLessThan(350);
  expect(call).toHaveBeenCalledTimes(1);

  const preAborted = new AbortController();
  preAborted.abort();
  await expect(service.generateEmbeddingsBatch(['x'], preAborted.signal)).rejects.toThrow('Embedding generation cancelled');
  expect(call).toHaveBeenCalledTimes(1);
});
