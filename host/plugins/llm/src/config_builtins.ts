/** Built-in catalog → vendor/profile defaults (llm_manager/mod.rs). */
import type { ModelProfile, VendorConfig } from '../api.ts';
import { deepseekContextWindow } from './capabilities.ts';
import { providerSupportsOpenaiResponses, resolvePreferredProtocolForProvider } from './protocol.ts';
import { modelAdapterForProtocol } from './opencode_go.ts';
import { BUILTIN_MODELS, BUILTIN_VENDORS, OPENCODE_GO_BUILTIN_MODELS,
  OPENCODE_GO_VENDOR_ID, type BuiltinModelDef } from './data/builtin_catalog.ts';
import { GEMINI_MODEL_REGISTRY_DOCUMENT } from './data/gemini_model_registry.ts';

function builtinVendorToConfig(vendor: (typeof BUILTIN_VENDORS)[number]): VendorConfig {
  return {
    id: vendor.id, name: vendor.name, providerType: vendor.providerType, authMode: vendor.authMode,
    apiProtocol: resolvePreferredProtocolForProvider(vendor.providerType, vendor.providerType, vendor.baseUrl, null),
    supportsOpenaiResponses: providerSupportsOpenaiResponses(vendor.providerType, vendor.baseUrl, null),
    baseUrl: vendor.baseUrl, apiKey: '', apiKeys: [], headers: {}, rateLimitPerMinute: null,
    defaultTimeoutMs: null, notes: vendor.notes, isBuiltin: true, isReadOnly: false,
    sortOrder: null, maxTokensLimit: vendor.maxTokensLimit, websiteUrl: vendor.websiteUrl === '' ? null : vendor.websiteUrl,
  };
}
function builtinModelAdapter(vendorId: string): { adapter: string; geminiVersion: string | null } {
  if (vendorId === 'builtin-gemini') return { adapter: 'google', geminiVersion: 'v1beta' };
  if (vendorId === 'builtin-deepseek') return { adapter: 'deepseek', geminiVersion: null };
  if (vendorId === 'builtin-nvidia') return { adapter: 'general', geminiVersion: null };
  if (vendorId === 'builtin-mimo') return { adapter: 'mimo', geminiVersion: null };
  if (vendorId === 'builtin-anthropic') return { adapter: 'anthropic', geminiVersion: null };
  return { adapter: 'general', geminiVersion: null };
}
function builtinModelReasoningEffort(model: BuiltinModelDef): string | null {
  if (model.vendorId === 'builtin-deepseek' && model.isReasoning) return 'high';
  if ((model.vendorId === 'builtin-openai' || model.vendorId === 'builtin-openai-codex') && model.isReasoning) {
    if (['gpt-5.5-pro', 'gpt-5.4-pro', 'gpt-5.2-pro', 'gpt-5-pro', 'o3-pro'].includes(model.model)) return 'high';
    return model.model === 'gpt-5.4-nano' ? 'low' : 'medium';
  }
  return null;
}
function builtinModelVerbosity(model: BuiltinModelDef): string | null {
  if ((model.vendorId === 'builtin-openai' || model.vendorId === 'builtin-openai-codex') && model.isReasoning) {
    return model.model === 'gpt-5.4-nano' ? 'low' : 'medium';
  }
  return null;
}
function builtinModelToProfile(model: BuiltinModelDef): ModelProfile {
  const vendor = BUILTIN_VENDORS.find(item => item.id === model.vendorId);
  const { adapter, geminiVersion } = builtinModelAdapter(model.vendorId);
  const useReasoningDefaults = model.isReasoning && model.vendorId !== 'builtin-nvidia';
  return {
    id: model.id, vendorId: model.vendorId, label: model.label, model: model.model,
    providerScope: vendor?.providerType ?? 'openai', apiProtocol: null, modelAdapter: adapter,
    isMultimodal: model.isMultimodal, isReasoning: model.isReasoning, isEmbedding: false,
    isReranker: false, isImageGeneration: false, supportsTools: model.supportsTools,
    supportsReasoning: model.isReasoning, status: 'enabled', enabled: true,
    maxOutputTokens: model.maxOutputTokens, temperature: model.temperature,
    reasoningEffort: builtinModelReasoningEffort(model), reasoningMode: null,
    thinkingEnabled: useReasoningDefaults, thinkingBudget: null, includeThoughts: useReasoningDefaults,
    enableThinking: null, minP: null, topK: null, geminiApiVersion: geminiVersion,
    isBuiltin: false, repetitionPenalty: null, reasoningSplit: null,
    effort: null, verbosity: builtinModelVerbosity(model), isFavorite: false,
    maxTokensLimit: vendor?.maxTokensLimit ?? null, contextWindow: deepseekContextWindow(model.model),
    extraBody: null,
  };
}
interface GeminiRegistryModel {
  id: string; label: string; model: string; is_multimodal: boolean; is_reasoning: boolean;
  supports_tools: boolean; max_output_tokens: number; temperature?: number | null;
  reasoning_effort?: string | null; thinking_enabled?: boolean | null;
  include_thoughts?: boolean | null; gemini_api_version?: string | null;
}
interface GeminiRegistryDocument {
  vendor: { id: string; name: string; provider_type: string; base_url: string; notes: string;
    max_tokens_limit?: number | null; website_url: string };
  models: GeminiRegistryModel[];
}
const GEMINI_REGISTRY = GEMINI_MODEL_REGISTRY_DOCUMENT as unknown as GeminiRegistryDocument;
function geminiVendorToConfig(vendor: GeminiRegistryDocument['vendor']): VendorConfig {
  return {
    id: vendor.id, name: vendor.name, providerType: vendor.provider_type, authMode: null,
    apiProtocol: resolvePreferredProtocolForProvider(vendor.provider_type, vendor.provider_type, vendor.base_url, null),
    supportsOpenaiResponses: providerSupportsOpenaiResponses(vendor.provider_type, vendor.base_url, null),
    baseUrl: vendor.base_url, apiKey: '', apiKeys: [], headers: {}, rateLimitPerMinute: null,
    defaultTimeoutMs: null, notes: vendor.notes, isBuiltin: true, isReadOnly: false,
    sortOrder: null, maxTokensLimit: vendor.max_tokens_limit ?? null, websiteUrl: vendor.website_url === '' ? null : vendor.website_url,
  };
}
function geminiModelToProfile(model: GeminiRegistryModel, vendor: GeminiRegistryDocument['vendor']): ModelProfile {
  const thinkingEnabled = model.thinking_enabled ?? model.is_reasoning;
  return {
    id: model.id, vendorId: vendor.id, label: model.label, model: model.model, providerScope: vendor.provider_type,
    apiProtocol: resolvePreferredProtocolForProvider(vendor.provider_type, 'google', vendor.base_url, null),
    modelAdapter: 'google', isMultimodal: model.is_multimodal, isReasoning: model.is_reasoning,
    isEmbedding: false, isReranker: false, isImageGeneration: false, supportsTools: model.supports_tools,
    supportsReasoning: model.is_reasoning, status: 'enabled', enabled: true, maxOutputTokens: model.max_output_tokens,
    temperature: model.temperature ?? 1.0, reasoningEffort: model.reasoning_effort ?? null,
    reasoningMode: null, thinkingEnabled, thinkingBudget: null,
    includeThoughts: model.include_thoughts ?? thinkingEnabled, enableThinking: null, minP: null, topK: null,
    geminiApiVersion: model.gemini_api_version ?? 'v1beta', isBuiltin: false, repetitionPenalty: null,
    reasoningSplit: null, effort: null, verbosity: null, isFavorite: false,
    maxTokensLimit: vendor.max_tokens_limit ?? null, contextWindow: null, extraBody: null,
  };
}
function opencodeGoModelToProfile(model: (typeof OPENCODE_GO_BUILTIN_MODELS)[number]): ModelProfile {
  const base = builtinModelToProfile({ id: model.id, vendorId: OPENCODE_GO_VENDOR_ID, label: model.label,
    model: model.model, isMultimodal: model.isMultimodal, isReasoning: model.isReasoning,
    supportsTools: true, maxOutputTokens: model.maxOutputTokens, temperature: 0.7 });
  base.apiProtocol = model.protocol;
  base.modelAdapter = modelAdapterForProtocol(model.protocol);
  if (model.protocol === 'google_generate_content') base.geminiApiVersion = 'v1beta';
  if (model.isReasoning && model.protocol === 'openai_responses') base.reasoningEffort = 'medium';
  return base;
}
export function loadBuiltinVendors(existingVendorIds: readonly string[]): VendorConfig[] {
  const vendors = BUILTIN_VENDORS.filter(vendor => !existingVendorIds.includes(vendor.id)).map(builtinVendorToConfig);
  if (!existingVendorIds.includes(GEMINI_REGISTRY.vendor.id)) vendors.push(geminiVendorToConfig(GEMINI_REGISTRY.vendor));
  return vendors;
}
export function loadBuiltinModels(existingProfileIds: readonly string[]): ModelProfile[] {
  return [
    ...BUILTIN_MODELS.filter(model => !existingProfileIds.includes(model.id)).map(builtinModelToProfile),
    ...GEMINI_REGISTRY.models.filter(model => !existingProfileIds.includes(model.id))
      .map(model => geminiModelToProfile(model, GEMINI_REGISTRY.vendor)),
    ...OPENCODE_GO_BUILTIN_MODELS.filter(model => !existingProfileIds.includes(model.id)).map(opencodeGoModelToProfile),
  ];
}
export function loadAllBuiltins(existingVendorIds: readonly string[], existingProfileIds: readonly string[]): {
  vendors: VendorConfig[]; profiles: ModelProfile[];
} {
  return { vendors: loadBuiltinVendors(existingVendorIds), profiles: loadBuiltinModels(existingProfileIds) };
}
