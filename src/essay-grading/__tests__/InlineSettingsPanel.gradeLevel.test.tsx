import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  recommendedGradeLevelForMode,
  shouldSuppressHighSchoolPollution,
} from '@/essay-grading/modeIds';
import { InlineSettingsPanel } from '@/components/essay-grading/InlineSettingsPanel';
import type { GradingMode } from '@/essay-grading/essayGradingApi';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      typeof opts?.defaultValue === 'string' ? opts.defaultValue : key,
    i18n: { language: 'zh-CN' },
  }),
}));
vi.mock('@/components/shared/UnifiedModelSelector', () => ({
  UnifiedModelSelector: () => <div data-testid="model-selector" />,
}));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

const MODES: GradingMode[] = [
  {
    id: 'practice',
    name: '高分范文批改',
    description: 'General essay practice',
    is_builtin: true,
    total_max_score: 100,
    score_dimensions: [],
    system_prompt: '',
    created_at: '',
    updated_at: '',
  },
  {
    id: 'ielts',
    name: '雅思 Task 2 (0–9 分)',
    description: 'IELTS 9-band rubric',
    is_builtin: true,
    total_max_score: 9,
    score_dimensions: [],
    system_prompt: '',
    created_at: '',
    updated_at: '',
  },
  {
    id: 'kaoyan_en',
    name: '考研英语作文',
    description: 'Kaoyan English writing',
    is_builtin: true,
    total_max_score: 20,
    score_dimensions: [],
    system_prompt: '',
    created_at: '',
    updated_at: '',
  },
  {
    id: 'my_custom_mode',
    name: '我的自定义模式',
    description: 'Custom rubric',
    is_builtin: false,
    total_max_score: 50,
    score_dimensions: [],
    system_prompt: 'Custom rubric prompt',
    created_at: '',
    updated_at: '',
  },
];

describe('Essay gradeLevel S3-02 pollution prevention', () => {
  beforeEach(() => {
    cleanup();
  });

  it('computes recommendedGradeLevelForMode and suppression flags accurately', () => {
    expect(recommendedGradeLevelForMode('ielts', true)).toBe('other');
    expect(recommendedGradeLevelForMode('ielts_task1', true)).toBe('other');
    expect(recommendedGradeLevelForMode('toefl', true)).toBe('other');
    expect(recommendedGradeLevelForMode('cet4', true)).toBe('college');
    expect(recommendedGradeLevelForMode('kaoyan_en', true)).toBe('college');
    expect(recommendedGradeLevelForMode('custom_rubric', false)).toBe('other');
    expect(recommendedGradeLevelForMode('gaokao', true)).toBe('high_school');

    expect(
      shouldSuppressHighSchoolPollution({ modeId: 'ielts', isBuiltin: true }),
    ).toBe(true);
    expect(
      shouldSuppressHighSchoolPollution({ modeId: 'practice', isBuiltin: false }),
    ).toBe(true);
    expect(
      shouldSuppressHighSchoolPollution({
        modeId: 'practice',
        isBuiltin: true,
        hasCustomPrompt: true,
      }),
    ).toBe(true);
    expect(
      shouldSuppressHighSchoolPollution({ modeId: 'gaokao', isBuiltin: true }),
    ).toBe(false);
  });

  it('auto-updates gradeLevel when switching to IELTS or custom mode inside InlineSettingsPanel', () => {
    const setModeId = vi.fn();
    const setGradeLevel = vi.fn();

    render(
      <InlineSettingsPanel
        isOpen={true}
        onClose={vi.fn()}
        modeId="practice"
        setModeId={setModeId}
        modes={MODES}
        modelId="model-1"
        setModelId={vi.fn()}
        models={[]}
        customPrompt=""
        setCustomPrompt={vi.fn()}
        onSavePrompt={vi.fn()}
        onRestoreDefaultPrompt={vi.fn()}
        essayType="argumentative"
        setEssayType={vi.fn()}
        gradeLevel="high_school"
        setGradeLevel={setGradeLevel}
      />,
    );

    fireEvent.click(screen.getByText('雅思 Task 2 (0–9 分)'));
    expect(setModeId).toHaveBeenCalledWith('ielts');
    expect(setGradeLevel).toHaveBeenCalledWith('other');

    setModeId.mockClear();
    setGradeLevel.mockClear();
    fireEvent.click(screen.getByText('考研英语作文'));
    expect(setModeId).toHaveBeenCalledWith('kaoyan_en');
    expect(setGradeLevel).toHaveBeenCalledWith('college');

    setModeId.mockClear();
    setGradeLevel.mockClear();
    fireEvent.click(screen.getByText('我的自定义模式'));
    expect(setModeId).toHaveBeenCalledWith('my_custom_mode');
    expect(setGradeLevel).toHaveBeenCalledWith('other');
  });

  it('creates, persists to localStorage, and selects a custom rubric in Section 1 (S3-02)', async () => {
    window.localStorage.clear();
    const {
      LOCAL_CUSTOM_RUBRICS_STORAGE_KEY,
      mergeModesWithLocalCustom,
      resolveBackendGradingPayload,
    } = await import('../modeIds');
    const setModeId = vi.fn();
    const onModesChange = vi.fn();

    render(
      <InlineSettingsPanel
        isOpen={true}
        onClose={vi.fn()}
        modeId="practice"
        setModeId={setModeId}
        modes={MODES}
        modelId="model-1"
        setModelId={vi.fn()}
        models={[]}
        customPrompt=""
        setCustomPrompt={vi.fn()}
        onSavePrompt={vi.fn()}
        onRestoreDefaultPrompt={vi.fn()}
        onModesChange={onModesChange}
        essayType="argumentative"
        setEssayType={vi.fn()}
        gradeLevel="high_school"
        setGradeLevel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('essay-custom-rubric-trigger'));
    fireEvent.change(screen.getByTestId('custom-rubric-name-input'), {
      target: { value: '英语读后续写自定标准' },
    });
    fireEvent.change(screen.getByTestId('custom-rubric-score-input'), {
      target: { value: '25' },
    });
    fireEvent.change(screen.getByTestId('custom-rubric-prompt-input'), {
      target: { value: '重点考查情节连贯性与动词细节描写。' },
    });
    fireEvent.click(screen.getByTestId('custom-rubric-save-button'));

    expect(onModesChange).toHaveBeenCalledTimes(1);
    expect(setModeId).toHaveBeenCalledTimes(1);
    const savedId = setModeId.mock.calls[0]![0] as string;
    expect(savedId.startsWith('local_custom_')).toBe(true);
    expect(window.localStorage.getItem(LOCAL_CUSTOM_RUBRICS_STORAGE_KEY)).toContain(
      '英语读后续写自定标准',
    );

    const merged = mergeModesWithLocalCustom(MODES);
    const createdMode = merged.find((m) => m.id === savedId);
    expect(createdMode?.total_max_score).toBe(25);

    const payload = resolveBackendGradingPayload({
      modeId: savedId,
      activeMode: createdMode,
      customPrompt: '',
      defaultPromptText: '',
    });
    expect(payload.modeIdForBackend).toBe('practice');
    expect(payload.customPromptForBackend).toContain('英语读后续写自定标准');
    expect(payload.customPromptForBackend).toContain('重点考查情节连贯性与动词细节描写');
  });
});
