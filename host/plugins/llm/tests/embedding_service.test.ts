import { expect, it, vi } from 'vitest';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { makeConfig } from './support.ts';

it('publishes embedding defaults with fallback writeback and preserves live credentials', async () => {
  const values = new Map<string, string>([
    ['embedding.default_text_model_config_id', 'gone'],
    ['model_assignments', JSON.stringify({ embedding_model_config_id: 'text' })],
  ]);
  const host = await createTestHost({ plugins: [plugin], provide: {
    settings: { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => values.set(key, value) }, secrets: {},
  } });
  try {
    vi.spyOn(host.ctx.llm, 'getApiConfigs').mockResolvedValue([
      makeConfig({ id: 'text', isEmbedding: true, isMultimodal: false, enabled: true, apiKey: 'actual-key' }),
      makeConfig({ id: 'vision', isEmbedding: true, isMultimodal: true, enabled: true }),
    ]);
    expect(await host.ctx.llmEmbeddingModels.getEmbeddingModelConfig()).toMatchObject({ id: 'text', apiKey: 'actual-key' });
    expect(values.get('embedding.default_text_model_config_id')).toBe('text');
    expect(await host.ctx.llmEmbeddingModels.adoptDefaultMultimodalEmbedding(1024, 'vision')).toBe(true);
    expect(await host.ctx.llmEmbeddingModels.getVlEmbeddingModelConfig()).toMatchObject({ id: 'vision' });
    expect(values.get('embedding.default_multimodal_dimension')).toBe('1024');
    expect(await host.ctx.llmEmbeddingModels.adoptDefaultMultimodalEmbedding(2048, 'vision')).toBe(false);
  } finally { vi.restoreAllMocks(); await host.dispose(); }
});
