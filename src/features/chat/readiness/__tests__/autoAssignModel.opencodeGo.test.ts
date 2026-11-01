/**
 * 一键分配遵守「OpenCode Go 仅限 Agent 对话」：Go 模型只能进对话默认模型 / 会话标题槽位，
 * 不能进制卡、批改、出题、翻译、记忆决策、试卷 OCR 槽位，也不注册为 OCR 引擎。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, saved } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saved: { assignments: null as null | Record<string, unknown>, ocrAdded: [] as string[] },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { autoAssignAllModels } from '../autoAssignModel';

const base = { enabled: true, apiKey: 'k', isReasoning: false, isReranker: false, isEmbedding: false };
const CONFIGS = [
  // Go 排在前面：若未过滤，会被优先选中
  {
    ...base,
    id: 'go-gpt',
    name: 'GPT 6 Luna (Go)',
    model: 'gpt-6-luna',
    vendorId: 'builtin-opencode-go',
    providerType: 'opencode_go',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    isMultimodal: true,
  },
  { ...base, id: 'ds', name: 'DeepSeek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', isMultimodal: false },
  { ...base, id: 'vl', name: 'Qwen VL', model: 'qwen3-vl-plus', baseUrl: 'https://dashscope.aliyuncs.com/v1', isMultimodal: true },
];

describe('autoAssignAllModels · OpenCode Go', () => {
  beforeEach(() => {
    saved.assignments = null;
    saved.ocrAdded = [];
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string, args?: { assignments?: Record<string, unknown>; configId?: string }) => {
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
        case 'add_ocr_engine':
          if (args?.configId) saved.ocrAdded.push(args.configId);
          return true;
        default:
          return undefined;
      }
    });
  });

  it('keeps Go out of non-agent slots and OCR engines', async () => {
    await autoAssignAllModels();
    const assignments = saved.assignments ?? {};
    for (const field of [
      'anki_card_model_config_id',
      'qbank_ai_grading_model_config_id',
      'qbank_ai_generation_model_config_id',
      'translation_model_config_id',
      'memory_decision_model_config_id',
      'exam_sheet_ocr_model_config_id',
    ]) {
      expect(assignments[field], field).not.toBe('go-gpt');
    }
    expect(assignments.anki_card_model_config_id).toBe('ds');
    expect(saved.ocrAdded).not.toContain('go-gpt');
  });
});
