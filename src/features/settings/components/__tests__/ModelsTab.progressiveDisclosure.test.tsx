/**
 * ModelsTab 渐进折叠（核心学习模型常显 + 专项模型折叠与已配置计数徽标）单元测试
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockInvoke = vi.hoisted(() => vi.fn());
const mockTranslate = vi.hoisted(() =>
  vi.fn((key: string, opts?: Record<string, unknown> | string) => {
    if (opts && typeof opts === 'object' && 'configured' in opts && 'total' in opts) {
      return `${key}:${String(opts.configured)}/${String(opts.total)}`;
    }
    return key;
  }),
);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: mockTranslate }),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('../DimensionManagement', () => ({
  DimensionManagement: () => <div data-testid="mock-dimension-management">DimensionManagement</div>,
}));

vi.mock('../OcrEngineCard', () => ({
  OcrEngineCard: () => <div data-testid="mock-ocr-engine-card">OcrEngineCard</div>,
}));

vi.mock('@/components/shared/UnifiedModelSelector', () => ({
  UnifiedModelSelector: ({
    value,
    placeholder,
    onChange,
  }: {
    value: string;
    placeholder: string;
    onChange: (next: string) => void;
  }) => (
    <select
      aria-label={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      <option value="api-1">DeepSeek-V3</option>
    </select>
  ),
}));

vi.mock('@/features/learning-hub/embeddingReadiness', () => ({
  useEmbeddingReadiness: () => 'ready',
  isVectorIndexUnavailable: () => false,
}));

import { ModelsTab } from '@/features/settings/components/ModelsTab';
import type { ApiConfig } from '@/types';

const sampleApi: ApiConfig = {
  id: 'api-1',
  name: 'DeepSeek-V3',
  apiKey: 'sk-test',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  enabled: true,
} as ApiConfig;

function makeBaseProps(overrides: Partial<React.ComponentProps<typeof ModelsTab>['config']> = {}) {
  const saveSingleAssignmentField = vi.fn(async (field: string, value: string | null) => ({
    [field]: value,
  }));
  const setConfig = vi.fn();
  return {
    config: {
      model2ConfigId: 'api-1',
      ankiCardModelConfigId: 'api-1',
      qbank_ai_grading_model_config_id: '',
      qbank_ai_generation_model_config_id: '',
      rerankerModelConfigId: 'api-1',
      vl_reranker_model_config_id: '',
      chat_title_model_config_id: 'api-1',
      exam_sheet_ocr_model_config_id: '',
      translation_model_config_id: 'api-1',
      translation_display_mode: 'aligned' as const,
      memory_decision_model_config_id: '',
      voice_input_asr_model_config_id: '',
      image_generation_model_config_id: '',
      compaction_model_config_id: '',
      ...overrides,
    },
    setConfig,
    apiConfigs: [sampleApi],
    toUnifiedModelInfo: (apis: ApiConfig[]) =>
      apis.map((a) => ({ id: a.id, name: a.name })),
    getAllEnabledApis: () => [sampleApi],
    getEmbeddingApis: () => [sampleApi],
    getRerankerApis: () => [],
    getAsrApis: () => [],
    getImageGenerationApis: () => [],
    saveSingleAssignmentField,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue('deepseek-ocr');
});

describe('ModelsTab 渐进折叠与核心学习槽位分层', () => {
  it('默认常显核心学习模型与 OCR/知识库检索，专项模型折叠并展示「已配置 X/8」徽标', () => {
    render(<ModelsTab {...makeBaseProps()} />);

    // 核心学习槽位常显
    expect(screen.getByTestId('core-study-models-section')).toBeInTheDocument();
    expect(screen.getByText('settings:cards.model2_title')).toBeInTheDocument();
    expect(screen.getByText('settings:api_config.chat_title_model_label')).toBeInTheDocument();
    expect(screen.getByText('settings:api.anki_card_title')).toBeInTheDocument();
    expect(screen.getByText('settings:cards.qbank_ai_grading_model_title')).toBeInTheDocument();

    // OCR 与知识库向量索引常显
    expect(screen.getByTestId('mock-ocr-engine-card')).toBeInTheDocument();
    expect(screen.getByTestId('mock-dimension-management')).toBeInTheDocument();

    // 专项模型默认收起，徽标展示 2/8（translation + reranker 已配置）
    const toggleBtn = screen.getByTestId('specialized-models-toggle');
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('specialized-models-badge')).toHaveTextContent(
      'settings:models_tab.specialized_configured_badge:2/8',
    );
    expect(screen.queryByTestId('specialized-models-panel')).not.toBeInTheDocument();
    expect(
      screen.queryByText('settings:api_config.compaction_model_label'),
    ).not.toBeInTheDocument();
  });

  it('未配置任何专项槽位时徽标显示 0/8', () => {
    render(
      <ModelsTab
        {...makeBaseProps({
          rerankerModelConfigId: '',
          translation_model_config_id: '',
        })}
      />,
    );

    expect(screen.getByTestId('specialized-models-badge')).toHaveTextContent(
      'settings:models_tab.specialized_configured_badge:0/8',
    );
  });

  it('点击展开后显示全部 8 个专项模型槽位及翻译显示模式，可正常保存并再次收起', async () => {
    const user = userEvent.setup();
    const props = makeBaseProps();
    render(<ModelsTab {...props} />);

    const toggleBtn = screen.getByTestId('specialized-models-toggle');
    await user.click(toggleBtn);

    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('specialized-models-panel')).toBeInTheDocument();

    // 8 个专项模型槽位 + 翻译显示模式全部可见
    expect(screen.getByText('settings:cards.qbank_ai_generation_model_title')).toBeInTheDocument();
    expect(screen.getByText('settings:cards.translation_model_title')).toBeInTheDocument();
    expect(screen.getByText('settings:cards.translation_display_mode_title')).toBeInTheDocument();
    expect(screen.getByText('settings:cards.voice_input_asr_title')).toBeInTheDocument();
    expect(screen.getByText('settings:cards.image_generation_model_title')).toBeInTheDocument();
    expect(screen.getByText('settings:api_config.memory_decision_model_label')).toBeInTheDocument();
    expect(screen.getByText('settings:api_config.compaction_model_label')).toBeInTheDocument();
    expect(screen.getByText('settings:cards.reranker_title')).toBeInTheDocument();
    expect(screen.getByText('settings:cards.vl_reranker_title')).toBeInTheDocument();

    // 切换翻译显示模式触发保存
    await user.click(screen.getByText('settings:cards.translation_display_mode_streaming'));
    expect(props.saveSingleAssignmentField).toHaveBeenCalledWith(
      'translation_display_mode',
      'streaming',
    );

    // 再次点击收起
    await user.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('specialized-models-panel')).not.toBeInTheDocument();
  });
});
