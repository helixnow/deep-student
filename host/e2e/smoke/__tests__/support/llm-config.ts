import type { LaunchedApp } from './app.ts';

export const SMOKE_VENDOR_ID = 'smoke-vendor';
export const SMOKE_MODEL_ID = 'smoke-model';
export const SMOKE_EMBED_MODEL_ID = 'smoke-embed';
export const SMOKE_API_KEY = 'sk-smoke-local';

/**
 * Point the chat model at the fake LLM through the same commands the Settings model page persists with
 * (`src/utils/configApi.ts`: save_vendor_configs → save_model_profiles → save_model_assignments).
 */
export async function configureFakeModel(app: LaunchedApp, baseUrl: string): Promise<void> {
  const vendors = await app.call<Array<{ id: string }>>('get_vendor_configs');
  await app.call('save_vendor_configs', {
    configs: [...vendors.filter((v) => v.id !== SMOKE_VENDOR_ID), {
      id: SMOKE_VENDOR_ID, name: 'Smoke Local', providerType: 'general', authMode: 'api_key',
      apiProtocol: 'openai_chat_completions', baseUrl, apiKey: SMOKE_API_KEY, apiKeys: [SMOKE_API_KEY],
    }],
  });
  const profiles = await app.call<Array<{ id: string }>>('get_model_profiles');
  await app.call('save_model_profiles', {
    profiles: [...profiles.filter((p) => p.id !== SMOKE_MODEL_ID), {
      id: SMOKE_MODEL_ID, vendorId: SMOKE_VENDOR_ID, label: 'Smoke Fake Chat', model: 'fake-chat', modelAdapter: 'general',
      enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false, supportsTools: true,
      // Unknown model ids fall back to a 32k window, which two loaded skills (qbank + review) nearly fill;
      // the agent smoke loads every builtin skill in one turn.
      contextWindow: 1_048_576,
    }],
  });
  const assignments = await app.call<Record<string, unknown>>('get_model_assignments');
  await app.call('save_model_assignments', { assignments: { ...assignments, model2_config_id: SMOKE_MODEL_ID } });
  // The Settings page broadcasts these after saving (src/hooks/useVendorModels.ts).
  const detail = { vendors: await app.call('get_vendor_configs'), modelProfiles: await app.call('get_model_profiles') };
  await app.page.evaluate((d) => {
    window.dispatchEvent(new CustomEvent('api_configurations_changed', { detail: d }));
    window.dispatchEvent(new CustomEvent('model_assignments_changed'));
  }, detail);
}

/** Assign the fake LLM's `/embeddings` model (after {@link configureFakeModel}) so the vfs-index worker indexes. */
export async function configureFakeEmbedding(app: LaunchedApp): Promise<void> {
  const profiles = await app.call<Array<{ id: string }>>('get_model_profiles');
  await app.call('save_model_profiles', {
    profiles: [...profiles.filter((p) => p.id !== SMOKE_EMBED_MODEL_ID), {
      id: SMOKE_EMBED_MODEL_ID, vendorId: SMOKE_VENDOR_ID, label: 'Smoke Fake Embedding', model: 'fake-embed', modelAdapter: 'general',
      enabled: true, isMultimodal: false, isReasoning: false, isEmbedding: true, isReranker: false, supportsTools: false,
    }],
  });
  const assignments = await app.call<Record<string, unknown>>('get_model_assignments');
  await app.call('save_model_assignments', { assignments: { ...assignments, embedding_model_config_id: SMOKE_EMBED_MODEL_ID } });
}
