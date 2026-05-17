import { describe, expect, it } from 'vitest';

import type { ApiConfig, ModelAssignments } from '@/types';

import {
  getAssignableVoiceInputApis,
  getVisibleVoiceInputApis,
  resolveVoiceInputModelAssignment,
} from '../modelSelection';

function createApiConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id: overrides.id ?? 'cfg-1',
    name: overrides.name ?? 'SiliconFlow - TeleAI/TeleSpeechASR',
    vendorId: overrides.vendorId ?? 'vendor-sf',
    vendorName: overrides.vendorName ?? 'SiliconFlow',
    providerType: overrides.providerType ?? 'siliconflow',
    providerScope: overrides.providerScope ?? 'siliconflow',
    apiKey: overrides.apiKey ?? '***',
    baseUrl: overrides.baseUrl ?? 'https://api.siliconflow.cn/v1',
    model: overrides.model ?? 'TeleAI/TeleSpeechASR',
    isMultimodal: overrides.isMultimodal ?? false,
    isReasoning: overrides.isReasoning ?? false,
    isEmbedding: overrides.isEmbedding ?? false,
    isReranker: overrides.isReranker ?? false,
    enabled: overrides.enabled ?? true,
    modelAdapter: overrides.modelAdapter ?? 'general',
    supportsTools: overrides.supportsTools ?? false,
    ...overrides,
  };
}

function createAssignments(
  overrides: Partial<ModelAssignments> = {}
): ModelAssignments {
  return {
    model2_config_id: null,
    anki_card_model_config_id: null,
    qbank_ai_grading_model_config_id: null,
    embedding_model_config_id: null,
    reranker_model_config_id: null,
    chat_title_model_config_id: null,
    exam_sheet_ocr_model_config_id: null,
    translation_model_config_id: null,
    vl_embedding_model_config_id: null,
    vl_reranker_model_config_id: null,
    memory_decision_model_config_id: null,
    voice_input_asr_model_config_id: null,
    image_generation_model_config_id: null,
    translation_display_mode: null,
    ...overrides,
  };
}

describe('voice input model selection', () => {
  it('only exposes runtime-compatible ASR models in assignment lists', () => {
    const apis = [
      createApiConfig({
        id: 'sf-asr',
        model: 'TeleAI/TeleSpeechASR',
        name: 'SiliconFlow - TeleAI/TeleSpeechASR',
      }),
      createApiConfig({
        id: 'sf-text',
        model: 'deepseek-ai/DeepSeek-V3.2',
        name: 'SiliconFlow - DeepSeek V3.2',
      }),
      createApiConfig({
        id: 'openai-asr',
        providerType: 'openai',
        providerScope: 'openai',
        model: 'gpt-4o-mini-transcribe',
        name: 'OpenAI - gpt-4o-mini-transcribe',
      }),
    ];

    expect(getAssignableVoiceInputApis(apis).map((api) => api.id)).toEqual(['sf-asr']);
  });

  it('keeps unsupported ASR models visible but disabled in assignment lists', () => {
    const apis = [
      createApiConfig({
        id: 'sf-asr',
        model: 'TeleAI/TeleSpeechASR',
        name: 'SiliconFlow - TeleAI/TeleSpeechASR',
      }),
      createApiConfig({
        id: 'openai-asr',
        providerType: 'openai',
        providerScope: 'openai',
        vendorName: 'OpenAI',
        model: 'gpt-4o-mini-transcribe',
        name: 'OpenAI - gpt-4o-mini-transcribe',
      }),
    ];

    expect(
      getVisibleVoiceInputApis(apis).map((api) => ({
        id: api.id,
        disabled: api._isDisabledInList ?? false,
        disabledReason: api._voiceInputDisabledReason ?? null,
      }))
    ).toEqual([
      {
        id: 'sf-asr',
        disabled: false,
        disabledReason: null,
      },
      {
        id: 'openai-asr',
        disabled: true,
        disabledReason: 'provider-unavailable',
      },
    ]);
  });

  it('keeps disabled ASR models visible so users can see why they are not assignable', () => {
    const apis = [
      createApiConfig({
        id: 'sf-asr-disabled',
        model: 'TeleAI/TeleSpeechASR',
        name: 'SiliconFlow - TeleAI/TeleSpeechASR',
        enabled: false,
      }),
    ];

    expect(
      getVisibleVoiceInputApis(apis).map((api) => ({
        id: api.id,
        disabled: api._isDisabledInList ?? false,
        disabledReason: api._voiceInputDisabledReason ?? null,
      }))
    ).toEqual([
      {
        id: 'sf-asr-disabled',
        disabled: true,
        disabledReason: 'model-disabled',
      },
    ]);
  });

  it('resolves the assigned ASR model into a runtime transcription target', () => {
    const assignments = createAssignments({
      voice_input_asr_model_config_id: 'sf-asr',
    });
    const apis = [
      createApiConfig({
        id: 'sf-asr',
        model: 'TeleAI/TeleSpeechASR',
        name: 'SiliconFlow - TeleAI/TeleSpeechASR',
      }),
    ];

    expect(resolveVoiceInputModelAssignment(assignments, apis)).toEqual({
      status: 'ready',
      configId: 'sf-asr',
      providerId: 'siliconflow',
      providerLabel: 'SiliconFlow',
      model: 'TeleAI/TeleSpeechASR',
      modelLabel: 'SiliconFlow - TeleAI/TeleSpeechASR',
      disabled: false,
    });
  });

  it('surfaces a clear missing-assignment state when no ASR model is configured', () => {
    expect(
      resolveVoiceInputModelAssignment(createAssignments(), [
        createApiConfig({ id: 'sf-asr' }),
      ])
    ).toEqual({
      status: 'model-assignment-required',
    });
  });

  it('surfaces unsupported providers instead of pretending the assignment is usable', () => {
    const assignments = createAssignments({
      voice_input_asr_model_config_id: 'openai-asr',
    });
    const apis = [
      createApiConfig({
        id: 'openai-asr',
        providerType: 'openai',
        providerScope: 'openai',
        model: 'gpt-4o-mini-transcribe',
        name: 'OpenAI - gpt-4o-mini-transcribe',
      }),
    ];

    expect(resolveVoiceInputModelAssignment(assignments, apis)).toEqual({
      status: 'provider-unavailable',
      configId: 'openai-asr',
      providerId: 'openai',
      providerLabel: 'OpenAI',
      model: 'gpt-4o-mini-transcribe',
      modelLabel: 'OpenAI - gpt-4o-mini-transcribe',
      disabled: false,
    });
  });
});
