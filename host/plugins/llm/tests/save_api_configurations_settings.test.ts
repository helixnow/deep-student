/**
 * `save_api_configurations` → settings `model_profiles` / `vendor_configs` text, pinned to the Rust A-side cells of
 * server G3 smoke 007c1af54c3e (review.essay.scripted.stream-success-round-persisted, step 1). Only the generated
 * vendor UUID and the encrypted apiKey (random nonce) are masked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
// boundary-allow cross-plugin-import: install the real L01 plugin for the production command path.
import providers from '../../llm-providers/index.ts';
import llm from '../index.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { image } from '../../../platform/native/image/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import { realInjectionBudget } from './host.ts';

const BASE_URL = 'http://127.0.0.1:47110/s/review.essay.scripted.stream-success-round-persisted/v1';
const RUST_MODEL_PROFILES = '[{"id":"wp229-mock","vendorId":"<vendor>","label":"WP229 wp229-mock","model":"wp229-model","providerScope":null,"apiProtocol":null,"modelAdapter":"general","isMultimodal":false,"isReasoning":false,"isEmbedding":false,"isReranker":false,"isImageGeneration":false,"supportsTools":false,"supportsReasoning":false,"status":"enabled","enabled":true,"maxOutputTokens":1024,"temperature":0.0,"reasoningEffort":null,"reasoningMode":null,"thinkingEnabled":false,"thinkingBudget":null,"includeThoughts":false,"enableThinking":null,"minP":null,"topK":null,"geminiApiVersion":"v1","isBuiltin":false,"repetitionPenalty":null,"reasoningSplit":null,"effort":null,"verbosity":null,"isFavorite":false,"maxTokensLimit":null,"contextWindow":null,"extraBody":null}]';
const RUST_VENDOR_CONFIGS = `[{"id":"<vendor>","name":"WP229 wp229-mock","providerType":"general","authMode":null,"apiProtocol":null,"supportsOpenaiResponses":false,"baseUrl":"${BASE_URL}","apiKey":"<apiKey>","apiKeys":[],"headers":{},"rateLimitPerMinute":null,"defaultTimeoutMs":null,"notes":null,"isBuiltin":false,"isReadOnly":false,"sortOrder":null,"maxTokensLimit":null,"websiteUrl":null}]`;

let host: Awaited<ReturnType<typeof createTestHost>>;
const values = new Map<string, string>();
const settings: SettingsStore = {
  get: key => values.get(key) ?? null, save: (key, value) => { values.set(key, value); },
  delete: key => values.delete(key), listByPrefix: () => [], deleteByPrefix: () => 0,
  getSecret: async key => values.get(key) ?? null, saveSecret: async (key, value) => { values.set(key, value); },
  deleteSecret: async key => values.delete(key),
};

beforeAll(async () => {
  host = await createTestHost({ plugins: [providers, llm], provide: {
    settings, secrets: { isEncryptedFormat: () => false, openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
    nativeImage: image, nativeTokenizer: tokenizer, injectionBudget: realInjectionBudget, vfsDatabase: {}, vfsRepo: { essays: {} },
  } });
});
afterAll(async () => { await host?.dispose(); });

describe('save_api_configurations settings text (G3 smoke 007c1af54c3e)', () => {
  it('writes model_profiles and vendor_configs with the Rust field set, order and number spelling', async () => {
    await host.invoke('save_api_configurations', { configs: [{ id: 'wp229-mock', name: 'WP229 wp229-mock', apiKey: 'local-test-key',
      baseUrl: BASE_URL, model: 'wp229-model', isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false,
      enabled: true, modelAdapter: 'general', maxOutputTokens: 1024, temperature: 0 }] });
    const vendors = values.get('vendor_configs')!;
    const vendorId = (JSON.parse(vendors) as { id: string }[])[0]!.id;
    expect(vendorId).toMatch(/^vendor-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(values.get('model_profiles')!.replaceAll(vendorId, '<vendor>')).toBe(RUST_MODEL_PROFILES);
    expect(vendors.replaceAll(vendorId, '<vendor>').replace(/"apiKey":"(?:[^"\\]|\\.)*"/, '"apiKey":"<apiKey>"')).toBe(RUST_VENDOR_CONFIGS);
  });
});
