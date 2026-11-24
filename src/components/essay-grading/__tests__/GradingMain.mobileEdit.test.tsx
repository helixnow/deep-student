import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../InputPanel', () => ({
  InputPanel: React.forwardRef<HTMLTextAreaElement, { onCollapse?: () => void }>(({ onCollapse }, _ref) => (
    <div data-testid="input-panel">
      {onCollapse && (
        <button type="button" onClick={onCollapse}>
          collapse essay
        </button>
      )}
    </div>
  )),
}));

vi.mock('../ResultPanel', () => ({
  ResultPanel: React.forwardRef<HTMLDivElement, Record<string, unknown>>((_props, ref) => (
    <div ref={ref} data-testid="result-panel" />
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
  useWbSysSize: () => ({ ref: { current: null }, sizeClass: 'compact', heightClass: 'tall' }),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: true }),
}));

vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  registerBackHandler: () => () => {},
  BACK_PRIORITY: { overlay: 100 },
}));

import { GradingMain } from '../GradingMain';

describe('GradingMain compact 360px edit toggle (S3-17)', () => {
  it('switches mutually exclusively between result report and essay editor without stacking', () => {
    render(
      <GradingMain
        inputText="My sample essay"
        setInputText={vi.fn()}
        modeId="practice"
        setModeId={vi.fn()}
        modes={[]}
        modelId=""
        setModelId={vi.fn()}
        models={[]}
        essayType=""
        setEssayType={vi.fn()}
        gradeLevel=""
        setGradeLevel={vi.fn()}
        isGrading={false}
        onFilesDropped={vi.fn()}
        ocrMaxFiles={5}
        customPrompt=""
        setCustomPrompt={vi.fn()}
        showPromptEditor={false}
        setShowPromptEditor={vi.fn()}
        onSavePrompt={vi.fn()}
        onRestoreDefaultPrompt={vi.fn()}
        onClear={vi.fn()}
        onGrade={vi.fn()}
        onCancelGrading={vi.fn()}
        inputCharCount={15}
        inputTextStats={{
          hanChars: 0,
          englishWords: 3,
          punctuationTotal: 0,
          cnPunctuation: 0,
          enPunctuation: 0,
          nonWhitespaceChars: 13,
          totalChars: 15,
          lineCount: 1,
          paragraphCount: 1,
        }}
        uploadedImages={[]}
        onRemoveImage={vi.fn()}
        topicText=""
        setTopicText={vi.fn()}
        topicImages={[]}
        onTopicFilesDropped={vi.fn()}
        onRemoveTopicImage={vi.fn()}
        gradingResult="<score total='71'/>report"
        resultCharCount={30}
        onCopyResult={vi.fn()}
        onExportResult={vi.fn()}
        currentRound={1}
      />,
    );

    // Initially result is shown with summary bar, editor hidden
    expect(screen.getByTestId('result-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('input-panel')).not.toBeInTheDocument();

    // Clicking "编辑原文" shows ONLY editor view (no stacked VerticalResizable + result-panel)
    fireEvent.click(screen.getByRole('button', { name: 'essay_grading:input_summary.edit' }));
    expect(screen.getByTestId('essay-mobile-edit-view')).toBeInTheDocument();
    expect(screen.getByTestId('input-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('result-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stack')).not.toBeInTheDocument();

    // Collapsing returns cleanly to the score report
    fireEvent.click(screen.getByRole('button', { name: 'collapse essay' }));
    expect(screen.getByTestId('result-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('input-panel')).not.toBeInTheDocument();
  });
});
