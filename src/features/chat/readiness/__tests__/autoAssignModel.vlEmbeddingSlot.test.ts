/**
 * 多模态嵌入槽位（vl_embedding_model_config_id）不得被自动分配写入。
 *
 * 背景：该槽位与文本嵌入槽位曾共用 `isEmbeddingModel` 过滤器——只要求
 * 「已启用 + isEmbedding + 非 reranker」，**不要求 is_multimodal**。于是首个
 * 可用嵌入模型（通常是 bge-m3 这类纯文本模型）会被写进 VL 槽，而后端
 * `get_vl_embedding_model_config` 明确拒绝「非多模态」的绑定，导致：
 *   1. 二级回退链永远命中一个不可用配置；
 *   2. 报错从「未设置默认多模态维度」退化成「找不到多模态嵌入模型配置」。
 * 而多模态索引按页调用付费接口，必须由用户显式开启（模型分配页已不再暴露
 * 该槽位，因此自动分配写入的值也不代表用户的显式选择）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, ModelAssignments } from '@/types';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { autoAssignAllModels } from '../autoAssignModel';

const embeddingApi = (over: Partial<ApiConfig> & { id: string; model: string }): ApiConfig =>
  ({
    name: over.model,
    enabled: true,
    isEmbedding: true,
    isReranker: false,
    isMultimodal: false,
    isImageGeneration: false,
    ...over,
  }) as ApiConfig;

const textEmbedding = embeddingApi({ id: 'emb-text', model: 'BAAI/bge-m3' });
const vlEmbedding = embeddingApi({
  id: 'emb-vl',
  model: 'Qwen/Qwen3-VL-Embedding-8B',
  isMultimodal: true,
});

const emptyAssignments: ModelAssignments = {
  model2_config_id: null,
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
  review_analysis_model_config_id: null,
  voice_input_asr_model_config_id: null,
  image_generation_model_config_id: null,
  compaction_model_config_id: null,
  translation_display_mode: null,
};

let savedAssignments: ModelAssignments | null = null;

const runAutoAssign = async (apis: ApiConfig[]) => {
  savedAssignments = null;
  invokeMock.mockImplementation((command: string, payload?: unknown) => {
    switch (command) {
      case 'get_model_assignments':
        return Promise.resolve({ ...emptyAssignments });
      case 'get_api_configurations':
        return Promise.resolve(apis);
      case 'get_available_ocr_models':
        return Promise.resolve([]);
      case 'save_model_assignments':
        savedAssignments = (payload as { assignments: ModelAssignments }).assignments;
        return Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  });
  return autoAssignAllModels();
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe('autoAssignAllModels · 多模态嵌入槽位', () => {
  it('不会把纯文本嵌入模型写进 vl_embedding_model_config_id', async () => {
    const result = await runAutoAssign([textEmbedding]);

    // 文本嵌入槽位仍应被正常填充（自动分配的核心价值不变）
    expect(savedAssignments?.embedding_model_config_id).toBe('emb-text');
    // VL 槽位必须保持为空：写入文本嵌入模型会让后端回退链命中不可用配置
    expect(savedAssignments?.vl_embedding_model_config_id).toBeNull();
    expect(result.assigned).toBe(true);
  });

  it('即使存在可用的多模态嵌入模型，也不替用户隐式开启多模态索引', async () => {
    await runAutoAssign([textEmbedding, vlEmbedding]);

    expect(savedAssignments?.embedding_model_config_id).toBe('emb-text');
    // 多模态索引按页计费：必须由用户在「嵌入维度管理」显式设为默认
    expect(savedAssignments?.vl_embedding_model_config_id).toBeNull();
  });
});
