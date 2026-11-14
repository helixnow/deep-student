import { describe, expect, it } from 'vitest';
import type { ModelAssignments, ModelProfile } from '../api.ts';
import {
  EmbeddingDefaults,
  type EmbeddingDefaultsStore,
} from '../src/embedding_defaults.ts';

// ------------------------------------------------------------------ 测试夹具

class MemoryEmbeddingStore implements EmbeddingDefaultsStore {
  readonly settings = new Map<string, string>();

  private readonly profiles: readonly ModelProfile[];

  constructor(profiles: readonly ModelProfile[]) {
    this.profiles = profiles;
  }

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  saveSetting(key: string, value: string): void {
    this.settings.set(key, value);
  }

  listEnabledProfiles(): readonly ModelProfile[] {
    return this.profiles;
  }
}

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: '',
    vendorId: 'vend-emb-test',
    label: 'New Model',
    model: '',
    providerScope: null,
    apiProtocol: null,
    modelAdapter: 'general',
    isMultimodal: false,
    isReasoning: false,
    isEmbedding: false,
    isReranker: false,
    isImageGeneration: false,
    supportsTools: false,
    supportsReasoning: false,
    status: 'enabled',
    enabled: true,
    maxOutputTokens: 8192,
    temperature: 0.7,
    reasoningEffort: null,
    reasoningMode: null,
    thinkingEnabled: false,
    thinkingBudget: null,
    includeThoughts: false,
    enableThinking: null,
    minP: null,
    topK: null,
    geminiApiVersion: null,
    isBuiltin: false,
    repetitionPenalty: null,
    reasoningSplit: null,
    effort: null,
    verbosity: null,
    isFavorite: false,
    maxTokensLimit: null,
    contextWindow: null,
    extraBody: null,
    ...overrides,
  };
}

/** `emb_test_profile`：文本嵌入 / 普通对话条目。 */
function embTestProfile(id: string, isEmbedding: boolean): ModelProfile {
  return makeProfile({
    id,
    label: 'EmbTest',
    model: isEmbedding ? 'test-embed-v1' : 'test-chat-v1',
    isEmbedding,
  });
}

/** `vl_emb_test_profile`：多模态嵌入条目。 */
function vlEmbTestProfile(id: string, isMultimodal: boolean): ModelProfile {
  return makeProfile({
    id,
    label: 'VL EmbTest',
    model: 'test-vl-embed-v1',
    isEmbedding: true,
    isMultimodal,
  });
}

function saveEmbeddingDefault(store: MemoryEmbeddingStore, id: string): void {
  store.saveSetting('embedding.default_text_model_config_id', id);
}

function savedEmbeddingDefault(store: MemoryEmbeddingStore): string | null {
  return store.getSetting('embedding.default_text_model_config_id');
}

function saveVlEmbeddingDefault(store: MemoryEmbeddingStore, id: string): void {
  store.saveSetting('embedding.default_multimodal_model_config_id', id);
}

function savedVlEmbeddingDefault(store: MemoryEmbeddingStore): string | null {
  return store.getSetting('embedding.default_multimodal_model_config_id');
}

function baseAssignments(): ModelAssignments {
  return {
    model2_config_id: null,
    review_analysis_model_config_id: null,
    anki_card_model_config_id: null,
    qbank_ai_grading_model_config_id: null,
    qbank_ai_generation_model_config_id: null,
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
  };
}

function saveAssignments(
  store: MemoryEmbeddingStore,
  overrides: Partial<ModelAssignments>,
): void {
  store.saveSetting('model_assignments', JSON.stringify({ ...baseAssignments(), ...overrides }));
}

function errorMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to fail');
}

// ------------------------------------------------------------------ 移植测试

describe('llm_manager/mod.rs', () => {
  it('dangling_embedding_default_falls_back_to_assignments_and_writes_back', async () => {
    const store = new MemoryEmbeddingStore([embTestProfile('emb-test', true)]);
    saveEmbeddingDefault(store, 'sf_1789015238478_dangling');
    saveAssignments(store, { embedding_model_config_id: 'emb-test' });

    const config = await new EmbeddingDefaults(store).getEmbeddingModelConfig();

    expect(config.id).toBe('emb-test');
    expect(config.isEmbedding).toBe(true);
    expect(savedEmbeddingDefault(store)).toBe('emb-test');
  });

  it('dangling_embedding_default_with_dangling_assignment_autodetects', async () => {
    const store = new MemoryEmbeddingStore([embTestProfile('emb-test', true)]);
    saveEmbeddingDefault(store, 'sf_1789015238478_dangling');
    saveAssignments(store, { embedding_model_config_id: 'vm_also_missing' });

    const config = await new EmbeddingDefaults(store).getEmbeddingModelConfig();

    expect(config.id).toBe('emb-test');
    expect(savedEmbeddingDefault(store)).toBe('emb-test');
  });

  it('dangling_embedding_default_without_any_embedding_config_errors', async () => {
    const store = new MemoryEmbeddingStore([embTestProfile('chat-only', false)]);
    saveEmbeddingDefault(store, 'sf_1789015238478_dangling');

    await expect(new EmbeddingDefaults(store).getEmbeddingModelConfig()).rejects.toThrow('未配置默认嵌入维度');
  });

  it('valid_embedding_default_is_used_as_is', async () => {
    const store = new MemoryEmbeddingStore([embTestProfile('emb-test', true)]);
    saveEmbeddingDefault(store, 'emb-test');

    const config = await new EmbeddingDefaults(store).getEmbeddingModelConfig();

    expect(config.id).toBe('emb-test');
    expect(savedEmbeddingDefault(store)).toBe('emb-test');
  });

  it('binding_a_multimodal_dimension_adopts_it_as_default_only_when_none_is_set', () => {
    const store = new MemoryEmbeddingStore([
      vlEmbTestProfile('vl-a', true),
      vlEmbTestProfile('vl-b', true),
      embTestProfile('emb-text', true),
    ]);
    const defaults = new EmbeddingDefaults(store);

    // 文本嵌入模型不能成为多模态默认
    expect(defaults.adoptDefaultMultimodalEmbedding(1024, 'emb-text')).toBe(false);
    expect(savedVlEmbeddingDefault(store)).toBeNull();

    expect(defaults.adoptDefaultMultimodalEmbedding(4096, 'vl-a')).toBe(true);
    expect(savedVlEmbeddingDefault(store)).toBe('vl-a');
    expect(store.getSetting('embedding.default_multimodal_dimension')).toBe('4096');
    expect(defaults.getVlEmbeddingModelConfig().id).toBe('vl-a');

    // 已有默认时不覆盖
    expect(defaults.adoptDefaultMultimodalEmbedding(2048, 'vl-b')).toBe(false);
    expect(savedVlEmbeddingDefault(store)).toBe('vl-a');
  });

  it('heal_adopts_the_only_bound_multimodal_dimension_but_never_guesses_between_two', () => {
    const store = new MemoryEmbeddingStore([
      vlEmbTestProfile('vl-a', true),
      vlEmbTestProfile('vl-b', true),
      embTestProfile('emb-text', true),
    ]);
    const defaults = new EmbeddingDefaults(store);

    // 两个可用候选：不替用户选
    const two: Array<[number, string]> = [
      [4096, 'vl-a'],
      [2048, 'vl-b'],
    ];
    expect(defaults.healDefaultMultimodalEmbedding(two)).toBe(false);
    expect(errorMessage(() => defaults.getVlEmbeddingModelConfig())).toContain(
      '还没有启用多模态索引',
    );

    // 只有一个可用（另一个绑的是文本模型 / 已删除的配置）：采用它
    const one: Array<[number, string]> = [
      [4096, 'vl-a'],
      [1024, 'emb-text'],
      [768, 'deleted'],
    ];
    expect(defaults.healDefaultMultimodalEmbedding(one)).toBe(true);
    expect(defaults.getVlEmbeddingModelConfig().id).toBe('vl-a');
  });

  it('dangling_vl_embedding_default_falls_back_to_assignments_and_writes_back', () => {
    const store = new MemoryEmbeddingStore([vlEmbTestProfile('vl-emb-test', true)]);
    saveVlEmbeddingDefault(store, 'vl_dangling');
    saveAssignments(store, { vl_embedding_model_config_id: 'vl-emb-test' });

    const config = new EmbeddingDefaults(store).getVlEmbeddingModelConfig();

    expect(config.id).toBe('vl-emb-test');
    expect(config.isEmbedding && config.isMultimodal).toBe(true);
    expect(savedVlEmbeddingDefault(store)).toBe('vl-emb-test');
  });

  it('missing_vl_embedding_default_uses_explicit_assignment', () => {
    const store = new MemoryEmbeddingStore([vlEmbTestProfile('vl-emb-test', true)]);
    saveAssignments(store, { vl_embedding_model_config_id: 'vl-emb-test' });

    const config = new EmbeddingDefaults(store).getVlEmbeddingModelConfig();

    expect(config.id).toBe('vl-emb-test');
    expect(savedVlEmbeddingDefault(store)).toBe('vl-emb-test');
  });

  it('dangling_vl_embedding_default_rejects_text_only_assignment', () => {
    const store = new MemoryEmbeddingStore([
      vlEmbTestProfile('vl-emb-test', true),
      embTestProfile('emb-test', true),
    ]);
    saveVlEmbeddingDefault(store, 'vl_dangling');
    saveAssignments(store, { vl_embedding_model_config_id: 'emb-test' });

    const message = errorMessage(() => new EmbeddingDefaults(store).getVlEmbeddingModelConfig());

    expect(message).toContain('找不到多模态嵌入模型配置');
    expect(savedVlEmbeddingDefault(store)).toBe('vl_dangling');
  });

  it('missing_vl_embedding_default_errors_without_autodetect', () => {
    const store = new MemoryEmbeddingStore([vlEmbTestProfile('vl-emb-test', true)]);

    const message = errorMessage(() => new EmbeddingDefaults(store).getVlEmbeddingModelConfig());

    expect(message).toContain('还没有启用多模态索引');
    expect(message).toContain('嵌入维度管理');
  });

  it('valid_vl_embedding_default_is_used_as_is', () => {
    const store = new MemoryEmbeddingStore([vlEmbTestProfile('vl-emb-test', true)]);
    saveVlEmbeddingDefault(store, 'vl-emb-test');

    const config = new EmbeddingDefaults(store).getVlEmbeddingModelConfig();

    expect(config.id).toBe('vl-emb-test');
  });
});
