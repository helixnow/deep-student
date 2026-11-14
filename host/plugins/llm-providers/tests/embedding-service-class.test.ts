import { describe, expect, it } from 'vitest';
import {
  MultimodalEmbeddingService, defaultEmbeddingServiceConfig, type EmbeddingProgress,
  type MultimodalEmbeddingModelConfig, type MultimodalEmbeddingServiceRuntime, type TextEmbeddingModelConfig,
} from '../api.ts';
import { MultimodalInputBuilder as Input } from '../api.ts';

const VL_CONFIG: MultimodalEmbeddingModelConfig = {
  id: 'vl-1', model: 'Qwen/Qwen2.5-VL-7B-Instruct', enabled: true, is_embedding: true,
  is_multimodal: true, is_reranker: false,
};

class FakeRuntime implements MultimodalEmbeddingServiceRuntime {
  configured = true;
  vlConfig: MultimodalEmbeddingModelConfig | null = VL_CONFIG;
  textConfig: TextEmbeddingModelConfig = { id: 'text-1', model: 'BAAI/bge-large-zh' };
  embeddingCalls: string[][] = [];
  vlCalls: number = 0;
  summaries: string[] = [];
  summaryCalls: string[] = [];
  failFirstEmbedding: Error | null = null;

  async isMultimodalRagConfigured(): Promise<boolean> { return this.configured; }
  async getVlEmbeddingModelConfig(): Promise<MultimodalEmbeddingModelConfig> {
    if (this.vlConfig === null) throw Object.assign(new Error('no vl model'), { error_type: 'Configuration' });
    return this.vlConfig;
  }
  async callMultimodalEmbeddingApi(inputs: unknown[]): Promise<number[][]> {
    return inputs.map(() => [1, 2]);
  }
  async callMultimodalEmbeddingApiWithConfig(inputs: unknown[], _config: MultimodalEmbeddingModelConfig): Promise<number[][]> {
    this.vlCalls += inputs.length;
    return inputs.map(() => [3, 4]);
  }
  async getEmbeddingModelConfig(): Promise<TextEmbeddingModelConfig> { return this.textConfig; }
  async callEmbeddingApi(texts: string[], _configId: string): Promise<number[][]> {
    this.embeddingCalls.push([...texts]);
    if (this.failFirstEmbedding !== null) {
      const error = this.failFirstEmbedding;
      this.failFirstEmbedding = null;
      throw error;
    }
    return texts.map((_text, index) => [index, index + 1]);
  }
  async callOcrModelRawPrompt(prompt: string, images?: readonly { mime: string; base64: string }[]): Promise<{ assistantMessage: string }> {
    this.summaryCalls.push(prompt);
    return { assistantMessage: this.summaries[this.summaryCalls.length - 1] ?? `summary-${images?.length ?? 0}` };
  }
}

describe('multimodal embedding service class', () => {
  it('reports configuration, model version and detected dimension', async () => {
    const runtime = new FakeRuntime();
    const service = new MultimodalEmbeddingService(runtime);
    expect(await service.isConfigured()).toBe(true);
    expect(await service.isVlEmbeddingAvailable()).toBe(true);
    expect(await service.getModelVersion()).toBe('Qwen/Qwen2.5-VL-7B-Instruct@vl-1');
    expect(await service.detectEmbeddingDimension()).toBe(2);

    runtime.vlConfig = null;
    expect(await service.isVlEmbeddingAvailable()).toBe(false);
  });

  it('embeds multiple inputs in configured batches with progress', async () => {
    const runtime = new FakeRuntime();
    const service = new MultimodalEmbeddingService(runtime, { ...defaultEmbeddingServiceConfig(), batch_size: 2 });
    const progress: EmbeddingProgress[] = [];
    const inputs = [Input.text('a'), Input.text('b'), Input.text('c')];
    expect(await service.embedBatchWithProgress(inputs, item => progress.push(item))).toEqual([[3, 4], [3, 4], [3, 4]]);
    expect(runtime.vlCalls).toBe(3);
    expect(progress[0]).toMatchObject({ phase: 'embedding', completed: 0, total: 3 });
    expect(progress.at(-1)).toMatchObject({ phase: 'embedding', completed: 3, total: 3 });
  });

  it('chunks long texts and aggregates their embeddings', async () => {
    const runtime = new FakeRuntime();
    const service = new MultimodalEmbeddingService(runtime);
    const longText = '中'.repeat(2000);
    const result = await service.embedTexts([longText, 'short']);
    expect(result).toHaveLength(2);
    expect(runtime.embeddingCalls).toHaveLength(1);
    expect(runtime.embeddingCalls[0]!.length).toBeGreaterThan(2);
    expect(result[0]).toHaveLength(2);
    expect(result[1]).toHaveLength(2);
  });

  it('retries token-limit failures with smaller chunks', async () => {
    const runtime = new FakeRuntime();
    runtime.failFirstEmbedding = new Error('413 too many tokens');
    const service = new MultimodalEmbeddingService(runtime);
    const result = await service.embedTexts(['hello']);
    expect(result).toHaveLength(1);
    expect(runtime.embeddingCalls).toHaveLength(2);
  });

  it('reuses existing page text and preserves summary order', async () => {
    const runtime = new FakeRuntime();
    runtime.summaries = ['generated'];
    const service = new MultimodalEmbeddingService(runtime);
    const pages = [
      ['abc', 'image/png', 'existing'] as const,
      ['def', 'image/png', undefined] as const,
    ];
    expect(await service.generateSummariesBatchWithProgress(pages)).toEqual(['existing', 'generated']);
    expect(runtime.summaryCalls).toEqual(['Convert the document to markdown.']);
  });

  it('falls back to VL embedding and rejects when no mode is available', async () => {
    const runtime = new FakeRuntime();
    const service = new MultimodalEmbeddingService(runtime);
    const [embeddings, summaries] = await service.embedPagesWithModeAndProgress(
      [['abc', 'image/png', 'text'] as const], 'vl_summary_then_text_embed',
    );
    expect(embeddings).toEqual([[3, 4]]);
    expect(summaries).toEqual(['text']);

    runtime.vlConfig = null;
    await expect(service.embedPagesWithModeAndProgress([['abc', 'image/png', undefined] as const], 'vl_embedding'))
      .rejects.toMatchObject({ error_type: 'Configuration' });
  });
});
