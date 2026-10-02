import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (
      options?.count != null ? `${key}:${options.count}` : key
    ),
  }),
}));

vi.mock('../InputPanel', () => ({
  InputPanel: React.forwardRef<HTMLTextAreaElement, { onCollapse?: () => void }>(({ onCollapse }, _ref) => (
    <div data-testid="input-panel">
      {onCollapse && <button type="button" onClick={onCollapse}>collapse essay</button>}
    </div>
  )),
}));

vi.mock('../ResultPanel', () => ({
  ResultPanel: React.forwardRef<HTMLDivElement, { navigateRoundsInHeader?: boolean }>(({ navigateRoundsInHeader }, ref) => (
    <div ref={ref} data-testid="result-panel" data-rounds-in-header={String(Boolean(navigateRoundsInHeader))} />
  )),
}));

vi.mock('../InlineSettingsPanel', () => ({
  InlineSettingsPanel: () => null,
}));

vi.mock('../../shared/Resizable', () => ({
  HorizontalResizable: ({ left, right }: { left: React.ReactNode; right: React.ReactNode }) => (
    <div data-testid="split">{left}{right}</div>
  ),
  VerticalResizable: ({ top, bottom }: { top: React.ReactNode; bottom: React.ReactNode }) => (
    <div data-testid="stack">{top}{bottom}</div>
  ),
}));

vi.mock('@/features/workbench/apps/system/useWbSysSize', () => ({
  useWbSysSize: () => ({ ref: { current: null }, sizeClass: 'medium', heightClass: 'tall' }),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  registerBackHandler: () => () => {},
  BACK_PRIORITY: { overlay: 100 },
}));

import { GradingMain } from '../GradingMain';

type GradingMainProps = React.ComponentProps<typeof GradingMain>;

const baseProps = (overrides: Partial<GradingMainProps> = {}): GradingMainProps => ({
  inputText: 'Some people believe that university education should be free.',
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
  modelId: '',
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
  inputCharCount: 58,
  inputTextStats: {
    hanChars: 0,
    englishWords: 9,
    punctuationTotal: 1,
    cnPunctuation: 0,
    enPunctuation: 1,
    nonWhitespaceChars: 50,
    totalChars: 58,
    lineCount: 1,
    paragraphCount: 1,
  },
  uploadedImages: [],
  onRemoveImage: vi.fn(),
  topicText: '',
  setTopicText: vi.fn(),
  topicImages: [],
  onTopicFilesDropped: vi.fn(),
  onRemoveTopicImage: vi.fn(),
  gradingResult: '',
  resultCharCount: 0,
  onCopyResult: vi.fn(),
  onExportResult: vi.fn(),
  currentRound: 0,
  ...overrides,
});

describe('GradingMain results-first layout', () => {
  it('gives the whole area to the essay before grading and folds results into a placeholder', () => {
    render(<GradingMain {...baseProps()} />);

    expect(screen.getByTestId('input-panel')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'collapse essay' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('result-panel')).not.toBeInTheDocument();
    expect(screen.getByText('essay_grading:result_empty.title')).toBeInTheDocument();
  });

  it('collapses the essay into a summary line once grading starts and lets the user reopen it', () => {
    const { container, rerender } = render(<GradingMain {...baseProps({ isGrading: true })} />);

    expect(container.querySelector('[data-essay-input-summary]')).not.toBeNull();
    expect(screen.queryByTestId('input-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('result-panel')).toHaveAttribute('data-rounds-in-header', 'true');
    expect(screen.getByText('雅思大作文')).toBeInTheDocument();
    expect(screen.getByText('deepseek-v4')).toBeInTheDocument();

    rerender(<GradingMain {...baseProps({ gradingResult: '<section-annotation>done', currentRound: 1 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'essay_grading:input_summary.edit' }));

    expect(container.querySelector('[data-essay-input-summary]')).toBeNull();
    expect(screen.getByTestId('input-panel')).toBeInTheDocument();
    expect(screen.getByTestId('result-panel')).toHaveAttribute('data-rounds-in-header', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'collapse essay' }));
    expect(container.querySelector('[data-essay-input-summary]')).not.toBeNull();
  });

  it('folds a reopened essay back once the next grading round starts', () => {
    const graded = baseProps({ gradingResult: '<section-annotation>done', currentRound: 1 });
    const { container, rerender } = render(<GradingMain {...graded} />);

    fireEvent.click(screen.getByRole('button', { name: 'essay_grading:input_summary.edit' }));
    expect(screen.getByTestId('input-panel')).toBeInTheDocument();

    rerender(<GradingMain {...graded} isGrading gradingResult="" />);
    expect(container.querySelector('[data-essay-input-summary]')).not.toBeNull();
    expect(screen.queryByTestId('input-panel')).not.toBeInTheDocument();
  });
});
