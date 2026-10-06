/**
 * 一键分配不碰多模态嵌入槽位：多模态索引按页付费，只能在「嵌入维度管理」里显式开启；
 * 此前该槽位按「是嵌入模型」筛选，会把纯文本嵌入模型（如 bge-m3）写进去，后端随即拒绝。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, saved } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saved: { assignments: null as null | Record<string, unknown> },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { autoAssignAllModels } from '../autoAssignModel';

const base = { enabled: true, apiKey: 'k', baseUrl: 'https://x', isReasoning: false, isReranker: false };
const CONFIGS = [
  { ...base, id: 'chat', name: 'chat', model: 'deepseek-chat', isMultimodal: false, isEmbedding: false },
  { ...base, id: 'bge', name: 'bge-m3', model: 'BAAI/bge-m3', isMultimodal: false, isEmbedding: true },
  { ...base, id: 'vl-emb', name: 'Qwen3-VL-Embedding', model: 'Qwen/Qwen3-VL-Embedding-8B', isMultimodal: true, isEmbedding: true },
];

describe('autoAssignAllModels · multimodal embedding slot', () => {
  beforeEach(() => {
    saved.assignments = null;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string, args?: { assignments?: Record<string, unknown> }) => {
      switch (cmd) {
        case 'get_model_assignments':
          return {};
        case 'get_api_configurations':
          return CONFIGS;
        case 'save_model_assignments':
          saved.assignments = args?.assignments ?? null;
          return undefined;
        case 'get_available_ocr_models':
          return [];
        default:
          return undefined;
      }
    });
  });

  it('fills the text embedding slot but never the multimodal one', async () => {
    await autoAssignAllModels();
    expect(saved.assignments).not.toBeNull();
    expect(saved.assignments?.embedding_model_config_id).toBe('bge');
    expect(saved.assignments?.vl_embedding_model_config_id).toBeUndefined();
  });
});
