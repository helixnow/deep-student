import { describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import plugin from '../index.ts';
import { defaultEmbeddingServiceConfig } from '../src/multimodal/embedding-service.ts';
import type { MultimodalEmbeddingServiceRuntime } from '../api.ts';

class MemorySettings implements SettingsStore {
  values = new Map<string, string>();
  save(key: string, value: string) { this.values.set(key, value); }
  get(key: string) { return this.values.get(key) ?? null; }
  delete(key: string) { return this.values.delete(key); }
  listByPrefix(prefix: string) {
    return [...this.values].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value, updatedAt: '2026-11-03T00:00:00+00:00' }));
  }
  deleteByPrefix(prefix: string) {
    let removed = 0;
    for (const key of [...this.values.keys()]) if (key.startsWith(prefix)) { this.values.delete(key); removed++; }
    return removed;
  }
  async saveSecret(key: string, value: string) { this.save(key, value); }
  async getSecret(key: string) { return this.get(key); }
  async deleteSecret(key: string) { return this.delete(key); }
}

async function createHost() {
  return createTestHost({ plugins: [plugin], provide: { settings: new MemorySettings() }, app: { version: '0.11.0' } });
}

describe('llm-providers cordis services', () => {
  it('llm_ocr_service_creates_adapters_through_the_factory', async () => {
    const host = await createHost();
    try {
      const service = host.ctx.llmOcr;
      expect(service.version).toBe(1);
      expect(service.createAdapter('deepseek_ocr').engineType()).toBe('deepseek_ocr');
      expect(service.createAdapterFromStr('paddleocr-vl').engineType()).toBe('paddle_ocr_vl');
      expect(service.availableEngines()).toContain('generic_vlm');
      const info = service.engineInfoList().find(entry => entry.engine_type === 'deepseek_ocr')!;
      expect(service.engineInfoToJson(info)).toMatchObject({
        engineType: 'deepseek_ocr',
        recommendedModel: 'deepseek-ai/DeepSeek-OCR',
      });
    } finally { await host.dispose(); }
  });

  it('llm_multimodal_service_exposes_chunking_and_preview_parsing', async () => {
    const host = await createHost();
    try {
      const service = host.ctx.llmMultimodal;
      expect(service.version).toBe(1);
      expect(service.createChunker(10_000).chunkText('short text')).toEqual(['short text']);
      expect(service.parseAttachmentPreview({ pages: [{ pageIndex: 2, blobHash: 'hash' }] })).toEqual({
        pages: [{ page_index: 2n, blob_hash: 'hash' }],
      });
      let configuredCalls = 0;
      const runtime = {
        async isMultimodalRagConfigured() { configuredCalls += 1; return true; },
      } as unknown as MultimodalEmbeddingServiceRuntime;
      const embedding = service.createEmbeddingService(runtime, defaultEmbeddingServiceConfig());
      await expect(embedding.isConfigured()).resolves.toBe(true);
      expect(configuredCalls).toBe(1);
    } finally { await host.dispose(); }
  });

  // multimodal/page_indexer.rs:18-50 serde aliases (V2-01): canonical name and
  // alias are one field; a required usize does not accept null.
  // embedding_service.rs:1014,1027 format the mode with `{:?}` (variant name), not the serde string.
  it('multimodal mode fallback logs the Rust Debug variant names', async () => {
    const host = await createHost();
    try {
      const service = host.ctx.llmMultimodal;
      const logger = (service as unknown as { _logger: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void } })._logger;
      const warn = vi.spyOn(logger, 'warn'), info = vi.spyOn(logger, 'info');
      const runtime = {
        async getVlEmbeddingModelConfig() {
          return { id: 'vl', model: 'qwen3-vl-embedding', enabled: true, is_embedding: true, is_multimodal: true, is_reranker: false };
        },
        async callMultimodalEmbeddingApiWithConfig(inputs: unknown[]) { return inputs.map(() => [1, 0]); },
      } as unknown as MultimodalEmbeddingServiceRuntime;
      const embedding = service.createEmbeddingService(runtime, defaultEmbeddingServiceConfig());
      const [vectors] = await embedding.embedPagesWithModeAndProgress([['aGVsbG8=', 'image/png', undefined]], 'vl_summary_then_text_embed');
      expect(vectors).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith('⚠️ 请求的模式 %s 不可用（或已弃用），回退到 VLEmbedding', 'VLSummaryThenTextEmbed');
      expect(info).toHaveBeenCalledWith('🔄 多模态嵌入服务：使用 %s 模式处理 %d 个页面', 'VLEmbedding', 1);
    } finally { await host.dispose(); }
  });

  it('paddle grounding JSON follows serde Value::get on non-object blocks and the recursion limit', async () => {
    const host = await createHost();
    try {
      const adapter = host.ctx.llmOcr.createAdapter('paddle_ocr_vl');
      // paddle.rs:222-240: a non-object block yields the default region instead of failing the JSON path.
      const mixed = adapter.parseResponse('{"blocks":[1,null,{"type":"title","text":"T","score":0.5}],"markdown":"M"}', 100, 100, 0, '/p.png', 'grounding');
      expect(mixed.regions).toEqual([{ label: 'text', text: '' }, { label: 'text', text: '' }, { label: 'title', text: 'T', confidence: 0.5 }]);
      expect(mixed.markdown_text).toBe('M');
      // serde_json recursion limit 128: depth 127 parses as JSON, depth 128 falls back to the plain document region.
      const nested = (depth: number) => `{"blocks":[],"x":${'['.repeat(depth - 1)}${']'.repeat(depth - 1)}}`;
      expect(adapter.parseResponse(nested(127), 100, 100, 0, '/p.png', 'grounding').regions).toEqual([]);
      const deep = nested(128);
      expect(adapter.parseResponse(deep, 100, 100, 0, '/p.png', 'grounding').regions)
        .toEqual([{ label: 'document', text: deep, raw_output: deep }]);
    } finally {
      await host.dispose();
    }
  });

  it('llm_multimodal_preview_parsing_keeps_serde_alias_and_required_field_rules', async () => {
    const host = await createHost();
    try {
      const service = host.ctx.llmMultimodal;
      expect(() => service.parseAttachmentPreview({ pages: [], dpi: 96, renderDpi: 150 }))
        .toThrow('duplicate field `dpi`');
      expect(() => service.parseAttachmentPreviewPage({ page_index: 0, pageIndex: 1 }))
        .toThrow('duplicate field `page_index`');
      expect(() => service.parseAttachmentPreviewPage({ pageIndex: 0, blob_hash: 'a', blobHash: 'b' }))
        .toThrow('duplicate field `blob_hash`');
      expect(() => service.parseAttachmentPreviewPage({ pageIndex: null }))
        .toThrow('invalid type: null, expected usize');
      expect(() => service.parseAttachmentPreviewPage({})).toThrow('missing field `page_index`');
      expect(service.parseAttachmentPreviewPage({ pageIndex: 4, width: 10, mimeType: null }))
        .toEqual({ page_index: 4n, width: 10 });
    } finally { await host.dispose(); }
  });

  it('preview struct sequences preserve field order, defaults and full-width usize values', async () => {
    const host = await createHost();
    try {
      const service = host.ctx.llmMultimodal;
      expect(service.parseAttachmentPreviewJson('[[],null,null,null]')).toEqual({ pages: [] });
      expect(service.parseAttachmentPreviewJson('[[]]')).toEqual({ pages: [] });
      expect(service.parseAttachmentPreviewJson('[[[9007199254740993,"blob",4294967295,4,"image/png","small"]],96,18446744073709551615,"rendered"]'))
        .toEqual({ pages: [{ page_index: 9007199254740993n, blob_hash: 'blob', width: 4294967295, height: 4, mime_type: 'image/png', compressed_blob_hash: 'small' }],
          dpi: 96, page_count: 18446744073709551615n, rendered_at: 'rendered' });
      expect(service.parseAttachmentPreview([[[3, null]]])).toEqual({ pages: [{ page_index: 3n }] });
      expect(service.parseAttachmentPreviewPage([0, null])).toEqual({ page_index: 0n });
      // Map Option missing is allowed, while a sequence needs this non-default slot.
      expect(service.parseAttachmentPreviewPage({ page_index: 0 })).toEqual({ page_index: 0n });
    } finally { await host.dispose(); }
  });

  it('preview sequences enforce required slots and reject extra or ill-typed fields in order', async () => {
    const host = await createHost();
    try {
      const parse = (text: string) => host.ctx.llmMultimodal.parseAttachmentPreviewJson(text);
      expect(() => parse('[]')).toThrow('invalid length 0, expected struct AttachmentPreview with 4 elements');
      expect(() => parse('[[[0]]]')).toThrow('invalid length 1, expected struct AttachmentPreviewPage with 6 elements');
      expect(() => parse('[[],null,null,null,0]')).toThrow('trailing characters');
      expect(() => parse('[[[0,null,true,null,null,null,0]]]')).toThrow('invalid type for `width`');
      expect(() => parse('[[[-0,null]]]')).toThrow('invalid type for `page_index`');
      expect(() => parse('[[],null,18446744073709551616]')).toThrow('invalid type for `page_count`');
    } finally { await host.dispose(); }
  });
});
