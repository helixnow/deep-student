/**
 * pipeline/context_compiler/model_selection.rs — generation-model resolution.
 *
 * Classifies configs into text / multimodal / dedicated-OCR kinds, resolves the
 * requested and strict (persona) models, and applies per-send parameter
 * overrides. `GenerationModelConfig` is the subset of L02 `ApiConfig` this
 * layer reads; an `ApiConfig` is structurally assignable to it.
 */
import type { SendOptions } from '../../../../contracts/ipc/generated/_shared.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type { CanonicalContentPart } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import {
  isDedicatedOcrEngine, OcrAdapterFactory, type OcrEngineType,
} from '../../llm-providers/api.ts';
import type { ActiveGenerationModel } from '../../vfs-index/api.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

export interface GenerationModelConfig {
  id: string;
  model: string;
  enabled: boolean;
  isMultimodal: boolean;
  isEmbedding: boolean;
  isReranker: boolean;
  isImageGeneration: boolean;
  isFavorite: boolean;
  isBuiltin: boolean;
  temperature: number;
  maxOutputTokens: number;
  topPOverride: number | null;
  frequencyPenaltyOverride: number | null;
  presencePenaltyOverride: number | null;
}

/** llm_manager::OcrRuntimeCandidate. */
export type OcrRuntimeCandidate =
  | { kind: 'remote'; config: GenerationModelConfig; engineType: OcrEngineType }
  | { kind: 'system_ocr' };

export function auxiliaryMmEligible(config: GenerationModelConfig, activeConfigId: string,
  dedicatedOcrIds: ReadonlySet<string>): boolean {
  return generationModelKind(config, dedicatedOcrIds) === 'multimodal'
    && config.id !== activeConfigId;
}

export function isDedicatedOcrCandidate(candidate: OcrRuntimeCandidate): boolean {
  return candidate.kind === 'system_ocr' || isDedicatedOcrEngine(candidate.engineType);
}

export function generationModelKind(config: GenerationModelConfig,
  dedicatedOcrIds: ReadonlySet<string>): ActiveGenerationModel | null {
  if (!config.enabled
    || config.isEmbedding
    || config.isReranker
    || config.isImageGeneration
    || config.model === 'deepseek-asr'
    || dedicatedOcrIds.has(config.id)
    || isDedicatedOcrEngine(OcrAdapterFactory.inferEngineFromModel(config.model))) {
    return null;
  }
  return config.isMultimodal ? 'multimodal' : 'text';
}

export function requestedGenerationModel(requestedModelId: string | null | undefined,
  selected: GenerationModelConfig | null | undefined,
  configs: readonly GenerationModelConfig[]): ActiveGenerationModel | null {
  const found = requestedModelId === null || requestedModelId === undefined
    ? undefined
    : configs.find(config => config.id === requestedModelId || config.model === requestedModelId);
  const config = found ?? selected ?? null;
  if (config === null || config === undefined) return null;
  return config.isMultimodal ? 'multimodal' : 'text';
}

/** Rust `sort_by` order: favorite desc, builtin desc, id bytes asc. */
function compareCandidates(a: GenerationModelConfig, b: GenerationModelConfig): number {
  if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
  if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? -1 : 1;
  return compareUtf8(a.id, b.id);
}

/**
 * Keeps the initially selected config when it already matches the planned
 * kind; otherwise picks the best matching config by preference order. The
 * result is a copy, so later config mutations never leak into a frozen plan.
 */
export function selectGenerationConfig(configs: readonly GenerationModelConfig[],
  initiallySelected: GenerationModelConfig | null | undefined, planned: ActiveGenerationModel,
  dedicatedOcrIds: ReadonlySet<string>): GenerationModelConfig | null {
  if (initiallySelected !== null && initiallySelected !== undefined
    && generationModelKind(initiallySelected, dedicatedOcrIds) === planned) {
    return { ...initiallySelected };
  }
  const candidates = configs
    .filter(config => generationModelKind(config, dedicatedOcrIds) === planned)
    .sort(compareCandidates);
  return candidates.length === 0 ? null : { ...candidates[0]! };
}

/** Result of `resolve_strict_requested_model`; a failure never falls back. */
export type StrictModelResult =
  | { ok: true; config: GenerationModelConfig | null }
  | { ok: false; error: string };

export function resolveStrictRequestedModel(strict: boolean,
  requestedModelId: string | null | undefined, configs: readonly GenerationModelConfig[],
  dedicatedOcrIds: ReadonlySet<string>): StrictModelResult {
  if (!strict) return { ok: true, config: null };
  const modelId = requestedModelId == null ? undefined : rustTrim(requestedModelId);
  if (modelId === undefined || modelId === '') {
    return { ok: false, error: 'strict model selection requires a non-empty model configuration id' };
  }
  const config = configs.find(candidate => candidate.id === modelId);
  if (config === undefined) {
    return {
      ok: false,
      error: `Explicit persona model '${modelId}' is unavailable; refusing to fall back to another model`,
    };
  }
  if (generationModelKind(config, dedicatedOcrIds) === null) {
    return {
      ok: false,
      error: `Explicit persona model '${modelId}' is disabled or is not a chat generation model; refusing to fall back`,
    };
  }
  return { ok: true, config: { ...config } };
}

/** routing::ParamOverrides::apply, restricted to the five per-send fields. */
export function applySendOverrides(config: GenerationModelConfig, options: SendOptions): void {
  if (options.temperature !== undefined && options.temperature !== null) {
    config.temperature = Math.fround(options.temperature);
  }
  if (options.maxTokens !== undefined && options.maxTokens !== null) {
    config.maxOutputTokens = options.maxTokens;
  }
  if (options.topP !== undefined && options.topP !== null) {
    config.topPOverride = Math.fround(options.topP);
  }
  if (options.frequencyPenalty !== undefined && options.frequencyPenalty !== null) {
    config.frequencyPenaltyOverride = Math.fround(options.frequencyPenalty);
  }
  if (options.presencePenalty !== undefined && options.presencePenalty !== null) {
    config.presencePenaltyOverride = Math.fround(options.presencePenalty);
  }
}

/** Chat model id wins over the background `model2` override; blanks are ignored. */
export function requestedActiveModelId(options: SendOptions): string | null {
  const modelId = options.modelId;
  if (modelId !== undefined && modelId !== null && rustTrim(modelId) !== '') return modelId;
  const model2 = options.model2OverrideId;
  if (model2 !== undefined && model2 !== null && rustTrim(model2) !== '') return model2;
  return null;
}

/** Retry snapshots reuse the frozen canonical parts instead of rebuilding. */
export function canonicalContentForFreeze(existing: readonly CanonicalContentPart[],
  build: () => CanonicalContentPart[]): CanonicalContentPart[] {
  return existing.length === 0
    ? build()
    : existing.map(part => structuredClone(part));
}
