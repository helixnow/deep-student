/**
 * 模型能力推断（移植 `dstu-llm/src/llm_manager/mod.rs` 4390–4572 的
 * `resolve_capability_overrides` / 注册表打分，以及 builtin_vendors::deepseek_context_window）。
 */
import { MODEL_CAPABILITY_REGISTRY_DOCUMENT } from './data/model_capability_registry.ts';
import { BUILTIN_MODELS, BUILTIN_VENDORS } from './data/builtin_catalog.ts';

export interface CapabilityOverrides {
  isMultimodal: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  contextWindow: number | null;
}

interface RegistryCapabilities {
  vision?: boolean;
  function_calling?: boolean;
  reasoning?: boolean;
  max_context_tokens?: number | null;
}

interface RegistryModelRecord {
  model_id: string;
  provider_scope?: string | null;
  provider_model_id?: string | null;
  alias_of?: string | null;
  capabilities: RegistryCapabilities;
}

interface RegistrySeriesRecord {
  models: RegistryModelRecord[];
}

interface RegistryDocument {
  records: RegistrySeriesRecord[];
}

const MODEL_CAPABILITY_REGISTRY: readonly RegistryModelRecord[] = (
  MODEL_CAPABILITY_REGISTRY_DOCUMENT as unknown as RegistryDocument
).records.flatMap((record: RegistrySeriesRecord) => record.models);

export const EMPTY_CAPABILITIES: CapabilityOverrides = {
  isMultimodal: false,
  supportsTools: false,
  supportsReasoning: false,
  contextWindow: null,
};

export function normalizeModelId(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeProviderScope(value: string | null | undefined): string | null {
  const scope = (value ?? '').trim().toLowerCase();
  return scope === '' ? null : scope;
}

function splitModelName(value: string): string[] {
  return normalizeModelId(value).split(/[/:\\]/);
}

function baseModelId(value: string): string {
  const parts = splitModelName(value);
  return parts[parts.length - 1] ?? '';
}

function matchesFullModelId(input: string, candidate: string | null | undefined): boolean {
  if (candidate == null) return false;
  const normalized = normalizeModelId(candidate);
  return input === normalized || input.endsWith(`/${normalized}`) || input.endsWith(`:${normalized}`);
}

function registryRecordScore(
  modelId: string,
  providerScope: string | null | undefined,
  record: RegistryModelRecord,
): number {
  const normalizedInput = normalizeModelId(modelId);
  if (normalizedInput === '') return -1;

  const baseId = baseModelId(modelId);
  const requestedScope = normalizeProviderScope(providerScope);
  const recordScope = normalizeProviderScope(record.provider_scope);

  let score: number;
  if (matchesFullModelId(normalizedInput, record.provider_model_id)) score = 500;
  else if (matchesFullModelId(normalizedInput, record.model_id)) score = 450;
  else if (matchesFullModelId(normalizedInput, record.alias_of)) score = 430;
  else if (record.provider_model_id != null && baseModelId(record.provider_model_id) === baseId) score = 320;
  else if (baseModelId(record.model_id) === baseId) score = 300;
  else if (record.alias_of != null && baseModelId(record.alias_of) === baseId) score = 280;
  else score = -1;

  if (score < 0) return score;

  if (requestedScope !== null) {
    if (recordScope === requestedScope) score += 40;
    else if (recordScope === null) score += 10;
  } else if (recordScope === null) {
    score += 20;
  }
  return score;
}

function inferCapabilityOverridesFromRegistry(
  modelId: string,
  providerScope: string | null | undefined,
): CapabilityOverrides | null {
  let bestRecord: RegistryModelRecord | null = null;
  let bestScore = -1;
  for (const record of MODEL_CAPABILITY_REGISTRY) {
    const score = registryRecordScore(modelId, providerScope, record);
    if (score > bestScore) {
      bestScore = score;
      bestRecord = record;
    }
  }
  if (bestRecord === null) return null;
  return {
    isMultimodal: bestRecord.capabilities.vision === true,
    supportsTools: bestRecord.capabilities.function_calling === true,
    supportsReasoning: bestRecord.capabilities.reasoning === true,
    contextWindow: bestRecord.capabilities.max_context_tokens ?? null,
  };
}

const VENDOR_SCOPE_BY_ID = new Map(BUILTIN_VENDORS.map((vendor) => [vendor.id, vendor.providerType]));

/** 内置目录按模型名精确匹配（`infer_capability_overrides_from_builtin_catalog`）。 */
export function inferCapabilityOverridesFromBuiltinCatalog(
  modelId: string,
  providerScope: string | null | undefined,
): CapabilityOverrides | null {
  const normalizedModel = normalizeModelId(modelId);
  const requestedScope = normalizeProviderScope(providerScope);

  for (const model of BUILTIN_MODELS) {
    if (normalizeModelId(model.model) !== normalizedModel) continue;
    const builtinScope = normalizeProviderScope(VENDOR_SCOPE_BY_ID.get(model.vendorId) ?? null);
    if (requestedScope !== null && builtinScope !== requestedScope) continue;
    return {
      isMultimodal: model.isMultimodal,
      supportsTools: model.supportsTools,
      supportsReasoning: model.isReasoning,
      contextWindow: deepseekContextWindow(model.model),
    };
  }
  return null;
}

export function resolveCapabilityOverrides(
  modelId: string,
  providerScope: string | null | undefined,
): CapabilityOverrides {
  const registry = inferCapabilityOverridesFromRegistry(modelId, providerScope) ?? EMPTY_CAPABILITIES;
  const builtin = inferCapabilityOverridesFromBuiltinCatalog(modelId, providerScope) ?? EMPTY_CAPABILITIES;
  return {
    isMultimodal: registry.isMultimodal || builtin.isMultimodal,
    supportsTools: registry.supportsTools || builtin.supportsTools,
    supportsReasoning: registry.supportsReasoning || builtin.supportsReasoning,
    contextWindow: registry.contextWindow ?? builtin.contextWindow,
  };
}

/** builtin_vendors::deepseek_context_window */
export function deepseekContextWindow(model: string): number | null {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes('deepseek-v4') || normalized.includes('deepseek-flash')) return 1_000_000;
  if (normalized.includes('deepseek-v3.2') || normalized.includes('deepseek-v3.1')) return 128_000;
  if (
    normalized.includes('nemotron-3-nano') ||
    normalized.includes('nemotron-3-super') ||
    normalized.includes('nemotron-3-ultra')
  ) {
    return 1_000_000;
  }
  if (normalized === 'mimo-v2.5-pro' || normalized === 'mimo-v2.5') return 1_000_000;
  if (normalized === 'gpt-5.6') return 1_050_000;
  if (normalized === 'kimi-k3') return 1_000_000;
  if (
    normalized === 'kimi-k2.6' ||
    normalized === 'kimi-k2.7-code' ||
    normalized === 'kimi-k2.7-code-highspeed' ||
    normalized === 'kimi-k2.5'
  ) {
    return 262_144;
  }
  if (normalized === 'doubao-seed-evolving') return 1_000_000;
  if (normalized.startsWith('doubao-seed-2-1-')) return 262_144;
  if (
    normalized === 'glm-5.2' ||
    normalized === 'minimax-m3' ||
    normalized === 'minimax-m2.7' ||
    normalized === 'qwen3.7-max' ||
    normalized === 'qwen3.7-plus' ||
    normalized === 'qwen3.6-flash'
  ) {
    return 1_000_000;
  }
  if (normalized === 'glm-5.1') return 200_000;
  if (normalized === 'claude-opus-5' || normalized === 'claude-sonnet-5' || normalized === 'claude-fable-5') {
    return 1_000_000;
  }
  if (normalized.startsWith('claude-haiku-4-5')) return 200_000;
  return null;
}

/** 视觉/多模态嵌入模型名（`looks_like_multimodal_embedding`）。 */
export function looksLikeMultimodalEmbedding(model: string): boolean {
  return model
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((token) => ['vl', 'vision', 'multimodal', 'clip', 'siglip', 'omni'].includes(token));
}

/** `looks_like_image_generation_model_id` */
export function looksLikeImageGenerationModelId(model: string): boolean {
  const lowered = model.toLowerCase();
  return ['gpt-image', 'dall-e', 'imagen', 'flux'].some((needle) => lowered.includes(needle));
}
