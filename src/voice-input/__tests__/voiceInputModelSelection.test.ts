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
    name: overrides.name ?? 'SiliconFlow - Qwen/Qwen3-ASR-1.7B',
    vendorId: overrides.vendorId ?? 'vendor-sf',
    vendorName: overrides.vendorName ?? 'SiliconFlow',
    providerType: overrides.providerType ?? 'siliconflow',
    providerScope: overrides.providerScope ?? 'siliconflow',
    apiKey: overrides.apiKey ?? '***',
    baseUrl: overrides.baseUrl ?? 'https://api.siliconflow.cn/v1',
    model: overrides.model ?? 'Qwen/Qwen3-ASR-1.7B',
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
    compaction_model_config_id: null,
    translation_display_mode: null,
    ...overrides,
  };
}

describe('voice input model selection', () => {
  it('exposes ASR models from any OpenAI-compatible provider, relays included', () => {
    const apis = [
      createApiConfig({ id: 'sf-asr' }),
      createApiConfig({
        id: 'sf-xingchen',
        model: 'XingChenAGI/XingChenASR-V3.2-Ultra',
        name: 'SiliconFlow - XingChenAGI/XingChenASR-V3.2-Ultra',
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
      createApiConfig({
        id: 'dashscope-asr',
        providerType: 'qwen',
        providerScope: 'qwen',
        apiProtocol: 'openai_chat_completions',
        model: 'qwen3-asr-flash',
        name: 'qwen3-asr-flash',
      }),
      createApiConfig({
        id: 'relay-asr',
        providerType: 'custom',
        providerScope: undefined,
        model: 'relay-gw_qwen3-asr-flash-2026-02-10',
        name: 'relay-gw_qwen3-asr-flash-2026-02-10',
      }),
    ];

    expect(getAssignableVoiceInputApis(apis).map((api) => api.id)).toEqual([
      'sf-asr',
      'sf-xingchen',
      'openai-asr',
      'dashscope-asr',
      'relay-asr',
    ]);
  });

  it('keeps unusable ASR models visible but disabled in assignment lists', () => {
    const apis = [
      createApiConfig({ id: 'sf-asr' }),
      createApiConfig({
        id: 'dashscope-realtime',
        providerType: 'qwen',
        providerScope: 'qwen',
        model: 'qwen3-asr-flash-realtime',
        name: 'qwen3-asr-flash-realtime',
      }),
      createApiConfig({
        id: 'anthropic-asr',
        providerType: 'anthropic',
        providerScope: 'anthropic',
        apiProtocol: 'anthropic_messages',
        model: 'whisper-1',
        name: 'whisper-1',
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
        id: 'dashscope-realtime',
        disabled: true,
        disabledReason: 'provider-unavailable',
      },
      {
        id: 'anthropic-asr',
        disabled: true,
        disabledReason: 'provider-unavailable',
      },
    ]);
  });

  it('keeps disabled ASR models visible so users can see why they are not assignable', () => {
    const apis = [
      createApiConfig({
        id: 'sf-asr-disabled',
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
    const apis = [createApiConfig({ id: 'sf-asr' })];

    expect(resolveVoiceInputModelAssignment(assignments, apis)).toEqual({
      status: 'ready',
      configId: 'sf-asr',
      providerId: 'siliconflow',
      providerLabel: 'SiliconFlow',
      model: 'Qwen/Qwen3-ASR-1.7B',
      modelLabel: 'SiliconFlow - Qwen/Qwen3-ASR-1.7B',
      disabled: false,
    });
  });

  it('resolves a relay-hosted ASR model as a ready target', () => {
    const assignments = createAssignments({
      voice_input_asr_model_config_id: 'relay-asr',
    });
    const apis = [
      createApiConfig({
        id: 'relay-asr',
        vendorName: '统一出口',
        providerType: 'custom',
        providerScope: undefined,
        baseUrl: 'http://relay.example.test/v1',
        model: 'Qwen/Qwen3-ASR-0.6B',
        name: 'Qwen/Qwen3-ASR-0.6B',
      }),
    ];

    expect(resolveVoiceInputModelAssignment(assignments, apis)).toMatchObject({
      status: 'ready',
      configId: 'relay-asr',
      providerId: 'custom',
      providerLabel: '统一出口',
      model: 'Qwen/Qwen3-ASR-0.6B',
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

  it('surfaces unusable transports instead of pretending the assignment is usable', () => {
    const assignments = createAssignments({
      voice_input_asr_model_config_id: 'dashscope-filetrans',
    });
    const apis = [
      createApiConfig({
        id: 'dashscope-filetrans',
        vendorName: '通义千问',
        providerType: 'qwen',
        providerScope: 'qwen',
        model: 'qwen3-asr-flash-filetrans',
        name: 'qwen3-asr-flash-filetrans',
      }),
    ];

    expect(resolveVoiceInputModelAssignment(assignments, apis)).toEqual({
      status: 'provider-unavailable',
      configId: 'dashscope-filetrans',
      providerId: 'qwen',
      providerLabel: '通义千问',
      model: 'qwen3-asr-flash-filetrans',
      modelLabel: 'qwen3-asr-flash-filetrans',
      disabled: false,
    });
  });
});
