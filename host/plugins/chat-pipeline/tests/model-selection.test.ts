import { describe, expect, it } from 'vitest';
import type { CanonicalContentPart } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import type { SendOptions } from '../../../../contracts/ipc/generated/_shared.ts';
import {
  availableCapability, planGeneration, unavailableCapability, type CapabilitySnapshot,
} from '../../vfs-index/api.ts';
import {
  applySendOverrides, auxiliaryMmEligible, canonicalContentForFreeze, generationModelKind,
  isDedicatedOcrCandidate, requestedActiveModelId, requestedGenerationModel,
  resolveStrictRequestedModel, selectGenerationConfig, type GenerationModelConfig,
  type OcrRuntimeCandidate,
} from '../src/model-selection.ts';

function modelConfig(id: string, enabled: boolean, multimodal: boolean): GenerationModelConfig {
  return {
    id,
    model: `model-${id}`,
    enabled,
    isMultimodal: multimodal,
    isEmbedding: false,
    isReranker: false,
    isImageGeneration: false,
    isFavorite: false,
    isBuiltin: false,
    temperature: 0.7,
    maxOutputTokens: 4096,
    topPOverride: null,
    frequencyPenaltyOverride: null,
    presencePenaltyOverride: null,
  };
}

function emptySnapshot(): CapabilitySnapshot {
  return {
    textEmbedding: unavailableCapability(),
    multimodalEmbedding: unavailableCapability(),
    textModel: unavailableCapability(),
    multimodalModel: unavailableCapability(),
    ocr: unavailableCapability(),
  };
}

describe('chat_v2/pipeline/context_compiler/model_selection.rs::tests', () => {
  it('frozen_snapshot_is_owned_and_not_affected_by_later_option_changes', () => {
    const options: SendOptions = { modelId: 'before' };
    const requested = options.modelId;
    options.modelId = 'after';
    expect(requested).toBe('before');

    // Selection clones the config: later source mutations never change the plan.
    const configs = [modelConfig('available', true, false)];
    const selected = selectGenerationConfig(configs, null, 'text', new Set())!;
    configs[0]!.temperature = 1.5;
    configs[0]!.model = 'mutated';
    expect(selected.temperature).toBe(0.7);
    expect(selected.model).toBe('model-available');
  });

  it('freeze_preserves_retry_canonical_without_rebuilding_or_duplicating_parts', () => {
    const recovered: CanonicalContentPart[] = [
      { type: 'text', text: 'same prompt' },
      {
        type: 'image_ref', image_id: 'img-1', name: null, resource_id: 'res-1',
        source_id: 'source-1', blob_hash: 'original-blob', content_hash: null,
        mime_type: 'image/png', pinned: false, retrieval_hit: false,
      },
      {
        type: 'derived_artifact_ref', artifact_id: 'artifact-1', artifact_type: 'ocr',
        source_image_ids: ['img-1'], producer_model_id: null, content: 'recognized',
        created_at: 1,
      },
    ];

    let built = false;
    const frozen = canonicalContentForFreeze(recovered, () => {
      built = true;
      return [];
    });
    expect(built).toBe(false);
    expect(frozen).toEqual(recovered);
    expect(frozen).toHaveLength(recovered.length);

    // Deep copy: later edits to the source cannot rewrite the frozen snapshot.
    (recovered[0] as Extract<CanonicalContentPart, { type: 'text' }>).text = 'changed after freeze';
    (recovered[2] as Extract<CanonicalContentPart, { type: 'derived_artifact_ref' }>)
      .source_image_ids.push('img-2');
    expect(frozen[0]).toEqual({ type: 'text', text: 'same prompt' });
    expect((frozen[2] as Extract<CanonicalContentPart, { type: 'derived_artifact_ref' }>)
      .source_image_ids).toEqual(['img-1']);
  });

  it('generic_mm_remains_auxiliary_even_when_also_used_as_ocr_fallback', () => {
    const generic = modelConfig('generic-mm', true, true);
    const genericCandidate: OcrRuntimeCandidate = {
      kind: 'remote', config: generic, engineType: 'generic_vlm',
    };
    expect(isDedicatedOcrCandidate(genericCandidate)).toBe(false);

    // Only dedicated OCR engines belong in the exclusion set. A general MM
    // referenced by OCR settings stays eligible for visual observation.
    const dedicated = new Set(['dedicated-ocr']);
    expect(auxiliaryMmEligible(generic, 'active-tm', dedicated)).toBe(true);

    const reassigned = { ...generic, id: 'dedicated-ocr' };
    expect(auxiliaryMmEligible(reassigned, 'active-tm', dedicated)).toBe(false);
    expect(isDedicatedOcrCandidate({ kind: 'system_ocr' })).toBe(true);

    const inferredDedicated = {
      ...modelConfig('unassigned-deepseek-ocr', true, true),
      model: 'deepseek-ai/DeepSeek-OCR',
    };
    expect(generationModelKind(inferredDedicated, new Set())).toBeNull();
  });

  it('unavailable_requested_tm_reaches_an_available_mm_before_compilation', () => {
    const configs = [modelConfig('disabled-tm', false, false),
      modelConfig('available-mm', true, true)];
    const requested = requestedGenerationModel('disabled-tm', null, configs);
    expect(requested).toBe('text');

    const snapshot = emptySnapshot();
    snapshot.textModel = unavailableCapability();
    snapshot.multimodalModel = availableCapability();
    const plan = planGeneration(snapshot, requested, 'mixed');
    expect(plan.activeModel).toBe('multimodal');
    expect(plan.fallbackFrom).toBe('text');

    const active = selectGenerationConfig(configs, null, plan.activeModel!, new Set())!;
    expect(active.id).toBe('available-mm');
  });

  it('strict_persona_model_requires_exact_enabled_config_id', () => {
    const configs = [modelConfig('disabled-local', false, false),
      modelConfig('available-cloud', true, false)];
    const dedicated = new Set<string>();

    const missing = resolveStrictRequestedModel(true, 'missing-local', configs, dedicated);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('refusing to fall back');

    const disabled = resolveStrictRequestedModel(true, 'disabled-local', configs, dedicated);
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error).toContain('disabled');

    const exact = resolveStrictRequestedModel(true, 'available-cloud', configs, dedicated);
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.config!.id).toBe('available-cloud');

    const nonPersona = resolveStrictRequestedModel(false, 'missing-local', configs, dedicated);
    // Non-persona chat keeps its existing capability fallback behavior.
    expect(nonPersona).toEqual({ ok: true, config: null });
  });

  it('unavailable_requested_mm_reaches_tm_with_ocr_shape', () => {
    const configs = [modelConfig('disabled-mm', false, true),
      modelConfig('available-tm', true, false)];
    const requested = requestedGenerationModel('disabled-mm', null, configs);

    const snapshot = emptySnapshot();
    snapshot.textModel = availableCapability();
    snapshot.multimodalModel = unavailableCapability();
    snapshot.ocr = availableCapability();
    const plan = planGeneration(snapshot, requested, 'mixed');
    expect(plan.activeModel).toBe('text');
    expect(plan.route).toBe('ocr_then_text_model');

    const active = selectGenerationConfig(configs, null, plan.activeModel!, new Set())!;
    expect(active.id).toBe('available-tm');
  });

  it('chat_model_id_wins_over_background_model2_override', () => {
    const options: SendOptions = {
      modelId: 'active-chat-mm',
      model2OverrideId: 'background-tm',
    };
    expect(requestedActiveModelId(options)).toBe('active-chat-mm');
    expect(requestedActiveModelId({ ...options, modelId: '\u0085' })).toBe('background-tm');
    expect(requestedActiveModelId({ ...options, modelId: '\uFEFF' })).toBe('\uFEFF');
  });

  it('text_model_prefers_auxiliary_mm_then_ocr', () => {
    const snapshot = emptySnapshot();
    snapshot.textModel = availableCapability();
    snapshot.multimodalModel = availableCapability();
    snapshot.ocr = availableCapability();
    const plan = planGeneration(snapshot, 'text', 'mixed');
    expect(plan.route).toBe('multimodal_observation_then_text_model');
    expect(plan.usesOcr).toBe(false);

    snapshot.multimodalModel = unavailableCapability();
    const fallback = planGeneration(snapshot, 'text', 'mixed');
    expect(fallback.route).toBe('ocr_then_text_model');
    expect(fallback.usesOcr).toBe(true);
  });

  it('apply_send_overrides_writes_only_present_fields', () => {
    const config = modelConfig('cfg', true, false);
    const before = { ...config };
    applySendOverrides(config, { temperature: 0.25, topP: 0.9 });
    expect(config.temperature).toBe(Math.fround(0.25));
    expect(config.topPOverride).toBe(Math.fround(0.9));
    expect(config.maxOutputTokens).toBe(before.maxOutputTokens);
    expect(config.frequencyPenaltyOverride).toBeNull();
    expect(config.presencePenaltyOverride).toBeNull();

    applySendOverrides(config, {});
    expect(config.temperature).toBe(Math.fround(0.25));
  });
});
