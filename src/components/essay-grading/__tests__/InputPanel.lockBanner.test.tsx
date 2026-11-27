import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EssayTextStats } from '@/essay-grading/textStats';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'essay_grading:grading_lock.hint': '批改进行中，输入已暂时锁定',
      'essay_grading:actions.cancel_grading': '取消批改',
      'essay_grading:actions.grade': '开始批改',
    }[key] ?? key),
    i18n: { resolvedLanguage: 'zh-CN', language: 'zh-CN' },
  }),
}));

vi.mock('@/components/shared/UnifiedDragDropZone', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  FILE_TYPES: { IMAGE: 'image' },
}));

vi.mock('@/components/shared/UnifiedModelSelector', () => ({
  UnifiedModelSelector: () => <div data-testid="model-selector" />,
}));

vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../ui/shad/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../ui/app-menu', () => ({
  AppSelect: () => <div data-testid="app-select" />,
}));

import { InputPanel } from '../InputPanel';

const emptyStats: EssayTextStats = {
  hanChars: 0,
  englishWords: 0,
  punctuationTotal: 0,
  cnPunctuation: 0,
  enPunctuation: 0,
  nonWhitespaceChars: 0,
  totalChars: 0,
  lineCount: 0,
  paragraphCount: 0,
};

function makeProps(overrides: Partial<React.ComponentProps<typeof InputPanel>> = {}): React.ComponentProps<typeof InputPanel> {
  return {
    inputText: '',
    setInputText: vi.fn(),
    modeId: 'ielts',
    setModeId: vi.fn(),
    modes: [{
      id: 'ielts',
      name: '雅思大作文',
      description: '',
      system_prompt: '',
      score_dimensions: [],
      total_max_score: 9,
      is_builtin: true,
      created_at: '',
      updated_at: '',
    }],
    modelId: 'm1',
    setModelId: vi.fn(),
    models: [{ id: 'm1', name: 'deepseek-v4', model: 'deepseek-v4', is_default: true }],
    essayType: '',
    setEssayType: vi.fn(),
    gradeLevel: '',
    setGradeLevel: vi.fn(),
    isGrading: false,
    onFilesDropped: vi.fn(),
    ocrMaxFiles: 5,
    customPrompt: '',
    setCustomPrompt: vi.fn(),
    showPromptEditor: false,
    setShowPromptEditor: vi.fn(),
    onSavePrompt: vi.fn(),
    onRestoreDefaultPrompt: vi.fn(),
    onClear: vi.fn(),
    onGrade: vi.fn(),
    onCancelGrading: vi.fn(),
    charCount: 0,
    textStats: emptyStats,
    currentRound: 1,
    uploadedImages: [],
    ...overrides,
  };
}

describe('InputPanel idle lock banner & cancel guard', () => {
  it('never renders the grading-lock banner when idle and keeps empty submit disabled', () => {
    render(<InputPanel {...makeProps({ isGrading: false, inputText: '' })} />);

    expect(screen.queryByTestId('essay-grading-lock-banner')).toBeNull();
    expect(screen.queryByText('批改进行中，输入已暂时锁定')).toBeNull();
    expect(screen.getByTestId('essay-grade-submit-desktop')).toBeDisabled();
    expect(screen.getByTestId('essay-grade-submit-mobile')).toBeDisabled();
  });

  it('renders the lock banner without duplicate inline cancel button and cancels via the single footer control', () => {
    const onCancelGrading = vi.fn();
    render(
      <InputPanel
        {...makeProps({
          isGrading: true,
          inputText: 'Essay body content',
          charCount: 18,
          onCancelGrading,
        })}
      />,
    );

    const banner = screen.getByTestId('essay-grading-lock-banner');
    expect(banner).toHaveTextContent('批改进行中，输入已暂时锁定');
    expect(screen.queryByTestId('essay-cancel-grading-inline')).toBeNull();

    const cancelBtn = screen.getByTestId('essay-cancel-grading-footer');
    fireEvent.click(cancelBtn);
    fireEvent.click(screen.getByTestId('essay-cancel-grading-footer'));
    expect(onCancelGrading).toHaveBeenCalledTimes(1);
  });
});
