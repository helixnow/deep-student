import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import type { CanonicalContentPart } from '../../chat/api.ts';

let host: Awaited<ReturnType<typeof createPipelineHost>>;
beforeAll(async () => {
  host = await createPipelineHost({ llm: true });
  await host.ctx.llm.saveApiConfigurations([
    { id: 'assigned', name: 'assigned', model: 'text-model', baseUrl: 'https://provider.invalid/v1',
      apiKey: 'frozen-key', enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false },
    { id: 'favorite', name: 'favorite', model: 'other-text', baseUrl: 'https://provider.invalid/v1',
      apiKey: 'frozen-key', enabled: true, isMultimodal: false, isFavorite: true, isReasoning: false, isEmbedding: false, isReranker: false },
    { id: 'vision', name: 'vision', model: 'vision-model', baseUrl: 'https://provider.invalid/v1',
      apiKey: 'frozen-key', enabled: true, isMultimodal: true, isReasoning: false, isEmbedding: false, isReranker: false },
  ]);
  await host.ctx.llm.saveModelAssignments({ model2_config_id: 'assigned' });
}, 60_000);
afterAll(async () => { await host?.dispose(); });

describe('P1 request freeze through Host → real L02 config/routing → L12 planner', () => {
  it('freezes the complete selected provider and owned canonical/options before caller mutation', async () => {
    const options = { modelId: 'assigned', model2OverrideId: 'favorite', temperature: 0.25, maxTokens: 123 };
    const execution = host.ctx.chatPipeline.createPipelineContext({ sessionId: 'freeze', content: 'hello', options });
    const parts: CanonicalContentPart[] = [{ type: 'text', text: 'hello' }];
    const config = await host.ctx.chatPipeline.freezeExecutionContext(execution, () => parts);
    expect(config).toMatchObject({ id: 'assigned', model: 'text-model', apiKey: 'frozen-key',
      baseUrl: 'https://provider.invalid/v1', temperature: 0.25, maxOutputTokens: 123 });
    expect(execution.options).toMatchObject({ modelId: 'assigned', model2OverrideId: 'assigned' });
    expect(execution.executionSnapshot).toMatchObject({ requestedModelId: 'assigned',
      resolvedModelId: 'assigned', resolvedModelName: 'text-model', resolvedModelIsMultimodal: false,
      generationPlan: { planner: { route: 'text_model_direct', activeModel: 'text' }, imageBudget: 8, historyImageBudget: 4 },
      executionRoute: null });
    options.modelId = 'favorite';
    const saved = await host.ctx.llm.getApiConfigs();
    saved.find(value => value.id === 'assigned')!.apiKey = 'changed';
    await host.ctx.llm.saveApiConfigurations(saved);
    expect((await host.ctx.llm.getApiConfigs()).find(value => value.id === 'assigned')?.apiKey).toBe('changed');
    expect(config.apiKey).toBe('frozen-key');
    expect(execution.options.modelId).toBe('assigned');
  });

  it('tries the assigned default before favorite capability fallback for a deleted ordinary model', async () => {
    const execution = host.ctx.chatPipeline.createPipelineContext({ sessionId: 'deleted-model', content: 'hello',
      options: { modelId: 'deleted-config' } });
    const config = await host.ctx.chatPipeline.freezeExecutionContext(execution, () => [{ type: 'text', text: 'hello' }]);
    expect(config.id).toBe('assigned');
    expect(execution.executionSnapshot?.requestedModelId).toBe('deleted-config');
    expect(execution.executionSnapshot?.resolvedModelId).toBe('assigned');
  });

  it('strict persona failure does not select another model or build canonical content', async () => {
    const execution = host.ctx.chatPipeline.createPipelineContext({ sessionId: 'strict', content: 'hello',
      options: { modelId: 'deleted-config', strictModelId: true } });
    let builds = 0;
    await expect(host.ctx.chatPipeline.freezeExecutionContext(execution, () => { builds++; return []; }))
      .rejects.toThrow("Explicit persona model 'deleted-config' is unavailable; refusing to fall back to another model");
    expect(builds).toBe(0);
    expect(execution.options.modelId).toBe('deleted-config');
    expect(execution.executionSnapshot).toBeNull();
  });

  it('reuses retry canonical parts and plans images from those parts instead of rebuilding', async () => {
    const execution = host.ctx.chatPipeline.createPipelineContext({ sessionId: 'retry', content: 'hello',
      options: { modelId: 'vision' } });
    const canonical: CanonicalContentPart[] = [{ type: 'image_ref', image_id: 'original-image',
      mime_type: 'image/png', pinned: true, retrieval_hit: false }];
    execution.canonicalContent = canonical;
    const config = await host.ctx.chatPipeline.freezeExecutionContext(execution, () => {
      throw new Error('retry must not rebuild canonical content');
    });
    expect(config.id).toBe('vision');
    expect(execution.canonicalContent).toEqual(canonical);
    expect(execution.canonicalContent).not.toBe(canonical);
    expect(execution.executionSnapshot?.generationPlan.planner).toMatchObject({
      route: 'multimodal_model_direct', activeModel: 'multimodal', sendsOriginalImages: true,
    });
  });
});
